import { describe, expect, test } from "bun:test";
import { formatConfigReference } from "./config-reference.js";
import { tomlConfigSchema } from "./toml-config-schema.js";

describe("formatConfigReference", () => {
  test("text format produces non-empty output", () => {
    const output = formatConfigReference("text");
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("Sandbox Configuration Schema");
    expect(output).toContain("[override]");
    expect(output).toContain("[accumulate]");
  });

  test("markdown format produces non-empty output", () => {
    const output = formatConfigReference("markdown");
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("# Sandbox Configuration Schema");
    expect(output).toContain("**accumulate**");
    expect(output).toContain("**override**");
  });

  test("text format includes all field names", () => {
    const output = formatConfigReference("text");
    const schemaKeys = Object.keys(tomlConfigSchema.shape);
    for (const key of schemaKeys) {
      expect(output).toContain(key);
    }
    expect(output).toContain("allow_host_commands");
    expect(output).toContain("[[allow_host_commands]]");
    expect(output).toContain('pattern = ["git", ["status", "diff", "log"]]');
    expect(output).toContain('test_match = [["git", "status"]]');
    expect(output).toContain("runtimes.apple-container");
    expect(output).toContain('"dns":"default"');
  });
});
