const DAY_SECONDS = 86_400;

export function formatQuickCleanupLibraryShare(recommended: number, libraryTotal: number): string {
  if (libraryTotal <= 0) return "—";
  const percentage = Math.min(100, recommended / libraryTotal * 100);
  return percentage >= 10 ? `${Math.round(percentage)}%` : `${percentage.toFixed(1)}%`;
}

export function formatQuickCleanupInactivity(
  inactiveSince: number,
  now = Math.floor(Date.now() / 1000),
): string {
  const days = Math.max(0, Math.floor((now - inactiveSince) / DAY_SECONDS));
  if (days < 30) return `${days}d inactive`;

  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo inactive`;

  const years = Math.floor(days / 365);
  const remainingMonths = Math.floor((days % 365) / 30);
  return remainingMonths > 0 ? `${years}y ${remainingMonths}mo inactive` : `${years}y inactive`;
}
