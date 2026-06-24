export function formatKilobytes(kb: number): string {
  if (kb >= 1e9) return `${(kb / 1e9).toFixed(1)} TB`
  if (kb >= 1e6) return `${(kb / 1e6).toFixed(1)} GB`
  if (kb >= 1e3) return `${(kb / 1e3).toFixed(0)} MB`
  return `${kb.toFixed(0)} KB`
}

export function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatRelativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
