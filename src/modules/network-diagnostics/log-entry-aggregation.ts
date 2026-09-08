interface AggregatableLogEntry {
  count: number;
  lastSeen: number;
}

/**
 * Aggregate log entries by key, summing count and keeping max lastSeen.
 * First item for each key is used as the base (spread).
 */
export function aggregateLogEntries<T extends AggregatableLogEntry>(
  items: T[],
  keyFn: (item: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) {
      existing.count += item.count;
      existing.lastSeen = Math.max(existing.lastSeen, item.lastSeen);
    } else {
      map.set(key, { ...item });
    }
  }
  return [...map.values()];
}
