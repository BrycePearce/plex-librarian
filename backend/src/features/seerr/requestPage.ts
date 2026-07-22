import type { SeerrRequestRecord } from '../../integrations/seerr/client.ts';

function epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export class RequestPageCoverage {
  private expectedCount: number | null = null;
  private receivedCount = 0;
  private leadingRequestId: number | null = null;

  get expected(): number {
    if (this.expectedCount === null) throw new Error('No Seerr request page was accepted');
    return this.expectedCount;
  }

  accept(records: SeerrRequestRecord[], reportedCount: unknown, skip: number): boolean {
    const count = nonNegativeInteger(reportedCount);
    if (count === null) {
      throw new Error(`Seerr did not return a valid request count at offset ${skip}`);
    }
    if (this.expectedCount === null) {
      this.expectedCount = count;
      this.leadingRequestId = records.length > 0 ? positiveInteger(records[0].id) : null;
    } else if (count !== this.expectedCount) {
      throw new Error(
        `Seerr request count changed during sync (${this.expectedCount} to ${count})`,
      );
    }

    this.receivedCount += records.length;
    if (this.receivedCount > count || (records.length === 0 && this.receivedCount < count)) {
      throw new Error(
        `Seerr request sync was incomplete: received ${this.receivedCount} of ${count}`,
      );
    }
    return this.receivedCount === count;
  }

  verifyStableBoundary(records: SeerrRequestRecord[], reportedCount: unknown): void {
    const count = nonNegativeInteger(reportedCount);
    if (count === null || count !== this.expected) {
      throw new Error(
        `Seerr request count changed during sync (${this.expected} to ${count ?? 'invalid'})`,
      );
    }
    const currentLeadingRequestId = records.length > 0 ? positiveInteger(records[0].id) : null;
    if (currentLeadingRequestId !== this.leadingRequestId) {
      throw new Error('Seerr request ordering changed during sync');
    }
  }
}

export function validateRequestPageRecords(
  records: SeerrRequestRecord[],
  skip: number,
): SeerrRequestRecord[] {
  const valid = records.filter((record) =>
    record !== null && typeof record === 'object' && positiveInteger(record.id) !== null &&
    positiveInteger(record.status) !== null && epoch(record.createdAt) !== null &&
    record.media !== null && typeof record.media === 'object'
  );
  if (valid.length !== records.length) {
    throw new Error(
      `Seerr returned ${
        records.length - valid.length
      } malformed request record(s) at offset ${skip}`,
    );
  }
  return valid;
}
