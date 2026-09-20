/** Explicit proof that the exact unlink was never issued. Unknown filesystem
 * errors after issuing unlink cannot be downgraded to definite failure. */
export class HistoricalUnlinkNotAttempted extends Error {
  constructor(readonly outcome: 'changed' | 'skipped', message: string) {
    super(message);
  }
}
