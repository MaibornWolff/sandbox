import { describe, expect, test } from "bun:test";
import { CONFIG_FIELD_CATALOG } from "./config-field-catalog.js";
import { CONFIG_MERGE_RULES } from "./config-merging.js";
import { formatConfigReference, getConfigFields } from "./config-reference.js";
import { tomlConfigSchema } from "./toml-config-schema.js";

describe("getConfigFields", () => {
  test("returns entries for all fields in tomlConfigSchema", () => {
    const fields = getConfigFields();
    const schemaKeys = Object.keys(tomlConfigSchema.shape);

    expect(fields.length).toBe(schemaKeys.length);

    const fieldNames = fields.map((f) => f.tomlName);
    for (const key of schemaKeys) {
      expect(fieldNames).toContain(key);
    }
  });

  test("every field has a non-empty description", () => {
    const fields = getConfigFields();
    for (const field of fields) {
      expect(field.description.length).toBeGreaterThan(0);
    }
  });

  test("catalog drives schema, merge, defaults, and reference metadata", () => {
    const fields = getConfigFields();

    for (const [tomlName, definition] of Object.entries(CONFIG_FIELD_CATALOG)) {
      const field = fields.find((candidate) => candidate.tomlName === tomlName);
      expect(field?.description).toBe(definition.description);
      expect(field?.mergeStrategy).toBe(definition.mergeStrategy);
      expect(CONFIG_MERGE_RULES[definition.configKey].strategy).toBe(
        definition.mergeStrategy,
      );
      expect(["runtime", "value", "optional"]).toContain(
        definition.defaultDecision,
      );
    }

    expect(CONFIG_FIELD_CATALOG.shm_size.defaultDecision).toBe("optional");
  });
});

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
