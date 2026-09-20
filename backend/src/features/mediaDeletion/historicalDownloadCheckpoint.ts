/** Shared job inventory for at most ten evaluated files. Slow reads are valid;
 * failed reads make the remaining optional phase unavailable, never absent. */
export class HistoricalDownloadCheckpoint<T> {
  private checkpoint: { value: T; observedAt: number; evaluations: number } | null = null;
  private pending: Promise<T> | null = null;
  private unavailable: Error | null = null;
  constructor(
    private readonly read: () => Promise<T>,
    private readonly wallNow = Date.now,
  ) {}

  invalidate() {
    this.checkpoint = null;
  }

  isFresh(): boolean {
    return this.checkpoint !== null && this.checkpoint.evaluations < 10;
  }

  observation(): { observedAt: number; evaluation: number } | null {
    return this.checkpoint
      ? { observedAt: this.checkpoint.observedAt, evaluation: this.checkpoint.evaluations + 1 }
      : null;
  }

  async fresh(): Promise<T> {
    // This checkpoint belongs to one optional phase. A failed shared inventory
    // makes the rest of that phase unavailable; retrying it for every file turns
    // a slow server into an unbounded series of identical failed preparations.
    if (this.unavailable) throw this.unavailable;
    if (
      this.checkpoint && this.isFresh()
    ) return this.checkpoint.value;
    if (this.pending) return await this.pending;
    this.checkpoint = null;
    const observedAt = this.wallNow();
    this.pending = Promise.resolve().then(async () => {
      try {
        const value = await this.read();
        this.checkpoint = { value, observedAt, evaluations: 0 };
        return value;
      } catch (error) {
        this.unavailable = error instanceof Error ? error : new Error(String(error));
        throw this.unavailable;
      } finally {
        this.pending = null;
      }
    });
    return await this.pending;
  }

  evaluated() {
    if (this.checkpoint) this.checkpoint.evaluations++;
  }
}
