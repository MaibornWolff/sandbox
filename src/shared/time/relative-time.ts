/**
 * Formats a Unix timestamp as a relative time string.
 * @param timestamp - Unix timestamp in milliseconds
 * @param referenceTime - Explicit current time in milliseconds
 * @returns Relative time string (e.g., "5s ago", "3m ago", "2h ago", "1d ago")
 */
export function formatRelativeTime(
  timestamp: number,
  referenceTime: number,
): string {
  const diffSeconds = Math.floor((referenceTime - timestamp) / 1000);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  if (diffSeconds < 3600) {
    const minutes = Math.floor(diffSeconds / 60);
    return `${minutes}m ago`;
  }

  if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    return `${hours}h ago`;
  }

  const days = Math.floor(diffSeconds / 86400);
  return `${days}d ago`;
}
