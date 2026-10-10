import { Hono } from 'hono';
import { withTransaction } from '../../db/index.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { configuration, execute, rows } from './store.ts';
import { findingPredicate } from './query.ts';
import {
  type MissingContentResponse,
  missingFindingLabels,
} from '../../../../shared/missingContent.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
router.get('/', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({
      rows: [],
      total: 0,
      scopes: [],
      instances: [],
      libraries: [],
      setup: { plexConnected: false, unmappedInstances: [], fileComparisonUnavailable: [] },
    });
  }
  const type = c.req.query('type') ?? '';
  const instance = Number(c.req.query('instance') || 0);
  const library = c.req.query('library') ?? '';
  const offset = Number(c.req.query('offset') || 0);
  if (
    type && !Object.hasOwn(missingFindingLabels, type) || !Number.isSafeInteger(instance) ||
    instance < 0 ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000
  ) return c.json({ error: 'Invalid filters' }, 400);
  return c.json(withTransaction((db): MissingContentResponse => {
    const config = configuration(db, serverId);
    const { where, args } = findingPredicate(db, serverId, {
      type,
      instance,
      library,
      includeDismissed: c.req.query('dismissed') === 'true',
      hideSetupLimitations: true,
    });
    const total = rows<{ n: number }>(
      db,
      `SELECT count(*) n FROM missing_findings f WHERE ${where}`,
      ...args,
    )[0].n;
    const findings = rows<
      {
        instanceId: number;
        libraryKey: string;
        movieId: number;
        type: keyof typeof missingFindingLabels;
        title: string;
        firstSeen: number;
        lastSeen: number;
        evidence: string;
        dismissed: number;
        status: string;
        fingerprint: string;
        completedAt: number | null;
      }
    >(
      db,
      `SELECT f.instance_id instanceId,f.library_key libraryKey,f.movie_id movieId,f.type,f.title,f.first_seen firstSeen,f.last_seen lastSeen,f.evidence,f.dismissed,s.status,s.fingerprint,s.completed_at completedAt FROM missing_findings f LEFT JOIN missing_audit_scopes s ON s.server_id=f.server_id AND s.instance_id=f.instance_id AND s.library_key=f.library_key WHERE ${where} ORDER BY f.title,f.instance_id,f.library_key,f.movie_id LIMIT 50 OFFSET ?`,
      ...args,
      offset,
    );
    const savedScopes = rows<
      {
        instanceId: number;
        libraryKey: string;
        status: string;
        attemptedAt: number | null;
        completedAt: number | null;
        reason: string | null;
        fingerprint: string;
      }
    >(
      db,
      'SELECT instance_id instanceId,library_key libraryKey,status,attempted_at attemptedAt,completed_at completedAt,reason,fingerprint FROM missing_audit_scopes WHERE server_id=?',
      serverId,
    );
    const scopes = savedScopes.map((s) => ({
      ...s,
      status: s.fingerprint === config.fingerprint ? s.status : 'incomplete',
      reason: s.fingerprint === config.fingerprint
        ? s.reason
        : 'Configuration changed; run a complete sync.',
    }));
    for (const m of config.mappings) {
      if (!scopes.some((s) => s.instanceId === m.instance_id && s.libraryKey === m.library_key)) {
        scopes.push({
          instanceId: m.instance_id,
          libraryKey: m.library_key,
          status: 'incomplete',
          attemptedAt: null,
          completedAt: null,
          reason: 'Not audited yet.',
          fingerprint: '',
        });
      }
    }
    for (const i of config.instances) {
      if (!config.mappings.some((m) => m.instance_id === i.id)) {
        scopes.push({
          instanceId: i.id,
          libraryKey: '',
          status: 'incomplete',
          attemptedAt: null,
          completedAt: null,
          reason: 'No Plex movie library mapped.',
          fingerprint: '',
        });
      }
    }
    return {
      rows: findings.map((
        { evidence, status, fingerprint, completedAt: _completedAt, dismissed, ...f },
      ) => ({
        ...f,
        evidence: JSON.parse(evidence),
        dismissed: !!dismissed,
        stale: status !== 'complete' || fingerprint !== config.fingerprint,
      })),
      total,
      setup: {
        plexConnected: !!config.server,
        unmappedInstances: config.instances.filter((i) =>
          !config.mappings.some((m) => m.instance_id === i.id)
        ).map(({ id, name }) => ({ id, name })),
        fileComparisonUnavailable: config.mappings.filter((m) =>
          !config.arrRoots.some((r) => r.instance_id === m.instance_id) ||
          !config.plexRoots.some((r) => r.library_key === m.library_key) ||
          rows(
              db,
              `SELECT 1 FROM missing_findings WHERE server_id=? AND instance_id=? AND library_key=? AND resolved_at IS NULL AND type='version' AND json_extract(evidence,'$.comparablePath') IS NULL LIMIT 1`,
              serverId,
              m.instance_id,
              m.library_key,
            ).length > 0
        ).map((m) => ({ instanceId: m.instance_id, libraryKey: m.library_key })),
      },
      scopes: scopes.map(({ fingerprint: _fingerprint, ...s }) => s),
      instances: config.instances.map(({ id, name }) => ({ id, name })),
      libraries: rows(
        db,
        "SELECT key,title FROM libraries WHERE server_id=? AND type='movie' ORDER BY title",
        serverId,
      ),
    };
  }));
});
router.post('/dismiss', async (c) => {
  const serverId = c.get('activeServerId');
  const body = await c.req.json().catch(() => null);
  if (
    serverId === null || !body || !Number.isSafeInteger(body.instanceId) ||
    !Number.isSafeInteger(body.movieId) || typeof body.libraryKey !== 'string' ||
    typeof body.dismissed !== 'boolean'
  ) return c.json({ error: 'Invalid dismissal' }, 400);
  withTransaction((db) =>
    execute(
      db,
      'UPDATE missing_findings SET dismissed=? WHERE server_id=? AND instance_id=? AND library_key=? AND movie_id=?',
      Number(body.dismissed),
      serverId,
      body.instanceId,
      body.libraryKey,
      body.movieId,
    )
  );
  return c.json({ ok: true });
});
// Saved service links only. Opening results never performs provider lookups.
router.get('/open/:instance/:library/:movie', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.notFound();
  const target = withTransaction((db) =>
    rows<{ url: string; evidence: string }>(
      db,
      'SELECT a.url,f.evidence FROM missing_findings f JOIN arr_instances a ON a.id=f.instance_id AND a.server_id=f.server_id WHERE f.server_id=? AND f.instance_id=? AND f.library_key=? AND f.movie_id=?',
      serverId,
      Number(c.req.param('instance')),
      c.req.param('library'),
      Number(c.req.param('movie')),
    )[0]
  );
  if (!target) return c.notFound();
  const slug = JSON.parse(target.evidence).movie.slug;
  const url = new URL(target.url);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!['http:', 'https:'].includes(url.protocol)) return c.notFound();
  return c.redirect(`${url.toString().replace(/\/+$/, '')}/movie/${encodeURIComponent(slug)}`);
});
router.get('/plex/:ratingKey', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.notFound();
  const server = withTransaction((db) =>
    rows<{ machine_identifier: string }>(
      db,
      'SELECT machine_identifier FROM servers WHERE id=?',
      serverId,
    )[0]
  );
  if (!server) return c.notFound();
  return c.redirect(
    `https://app.plex.tv/desktop/#!/server/${
      encodeURIComponent(server.machine_identifier)
    }/details?key=${encodeURIComponent('/library/metadata/' + c.req.param('ratingKey'))}`,
  );
});
export default router;
