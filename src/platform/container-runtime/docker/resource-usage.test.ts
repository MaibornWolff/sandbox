import { describe, expect, test } from "bun:test";
import { buildStatsArgs, parseResourceUsage } from "./resource-usage.js";

describe("container resource usage parsing", () => {
  test("requests one JSON sample per container", () => {
    expect(buildStatsArgs("container-1")).toEqual([
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      "container-1",
    ]);
  });

  test("parses Docker binary units", () => {
    const output = `${JSON.stringify({
      CPUPerc: "61.20%",
      MemUsage: "281.2MiB / 15.6GiB",
      MemPerc: "1.76%",
      PIDs: "28",
    })}\n`;
    expect(parseResourceUsage(output, "container-1")).toEqual({
      cpuPercent: 61.2,
      memoryUsageBytes: Math.round(281.2 * 1_024 ** 2),
      memoryLimitBytes: Math.round(15.6 * 1_024 ** 3),
      processCount: 28,
    });
  });

  test("parses Podman decimal units and an absent limit", () => {
    const output = JSON.stringify({
      CPUPerc: "1.58%",
      MemUsage: "129.7MB / 0B",
      PIDs: "11",
    });
    expect(parseResourceUsage(output, "container-1")).toEqual({
      cpuPercent: 1.58,
      memoryUsageBytes: Math.round(129.7 * 1_000 ** 2),
      memoryLimitBytes: null,
      processCount: 11,
    });
  });

  test("returns null for empty output and throws for malformed output", () => {
    expect(parseResourceUsage("\n", "container-1")).toBeNull();
    expect(() => parseResourceUsage("not json", "container-1")).toThrow(
      "Container statistics for container-1 returned invalid JSON.",
    );
    expect(() =>
      parseResourceUsage(JSON.stringify({ CPUPerc: "1%" }), "container-1"),
    ).toThrow("Container statistics for container-1 returned invalid data.");
    expect(() =>
      parseResourceUsage(
        JSON.stringify({ CPUPerc: "1%", MemUsage: "lots", PIDs: "3" }),
        "container-1",
      ),
    ).toThrow("Container statistics for container-1 returned invalid data.");
  });
});
