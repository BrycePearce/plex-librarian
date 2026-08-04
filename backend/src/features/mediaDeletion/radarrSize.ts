const UINT32_MODULUS = 2 ** 32;

export function plexProjectedKilobytes(rawBytes: unknown): number | null {
  if (typeof rawBytes !== 'number') return null;
  const bytes = rawBytes;
  if (!Number.isSafeInteger(bytes)) return null;
  const normalized = bytes < 0 ? bytes + UINT32_MODULUS : bytes;
  if (normalized < 0 || !Number.isSafeInteger(normalized)) return null;
  const projected = Math.round(normalized / 1000);
  return Number.isSafeInteger(projected) && projected >= 0 ? projected : null;
}

export function radarrBytesMatchProjectedKilobytes(
  radarrBytes: unknown,
  projectedKilobytes: unknown,
): boolean {
  if (typeof radarrBytes !== 'number' || typeof projectedKilobytes !== 'number') return false;
  const bytes = radarrBytes;
  const projected = projectedKilobytes;
  if (
    !Number.isSafeInteger(bytes) || bytes < 0 ||
    !Number.isSafeInteger(projected) || projected < 0
  ) return false;
  return Math.round(bytes / 1000) === projected ||
    Math.round((bytes % UINT32_MODULUS) / 1000) === projected;
}
