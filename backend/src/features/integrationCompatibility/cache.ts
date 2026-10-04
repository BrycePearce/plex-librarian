import { createHash } from 'node:crypto';
import type { IntegrationCompatibilityCheck } from '@plex-librarian/shared/types.ts';

interface CachedCheck {
  check: IntegrationCompatibilityCheck;
  checkedAt: number;
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  value: Promise<CachedCheck>;
}

/** Presentation checks only; deletion planning/execution must always read services directly. */
export class CompatibilityCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 128,
  ) {}

  get(
    serverId: number,
    connectionKey: string,
    configuration: readonly unknown[],
    probe: () => Promise<IntegrationCompatibilityCheck>,
  ): Promise<CachedCheck> {
    const key = `${serverId}:${connectionKey}`;
    // Credentials participate in invalidation without being retained as map keys.
    const fingerprint = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
    const existing = this.entries.get(key);
    if (existing?.fingerprint === fingerprint && existing.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value;
    }

    const entry: Entry = {
      fingerprint,
      // An in-flight probe is shared even if it takes longer than the eventual TTL.
      expiresAt: Infinity,
      value: Promise.resolve().then(probe).then((check) => {
        const checkedAt = this.now();
        entry.expiresAt = checkedAt + (check.status === 'unreachable' ? 30_000 : 5 * 60_000);
        return { check, checkedAt: Math.floor(checkedAt / 1000) };
      }).catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return entry.value;
  }

  invalidate(serverId: number, connectionKey: string): void {
    this.entries.delete(`${serverId}:${connectionKey}`);
  }
}

export const compatibilityCache = new CompatibilityCache();
