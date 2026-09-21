import { withTransaction } from '../../../db/index.ts';
import { HistoricalUnlinkNotAttempted } from '../../mediaDeletion/historicalDownloadErrors.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import { activeServerMatches } from '../core/coordination.ts';
import { resolveActiveServer } from '../../../integrations/plex/index.ts';
import { HistoricalDownloadCheckpoint } from '../../mediaDeletion/historicalDownloadCheckpoint.ts';
import {
  type AcceptedHistoricalDownload,
  collectHistoricalDownloads,
  historicalConnectionRevision,
  type HistoricalHistoryCache,
  historicalJobClaims,
  historicalOwnerContexts,
} from '../../mediaDeletion/historicalDownloadPlanning.ts';
import { historicalAppDataRoot, listHistoricalAccess } from '../../arr/historicalDownloadAccess.ts';
import {
  historicalRootUnchanged,
  unlinkHistoricalFile,
} from '../../mediaDeletion/historicalDownloadIdentity.ts';
import { lstatChain } from '../../mediaDeletion/pathNamespace.ts';
import {
  type HistoricalDownloadAttempt,
  runHistoricalDownloadAttempt,
} from './historicalDownloadJournal.ts';
import { activeWholeItemRatingKeys } from '../../mediaDeletion/activePlayback.ts';
import type { DurableTargetSnapshot } from '../core/validation.ts';
import { historicalSelectedFilesUnchanged } from '../../mediaDeletion/historicalDownloadLineage.ts';
import { serviceOwnedFingerprint } from '../../mediaDeletion/serviceOwnedPlanning.ts';

