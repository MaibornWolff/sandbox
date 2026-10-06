import { describe, expect, test } from "bun:test";
import { RUNTIME_IDS } from "./config.js";
import {
  normalizePersistPath,
  normalizeSettingsEntry,
  normalizeSettingsPattern,
  tomlConfigSchema,
} from "./toml-config-schema.js";

describe("tomlConfigSchema", () => {
  test("validates valid config with all fields", () => {
    const config = {
      mounts: ["/data:/data:ro"],
      env: ["FOO=bar"],
      readonly: true,
      persist_paths: [{ path: "~/.local/state" }],
      runtime: "podman",
      settings: [".claude/*.json"],
      ports: ["8080:8080"],
      allow_network: ["api.example.com"],
      allow_host_commands: [
        {
          pattern: ["open", { repeat: { regex: ".+" }, min: 1, max: 2 }],
          test_match: [["open", "report.html"]],
          test_no_match: [["open"]],
        },
        { pattern: ["bun", "run", "test:e2e"] },
      ],
      full_network: false,
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts strict settings tables and rejects unknown fields", () => {
    expect(
      tomlConfigSchema.safeParse({
        settings: [
          "~/.claude/settings.json",
          { path: "~/.codex/config.toml" },
          { path: "~/.tool/config", mode: "copy" },
        ],
      }).success,
    ).toBe(true);
    expect(
      tomlConfigSchema.safeParse({
        settings: [{ path: "~/.codex/config.toml", strategy: "copy" }],
      }).success,
    ).toBe(false);
  });

  test("normalizes settings paths and defaults mode to mount", () => {
    expect(normalizeSettingsEntry("~/.claude/settings.json")).toEqual({
      path: ".claude/settings.json",
      mode: "mount",
    });
    expect(
      normalizeSettingsEntry({ path: "~/.codex/config.toml", mode: "copy" }),
    ).toEqual({ path: ".codex/config.toml", mode: "copy" });
  });

  test("validates empty config", () => {
    const result = tomlConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("validates persist_paths as objects", () => {
    const config = {
      persist_paths: [
        { path: "~/.config.json", default: "{}", global: true },
        { path: "~/.local/state" },
      ],
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("validates persist_paths with only_if_exists", () => {
    const config = {
      persist_paths: [
        { path: "./node_modules", only_if_exists: true },
        { path: "~/.local/state", only_if_exists: false },
      ],
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects string persist_paths (only objects allowed)", () => {
    const config = {
      persist_paths: ["~/.local/state"],
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test.each(["enabled", "disabled"])("accepts clipboard = %s", (clipboard) => {
    expect(tomlConfigSchema.parse({ clipboard })).toEqual({ clipboard });
  });

  test.each(["auto", "x11", "invalid"])(
    "rejects invalid clipboard mode %s",
    (clipboard) => {
      const result = tomlConfigSchema.safeParse({ clipboard });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Invalid clipboard mode accepted");
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid_value",
          path: ["clipboard"],
          message: 'Use clipboard = "enabled" or clipboard = "disabled".',
        }),
      );
    },
  );

  test("rejects invalid persist_path object", () => {
    const config = {
      persist_paths: [{ invalid: "field" }],
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("rejects wrong type for boolean field", () => {
    const config = {
      readonly: "yes",
    };

    const result = tomlConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("validates strict recursive host command rule structure", () => {
    const valid = tomlConfigSchema.safeParse({
      allow_host_commands: [
        {
          pattern: [
            "tool",
            ["literal", [{ regex: "nested" }]],
            { repeat: ["one", { regex: "two", flags: "i" }], min: 0, max: 2 },
          ],
          test_match: [["tool", "literal"]],
          test_no_match: [["tool"]],
        },
      ],
    });
    expect(valid.success).toBe(true);

    for (const rule of [
      "tool *",
      { pattern: ["tool", []] },
      { pattern: ["tool", { regex: ".+", unsupported: true }] },
      { pattern: ["tool", { repeat: "value", min: 0 }] },
      { pattern: ["tool"], test_match: ["tool"] },
      { pattern: ["tool"], unsupported: true },
    ]) {
      expect(
        tomlConfigSchema.safeParse({ allow_host_commands: [rule] }).success,
      ).toBe(false);
    }
  });

  test("validates no_proxy boolean", () => {
    const result = tomlConfigSchema.safeParse({ no_proxy: true });
    expect(result.success).toBe(true);
  });

  test("rejects no_proxy string", () => {
    const result = tomlConfigSchema.safeParse({ no_proxy: "yes" });
    expect(result.success).toBe(false);
  });

  test("accepts every supported runtime and rejects unknown runtimes", () => {
    for (const runtime of RUNTIME_IDS) {
      expect(tomlConfigSchema.safeParse({ runtime }).success).toBe(true);
    }
    expect(tomlConfigSchema.safeParse({ runtime: "containerd" }).success).toBe(
      false,
    );
  });
});

describe("normalizePersistPath", () => {
  test("normalizes object without optional flags", () => {
    const result = normalizePersistPath({ path: "~/.config.json" });
    expect(result).toEqual({
      path: "~/.config.json",
      global: false,
      onlyIfExists: false,
    });
  });

  test("normalizes object with global: true", () => {
    const result = normalizePersistPath({
      path: "~/.credentials",
      global: true,
    });
    expect(result).toEqual({
      path: "~/.credentials",
      global: true,
      onlyIfExists: false,
    });
  });

  test("normalizes object with default content", () => {
    const result = normalizePersistPath({
      path: "~/.config.json",
      default: "{}",
    });
    expect(result).toEqual({
      path: "~/.config.json",
      default: "{}",
      global: false,
      onlyIfExists: false,
    });
  });

  test("normalizes object with only_if_exists: true", () => {
    const result = normalizePersistPath({
      path: "./node_modules",
      only_if_exists: true,
    });
    expect(result).toEqual({
      path: "./node_modules",
      global: false,
      onlyIfExists: true,
    });
  });

  test("normalizes object with all fields", () => {
    const result = normalizePersistPath({
      path: "~/.credentials.json",
      default: "{}",
      global: true,
      only_if_exists: false,
    });
    expect(result).toEqual({
      path: "~/.credentials.json",
      default: "{}",
      global: true,
      onlyIfExists: false,
    });
  });

  test("normalizes object with explicit global: false", () => {
    const result = normalizePersistPath({
      path: "~/.local/state",
      global: false,
    });
    expect(result).toEqual({
      path: "~/.local/state",
      global: false,
      onlyIfExists: false,
    });
  });
});

describe("normalizeSettingsPattern", () => {
  test("strips ~/ prefix from regular patterns", () => {
    expect(normalizeSettingsPattern("~/.claude")).toBe(".claude");
    expect(normalizeSettingsPattern("~/.claude/skills/")).toBe(
      ".claude/skills/",
    );
    expect(normalizeSettingsPattern("~/.config/opencode/*")).toBe(
      ".config/opencode/*",
    );
  });

  test("converts !~/ to ! for exclusion patterns", () => {
    expect(normalizeSettingsPattern("!~/.git")).toBe("!.git");
    expect(normalizeSettingsPattern("!~/node_modules")).toBe("!node_modules");
    expect(normalizeSettingsPattern("!~/.claude/projects/**")).toBe(
      "!.claude/projects/**",
    );
  });

  test("returns pattern as-is if no ~/ prefix (fallback)", () => {
    // This shouldn't happen if validated, but test the fallback
    expect(normalizeSettingsPattern(".claude")).toBe(".claude");
    expect(normalizeSettingsPattern("!node_modules")).toBe("!node_modules");
  });
});
