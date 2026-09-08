/**
 * Parse a syslog-style timestamp (e.g., "Feb 16 14:11:39") to ms since epoch.
 * Uses the reference time's year since these logs don't include the year.
 * Returns the reference time if parsing fails.
 */
function parseLogTimestamp(
  timestampStr: string,
  referenceTime: number,
): number {
  const year = new Date(referenceTime).getUTCFullYear();
  const parsed = new Date(`${timestampStr} ${year} UTC`).getTime();
  return Number.isNaN(parsed) ? referenceTime : parsed;
}

/**
 * Extract and parse a syslog-style timestamp from a log line using the given regex.
 * The regex must have a capture group for the "Mon DD HH:MM:SS" portion.
 * Returns the reference time if no match or parsing fails.
 */
export function extractLogTimestamp(
  line: string,
  pattern: RegExp,
  referenceTime: number,
): number {
  const match = line.match(pattern);
  if (!match?.[1]) return referenceTime;
  return parseLogTimestamp(match[1], referenceTime);
}
