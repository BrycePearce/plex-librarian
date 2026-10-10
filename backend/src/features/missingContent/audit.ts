import { createSyncYield } from '../sync/cooperativeYield.ts';
import { withTransaction } from '../../db/index.ts';
import type { PlexClient, PlexRawMetadata } from '../../integrations/plex/index.ts';
import {
  classify,
  type MatchEvidence,
  type MovieEvidence,
  providerIds,
  trustedPath,
} from './model.ts';
import { readInventory } from './inventory.ts';
import { clearStage, configuration, execute, type Mapping, rows } from './store.ts';

export interface AuditSink {
  page(libraryKey: string, raw: PlexRawMetadata[] | undefined): void;
  complete(libraryKey: string): void;
}
export async function withMissingAudit<T>(
  plex: PlexClient,
  serverId: number,
  syncId: number,
  libraryKey: string | null,
  signal: AbortSignal,
  task: (sink: AuditSink) => Promise<T>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const config = withTransaction((db) => configuration(db, serverId));
  const scopes = config.mappings.filter((m) => libraryKey === null || m.library_key === libraryKey);
  const now = Math.floor(Date.now() / 1000);
  const complete = new Set<string>();
  const invalid = new Set<string>();
  let identityOK = false;
  const stillCurrent = () =>
    withTransaction((db) =>
      !signal.aborted &&
      rows(
          db,
          "SELECT 1 FROM sync_log WHERE id=? AND server_id=? AND status='pending'",
          syncId,
          serverId,
        ).length === 1 &&
      rows(db, 'SELECT 1 FROM settings WHERE id=1 AND active_server_id=?', serverId).length === 1 &&
      configuration(db, serverId).fingerprint === config.fingerprint
    );
  withTransaction((db) => {
    // Crash leftovers are never publication candidates. Do not touch another active run.
    for (const table of ['plex', 'keys', 'movies', 'queue', 'findings']) {
      execute(
        db,
        `DELETE FROM missing_stage_${table} WHERE sync_id NOT IN (SELECT id FROM sync_log WHERE status='pending')`,
      );
    }
    execute(
      db,
      'DELETE FROM missing_findings WHERE resolved_at IS NOT NULL AND resolved_at<?',
      now - 30 * 86400,
    );
    for (const scope of scopes) {
      execute(
        db,
        `INSERT INTO missing_audit_scopes(server_id,instance_id,library_key,sync_id,fingerprint,attempted_at,status,reason) VALUES(?,?,?,?,?,?,'incomplete','Audit in progress or interrupted')
      ON CONFLICT(server_id,instance_id,library_key) DO UPDATE SET sync_id=excluded.sync_id,fingerprint=excluded.fingerprint,attempted_at=excluded.attempted_at,status=excluded.status,reason=excluded.reason`,
        serverId,
        scope.instance_id,
        scope.library_key,
        syncId,
        config.fingerprint,
        now,
      );
    }
  });
  if (scopes.length) {
    try {
      identityOK = (await plex.identity()) === config.server?.machine_identifier;
    } catch { /* Keep saved findings stale. */ }
  }
  const sink: AuditSink = {
    page(key, raw) {
      if (!identityOK || !scopes.some((s) => s.library_key === key) || signal.aborted) return;
      if (!raw) {
        invalid.add(key);
        return;
      }
      try {
        withTransaction((db) => {
          for (const item of raw) {
            if (
              item.type !== 'movie' || typeof item.ratingKey !== 'string' || !item.ratingKey ||
              typeof item.title !== 'string' ||
              (item.librarySectionID !== undefined && String(item.librarySectionID) !== key)
            ) {
              throw new Error('Unexpected movie inventory');
            }
            const ids = providerIds(item);
            const parts = (item.Media ?? []).flatMap((m) => m.Part ?? []);
            const paths = parts.flatMap((p) => typeof p.file === 'string' ? [p.file] : []);
            const roots = config.plexRoots.filter((r) => r.library_key === key);
            const translated = paths.map((p) => trustedPath(p, roots));
            const evidence: MatchEvidence = {
              ratingKey: item.ratingKey,
              title: item.title,
              ...ids,
              paths: paths.slice(0, 30),
              exact: false,
            };
            const completePaths = paths.length > 0 && paths.length === parts.length &&
              translated.every(Boolean);
            execute(
              db,
              'INSERT INTO missing_stage_plex VALUES(?,?,?,?,?)',
              syncId,
              key,
              item.ratingKey,
              JSON.stringify(evidence),
              Number(completePaths),
            );
            for (
              const [kind, values] of Object.entries({
                ...ids,
                path: translated.filter((p): p is string => p !== null),
              })
            ) {
              for (const value of values) {
                execute(
                  db,
                  'INSERT OR IGNORE INTO missing_stage_keys VALUES(?,?,?,?,?)',
                  syncId,
                  key,
                  kind,
                  value,
                  item.ratingKey,
                );
              }
            }
          }
        });
      } catch {
        invalid.add(key);
      }
    },
    complete(key) {
      if (!invalid.has(key)) complete.add(key);
    },
  };
  const markFailed = (scope: Mapping, reason: string) =>
    withTransaction((db) => {
      execute(
        db,
        "UPDATE missing_audit_scopes SET status='incomplete',reason=? WHERE server_id=? AND instance_id=? AND library_key=? AND sync_id=?",
        reason,
        serverId,
        scope.instance_id,
        scope.library_key,
        syncId,
      );
    });
  const finish = async () => {
    const yieldIfNeeded = createSyncYield(20);
    try {
      for (const instance of config.instances) {
        const instanceScopes = scopes.filter((s) => s.instance_id === instance.id);
        if (!instanceScopes.length) continue;
        const eligible = instanceScopes.filter((s) => identityOK && complete.has(s.library_key));
        for (const scope of instanceScopes.filter((s) => !eligible.includes(s))) {
          markFailed(
            scope,
            'Plex identity or library coverage incomplete; previous findings retained.',
          );
        }
        if (!eligible.length) continue;
        if (!stillCurrent()) {
          for (const scope of eligible) {
            markFailed(
              scope,
              'Sync cancelled or configuration changed; previous findings retained.',
            );
          }
          continue;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 120_000);
        try {
          let batch: Array<{ movie: MovieEvidence | null; id: number }> = [];
          const flush = () => {
            withTransaction((db) => {
              for (const { movie, id } of batch) {
                execute(
                  db,
                  'INSERT INTO missing_stage_movies VALUES(?,?,?,?)',
                  syncId,
                  instance.id,
                  id,
                  movie ? JSON.stringify(movie) : null,
                );
              }
            });
            batch = [];
          };
          await readInventory(
            instance.url,
            instance.api_key,
            controller.signal,
            async (movie, id) => {
              batch.push({ movie, id });
              if (batch.length >= 100) {
                flush();
                await yieldIfNeeded();
              }
            },
            (id, movieId) =>
              withTransaction((db) =>
                execute(
                  db,
                  'INSERT INTO missing_stage_queue VALUES(?,?,?,?)',
                  syncId,
                  instance.id,
                  id,
                  movieId,
                )
              ),
            fetchImpl,
          );
          flush();
          for (const scope of eligible) {
            const allPaths = withTransaction((db) =>
              rows(
                db,
                'SELECT 1 FROM missing_stage_plex WHERE sync_id=? AND library_key=? AND complete_paths=0 LIMIT 1',
                syncId,
                scope.library_key,
              ).length === 0
            );
            let after = 0;
            while (true) {
              controller.signal.throwIfAborted();
              const batch = withTransaction((db) =>
                rows<{ movie_id: number; evidence: string }>(
                  db,
                  'SELECT movie_id,evidence FROM missing_stage_movies WHERE sync_id=? AND instance_id=? AND movie_id>? AND evidence IS NOT NULL ORDER BY movie_id LIMIT 100',
                  syncId,
                  instance.id,
                  after,
                )
              );
              if (!batch.length) break;
              withTransaction((db) => {
                for (const row of batch) {
                  const movie: MovieEvidence = JSON.parse(row.evidence);
                  const arrPath = trustedPath(
                    movie.path,
                    config.arrRoots.filter((r) => r.instance_id === instance.id),
                  );
                  const path = trustedPath(
                    arrPath,
                    config.plexRoots.filter((r) => r.library_key === scope.library_key).map(
                      (r) => ({
                        source: r.target,
                        target: r.target,
                        caseSensitive: r.caseSensitive,
                      }),
                    ),
                  );
                  // Separate equality probes use the entire composite index. An OR/group
                  // query here can scan the whole library once per managed movie.
                  const byKey = new Map<string, MatchEvidence>();
                  for (
                    const [kind, value] of [['path', path], ['tmdb', movie.tmdb], [
                      'imdb',
                      movie.imdb,
                    ]]
                  ) {
                    if (!value) continue;
                    for (
                      const found of rows<{ evidence: string }>(
                        db,
                        'SELECT p.evidence FROM missing_stage_keys k JOIN missing_stage_plex p USING(sync_id,library_key,rating_key) WHERE k.sync_id=? AND k.library_key=? AND k.kind=? AND k.value=? LIMIT 31',
                        syncId,
                        scope.library_key,
                        kind,
                        value,
                      )
                    ) {
                      const evidence: MatchEvidence = JSON.parse(found.evidence);
                      evidence.exact = kind === 'path' ||
                        byKey.get(evidence.ratingKey)?.exact === true;
                      byKey.set(evidence.ratingKey, evidence);
                    }
                  }
                  const matches = [...byKey.values()];
                  const pending = rows(
                    db,
                    'SELECT 1 FROM missing_stage_queue WHERE sync_id=? AND instance_id=? AND movie_id=? LIMIT 1',
                    syncId,
                    instance.id,
                    movie.id,
                  ).length > 0;
                  const comparable = !!path;
                  const finding = classify(movie, matches, comparable, allPaths, pending, now);
                  if (finding) {
                    execute(
                      db,
                      'INSERT INTO missing_stage_findings VALUES(?,?,?,?,?,?,?)',
                      syncId,
                      instance.id,
                      scope.library_key,
                      movie.id,
                      finding.type,
                      movie.title,
                      JSON.stringify({
                        movie,
                        matches: matches.slice(0, 30),
                        reason: finding.reason,
                        comparablePath: path,
                        pending,
                        auditedAt: now,
                      }),
                    );
                  }
                }
              });
              after = batch[batch.length - 1].movie_id;
              await yieldIfNeeded();
            }
            if (!stillCurrent()) throw new Error('Obsolete audit');
            withTransaction((db) => {
              // Guard against an older run completing after a replacement audit.
              if (
                !rows(
                  db,
                  'SELECT 1 FROM missing_audit_scopes WHERE server_id=? AND instance_id=? AND library_key=? AND sync_id=?',
                  serverId,
                  instance.id,
                  scope.library_key,
                  syncId,
                ).length
              ) return;
              execute(
                db,
                `UPDATE missing_findings SET resolved_at=? WHERE server_id=? AND instance_id=? AND library_key=? AND resolved_at IS NULL AND movie_id NOT IN (SELECT movie_id FROM missing_stage_findings WHERE sync_id=? AND instance_id=? AND library_key=?)`,
                now,
                serverId,
                instance.id,
                scope.library_key,
                syncId,
                instance.id,
                scope.library_key,
              );
              execute(
                db,
                `INSERT INTO missing_findings(server_id,instance_id,library_key,movie_id,type,title,evidence,first_seen,last_seen)
                SELECT ?,instance_id,library_key,movie_id,type,title,evidence,?,? FROM missing_stage_findings WHERE sync_id=? AND instance_id=? AND library_key=?
                ON CONFLICT(server_id,instance_id,library_key,movie_id) DO UPDATE SET type=excluded.type,title=excluded.title,evidence=excluded.evidence,last_seen=excluded.last_seen,resolved_at=NULL,
                dismissed=CASE WHEN missing_findings.resolved_at IS NOT NULL OR missing_findings.type<>excluded.type THEN 0 ELSE missing_findings.dismissed END`,
                serverId,
                now,
                now,
                syncId,
                instance.id,
                scope.library_key,
              );
              execute(
                db,
                "UPDATE missing_audit_scopes SET status='complete',reason=NULL,completed_at=? WHERE server_id=? AND instance_id=? AND library_key=? AND sync_id=?",
                now,
                serverId,
                instance.id,
                scope.library_key,
                syncId,
              );
            });
          }
        } catch {
          for (const scope of eligible) {
            markFailed(
              scope,
              'Radarr read, queue, or audit incomplete; previous findings retained.',
            );
          }
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          controller.abort();
        }
      }
    } finally {
      clearStage(syncId);
    }
  };
  try {
    return await task(sink);
  } finally {
    await finish();
  }
}
