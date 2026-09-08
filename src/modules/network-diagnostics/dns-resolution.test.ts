import { describe, expect, test } from "bun:test";
import { buildReverseLookupMap } from "./dns-resolution.js";

describe("DNS resolution rules", () => {
  test("selects first hostnames and maps empty or failed outcomes to null", () => {
    const result = buildReverseLookupMap(
      ["192.168.1.1", "192.168.1.2", "10.0.0.1"],
      [
        {
          status: "fulfilled",
          value: ["first.example.com", "second.example.com"],
        },
        { status: "fulfilled", value: [] },
        { status: "rejected", reason: new Error("ENOTFOUND") },
      ],
    );

    expect([...result]).toEqual([
      ["192.168.1.1", "first.example.com"],
      ["192.168.1.2", null],
      ["10.0.0.1", null],
    ]);
  });

  test("deduplicates IPs in first-seen order", () => {
    const result = buildReverseLookupMap(
      ["192.168.1.1", "192.168.1.2", "192.168.1.1", "192.168.1.1"],
      [
        { status: "fulfilled", value: ["host1.example.com"] },
        { status: "fulfilled", value: ["host2.example.com"] },
      ],
    );

    expect([...result]).toEqual([
      ["192.168.1.1", "host1.example.com"],
      ["192.168.1.2", "host2.example.com"],
    ]);
    expect(buildReverseLookupMap([], [])).toEqual(new Map());
  });
});