export async function ensureHistoricalDownloadPhase(
  target: DeletionWorkTarget,
  runtime?: {
    resolveActiveServer: typeof resolveActiveServer;
    prepare: typeof import('../serviceOwnedRoute.ts').prepare;
  },
) {
  const rows = withTransaction((db) =>
    db.prepare(
      "SELECT id,evidence,entry FROM historical_download_journal WHERE operation_id=? AND status IN ('pending','intent') ORDER BY id",
    ).values<[string, string, string]>(target.operationId)
  );
  if (!rows.length) return;
  const snapshots = withTransaction((db) =>
    db.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id=? ORDER BY ordinal')
      .values<[string]>(target.operationId)
  )
    .map(([s]) => JSON.parse(s) as DurableTargetSnapshot);
  const plans = snapshots.map((s) => s.serviceOwnedPlan!);
  const hasPriorServiceAttempt = snapshots.some((s) =>
    Object.keys(s.serviceOwnedAttempts ?? {}).length > 0
  );
  const cancelled = () =>
    withTransaction((db) =>
      !!db.prepare(
        "SELECT 1 FROM deletion_targets WHERE operation_id=? AND status='cancelled' LIMIT 1",
      ).value(target.operationId)
    );
  const historyCache: HistoricalHistoryCache = new Map();
  const prepareOperation = async () => {
    const active = await (runtime?.resolveActiveServer ?? resolveActiveServer)();
    if (active.serverId !== target.serverId) throw new Error('Active server changed');
    const prepare = runtime?.prepare ?? (await import('../serviceOwnedRoute.ts')).prepare;
    const first = plans[0];
    // One execution-time selection/retained-owner inventory for this optional
    // phase. Services have not mutated yet; per-file owners are checked below.
    const prepared = await prepare({
      libraryKey: first.libraryKey,
      arrSelected: first.arrSelected,
      qbSelected: first.qbSelected,
      targets: plans.map((p) => ({
        ratingKey: p.selection.ratingKey,
        ...(p.selection.mediaId === undefined ? {} : { mediaId: p.selection.mediaId }),
      })),
    }, active);
    const checked = await collectHistoricalDownloads(
      target.serverId,
      prepared.plans,
      prepared.arrTargets,
      prepared.downloadTargets,
      new Map(),
      true,
      historyCache,
    );
    const keys = new Set(plans.flatMap((p) => [
      p.selection.ratingKey,
      ...(p.selection.showRatingKey ? [p.selection.showRatingKey] : []),
    ]));
    return {
      active,
      prepared,
      checked,
      keys,
      acceptedIds: new Set(checked.accepted.map((c) => c.id)),
    };
  };
  // Lazy so cancelled, corrupt or interrupted entries never initiate inventory.
  let preparation: ReturnType<typeof prepareOperation> | undefined;
  const operation = () => preparation ??= prepareOperation();
  const checkpoint = new HistoricalDownloadCheckpoint(async () => {
    const { prepared, checked } = await operation();
    const claims = await historicalJobClaims(
      checked.accepted,
      prepared.downloadTargets,
      listHistoricalAccess(target.serverId),
      prepared.arrTargets,
    );
    return claims;
  });
  for (const [id, evidence, entry] of rows) {
    const store = historicalDownloadJournalStore(id, entry);
    try {
      const accepted = JSON.parse(evidence) as AcceptedHistoricalDownload;
      if (accepted?.version !== 1 || accepted.filesystem?.entry !== entry) {
        throw new Error('Unsupported or inconsistent optional cleanup evidence');
      }
      const { id: acceptedId, ...acceptedEvidence } = accepted;
      if (acceptedId !== serviceOwnedFingerprint(acceptedEvidence)) {
        throw new Error('Accepted optional cleanup evidence is corrupt');
      }
      const accessUnchanged = () => {
        const access = listHistoricalAccess(target.serverId);
        return historicalOwnerContexts(accepted).every((owner) => {
          const config = access.find((s) => s.id === owner.accessId);
          return config?.configuration.enabled && config.revision === owner.accessRevision;
        });
      };
      await runHistoricalDownloadAttempt(store, id, {
        cancelled,
        validate: async () => {
          if (accepted.filesystem.version !== 2) {
            throw new Error('Older filesystem evidence requires a fresh preview and consent');
          }
          const reserved = withTransaction((db) =>
            db.prepare(
              'SELECT 1 FROM historical_download_reservations WHERE entry=? AND journal_id=?',
            )
              .value(accepted.filesystem.entry, id)
          );
          if (!reserved) return 'skipped';
          if (
            accepted.version !== 1 || hasPriorServiceAttempt ||
            snapshots.some((s) => s.upgradeHold !== undefined)
          ) return 'skipped';
          const { active, prepared, checked, keys, acceptedIds } = await operation();
          if (
            historicalConnectionRevision(prepared.arrTargets, prepared.downloadTargets) !==
              accepted.connectionRevision
          ) return 'changed';
          if (!accessUnchanged()) {
            return 'changed';
          }
          if (!acceptedIds.has(accepted.id)) {
            if (!await historicalRootUnchanged(accepted.filesystem)) return 'changed';
            try {
              await lstatChain(accepted.filesystem.path);
            } catch (error) {
              if (error instanceof Deno.errors.NotFound) return 'already_absent';
              throw error;
            }
            return 'changed';
          }
          const claims = await checkpoint.fresh();
          if (claims.has(accepted.id)) return 'changed';
          for (const owner of historicalOwnerContexts(accepted)) {
            const latestArr = prepared.arrTargets.find((a) => a.instanceId === owner.instanceId);
            if (
              !latestArr || !await historicalSelectedFilesUnchanged(
                latestArr.client,
                owner.seriesId,
                owner.lineage,
              )
            ) return 'changed';
          }
          if (activeWholeItemRatingKeys(keys, await active.client.activeSessions()).size) {
            return 'skipped';
          }
          if (
            !checkpoint.isFresh() || !accessUnchanged() ||
            !withTransaction((db) => activeServerMatches(db, target.serverId))
          ) return 'skipped';
          // Separate mutable execution evidence preserves the accepted fingerprint.
          // This durable write must succeed before the journal can persist unlink intent.
          withTransaction((db) =>
            db.prepare(
              'UPDATE historical_download_journal SET validation=? WHERE id=?',
            ).run(
              JSON.stringify({
                version: 1,
                ...checkpoint.observation(),
                validatedAt: Date.now(),
                connectionRevision: accepted.connectionRevision,
                checkpointFingerprint: serviceOwnedFingerprint([
                  checked.preview.fingerprint,
                  [...claims].sort(),
                ]),
                acceptedCandidateId: accepted.id,
              }),
              id,
            )
          );
          return 'ready';
        },
        unlink: async () => {
          if (cancelled() || !withTransaction((db) => activeServerMatches(db, target.serverId))) {
            throw new HistoricalUnlinkNotAttempted(
              'skipped',
              'Cancelled or active server changed before unlink',
            );
          }
          await unlinkHistoricalFile(accepted.filesystem, historicalAppDataRoot(), () => {
            if (
              !checkpoint.isFresh() || !accessUnchanged() || cancelled() ||
              !withTransaction((db) => activeServerMatches(db, target.serverId))
            ) {
              throw new HistoricalUnlinkNotAttempted(
                'skipped',
                'Ownership batch unavailable or scope changed during final inspection',
              );
            }
          });
        },
      });
    } catch {
      // A failed completion write retains intent. Persist uncertainty before services
      // continue; if this write also fails the worker must stop with the DB failure.
      const state = store.get();
      store.save({
        ...state,
        status: state.status === 'intent' ? 'uncertain' : 'skipped',
        reason: 'Optional cleanup could not finish; it will not be replayed',
      });
    } finally {
      // Skipped and changed candidates advance the shared job-inventory batch too.
      checkpoint.evaluated();
    }
  }
}

/** The production journal adapter, also exercised against disposable SQLite. */
export function historicalDownloadJournalStore(id: string, entry: string) {
  return {
    get: (): HistoricalDownloadAttempt =>
      withTransaction((db) => {
        const row = db.prepare('SELECT status,reason FROM historical_download_journal WHERE id=?')
          .value<[HistoricalDownloadAttempt['status'], string | null]>(id)!;
        return {
          version: 1,
          id,
          entry,
          status: row[0],
          reason: row[1] ?? undefined,
        };
      }),
    save: (attempt: HistoricalDownloadAttempt) =>
      withTransaction((db) => {
        const now = Date.now();
        db.prepare(
          "UPDATE historical_download_journal SET status=?,reason=?,intent_at=CASE WHEN ?='intent' THEN ? ELSE intent_at END,finished_at=CASE WHEN ? NOT IN ('pending','intent') THEN ? ELSE finished_at END WHERE id=?",
        )
          .run(
            attempt.status,
            attempt.reason ?? null,
            attempt.status,
            now,
            attempt.status,
            now,
            id,
          );
        if (!['pending', 'intent', 'uncertain'].includes(attempt.status)) {
          db.prepare('DELETE FROM historical_download_reservations WHERE journal_id=?').run(id);
        }
      }),
  };
}
