import type { Context, Next } from 'hono';
import { getActiveServerIdOrNull } from '../integrations/plex/index.ts';

export type ActiveServerVariables = { activeServerId: number | null };

// Resolves the active server once per request and stores it on context, so route
// handlers read c.get('activeServerId') instead of each calling
// getActiveServerIdOrNull() independently.
export async function withActiveServerId(
  c: Context<{ Variables: ActiveServerVariables }>,
  next: Next,
): Promise<void> {
  c.set('activeServerId', await getActiveServerIdOrNull());
  await next();
}
