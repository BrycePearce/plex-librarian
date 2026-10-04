/** Bounded derived-read cache; all database writes conservatively invalidate it. */
export class LibraryStatsCache<T> {
  private readonly entries = new Map<
    string,
    { revision: string; expiresAt: number; result: Promise<T> }
  >();

  constructor(
    private readonly revision: () => string,
    private readonly now = Date.now,
    private readonly capacity = 64,
    private readonly ttlMs = 30_000,
  ) {}

  get(serverId: number, libraryKeys: string[], load: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([serverId, [...libraryKeys].sort()]);
    const revision = this.revision();
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.revision === revision && existing.expiresAt > now) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.result;
    }
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    // Capture the revision before loading: writes while a read is pending cannot
    // make that result appear fresh for the newer database state.
    const result = Promise.resolve().then(load);
    const entry = { revision, expiresAt: now + this.ttlMs, result };
    this.entries.set(key, entry);
    void result.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return result;
  }
}
