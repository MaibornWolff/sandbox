import { describe, expect, test } from "bun:test";
import { aggregateLogEntries } from "./log-entry-aggregation.js";

describe("aggregateLogEntries", () => {
  test("groups items by key and sums count", () => {
    const items = [
      { name: "a", count: 1, lastSeen: 100 },
      { name: "a", count: 1, lastSeen: 200 },
      { name: "b", count: 1, lastSeen: 150 },
    ];

    const result = aggregateLogEntries(items, (i) => i.name);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === "a")).toEqual({
      name: "a",
      count: 2,
      lastSeen: 200,
    });
    expect(result.find((r) => r.name === "b")).toEqual({
      name: "b",
      count: 1,
      lastSeen: 150,
    });
  });

  test("returns empty array for empty input", () => {
    const result = aggregateLogEntries(
      [] as { count: number; lastSeen: number }[],
      (i) => String(i.count),
    );
    expect(result).toEqual([]);
  });

  test("keeps max lastSeen across entries", () => {
    const items = [
      { key: "x", count: 1, lastSeen: 500 },
      { key: "x", count: 1, lastSeen: 100 },
      { key: "x", count: 1, lastSeen: 300 },
    ];

    const result = aggregateLogEntries(items, (i) => i.key);

    expect(result).toHaveLength(1);
    expect(result[0]?.lastSeen).toBe(500);
    expect(result[0]?.count).toBe(3);
  });

  test("preserves extra fields from first item", () => {
    const items = [
      { id: "first", extra: "kept", count: 1, lastSeen: 100 },
      { id: "first", extra: "dropped", count: 1, lastSeen: 200 },
    ];

    const result = aggregateLogEntries(items, (i) => i.id);

    expect(result).toHaveLength(1);
    expect(result[0]?.extra).toBe("kept");
  });
});
