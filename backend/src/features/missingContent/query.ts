import type { BindValue } from '@db/sqlite';
import type { SqliteClient } from '../../db/index.ts';
import { rows } from './store.ts';

export interface FindingFilters {
  type: string;
  instance: number;
  library: string;
  includeDismissed: boolean;
  hideSetupLimitations?: boolean;
}

/** Equality constraints let SQLite choose the filtered or title-ordered index. */
export function findingPredicate(db: SqliteClient, serverId: number, filters: FindingFilters) {
  const conditions = ['f.server_id=?', 'f.resolved_at IS NULL'];
  const args: BindValue[] = [serverId];
  if (filters.hideSetupLimitations) {
    // An identity match without a comparable path is a setup limitation, not a
    // per-movie discrepancy. Apply before COUNT/LIMIT so pagination stays accurate.
    conditions.push(
      "(f.type<>'version' OR json_extract(f.evidence,'$.comparablePath') IS NOT NULL)",
    );
  }
  if (filters.type) {
    conditions.push('f.type=?');
    args.push(filters.type);
  }
  if (filters.instance) {
    conditions.push('f.instance_id=?');
    args.push(filters.instance);
  }
  if (filters.library) {
    conditions.push('f.library_key=?');
    args.push(filters.library);
  }
  if (!filters.includeDismissed) {
    conditions.push('f.dismissed=0');
    // Avoid reading/parsing evidence when this server has no exclusions. Both
    // this lookup and its consumers run in the route's same read transaction.
    if (rows(db, 'SELECT 1 FROM ignored_content WHERE server_id=? LIMIT 1', serverId).length) {
      // CROSS JOIN intentionally fixes loop order: inspect each small matches
      // array once, then use the ignored-content composite key. The reverse
      // plan reparses every finding once for *each* ignored library item.
      conditions.push(`NOT EXISTS(SELECT 1 FROM json_each(f.evidence,'$.matches') m
        CROSS JOIN ignored_content i
        WHERE i.server_id=f.server_id AND i.rating_key=json_extract(m.value,'$.ratingKey'))`);
    }
  }
  return { where: conditions.join(' AND '), args };
}
