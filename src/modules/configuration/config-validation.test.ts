import { describe, expect, test } from "bun:test";
import {
  hasGlobChars,
  validateConfig,
  validatePersistPath,
  validateSettingsPattern,
} from "./config-validation.js";

describe("validatePersistPath", () => {
  describe("object format", () => {
    test("accepts valid object format", () => {
      expect(validatePersistPath({ path: "~/.config" })).toBeNull();
      expect(validatePersistPath({ path: "/absolute/path" })).toBeNull();
      expect(validatePersistPath({ path: "./relative" })).toBeNull();
    });

    test("accepts object with default content", () => {
      expect(
        validatePersistPath({ path: "~/.config.json", default: "{}" }),
      ).toBeNull();
    });

    test("accepts global: true with home-relative path", () => {
      expect(
        validatePersistPath({ path: "~/.credentials", global: true }),
      ).toBeNull();
    });

    test("accepts global: true with absolute path", () => {
      expect(
        validatePersistPath({
          path: "/home/sandbox/.credentials",
          global: true,
        }),
      ).toBeNull();
    });

    test("rejects global: true with project-relative path", () => {
      const result = validatePersistPath({ path: "./config", global: true });
      expect(result).not.toBeNull();
      expect(result).toContain(
        "Global paths cannot use project-relative format",
      );
    });

    test("rejects bare paths in object format", () => {
      expect(validatePersistPath({ path: "node_modules" })).not.toBeNull();
    });
  });

  describe("glob patterns", () => {
    test("rejects global: true with glob pattern (home-relative)", () => {
      // Use home-relative to avoid hitting the project-relative check first
      const result = validatePersistPath({
        path: "~/**/.cache",
        global: true,
      });
      expect(result).not.toBeNull();
      expect(result).toContain("Glob patterns cannot be used with global");
    });

    test("rejects global: true with glob pattern (project-relative)", () => {
      // Project-relative with global fails on the global check first
      const result = validatePersistPath({
        path: "./**/node_modules",
        global: true,
      });
      expect(result).not.toBeNull();
      expect(result).toContain("Global paths cannot use project-relative");
    });

    test("rejects glob in home-relative path", () => {
      expect(validatePersistPath({ path: "~/**/.cache" })).toContain(
        "only supported for project-relative",
      );
      expect(validatePersistPath({ path: "~/*" })).toContain(
        "only supported for project-relative",
      );
    });

    test("rejects glob in absolute path", () => {
      expect(validatePersistPath({ path: "/home/**/cache" })).toContain(
        "only supported for project-relative",
      );
    });

    test("accepts glob in project-relative path", () => {
      expect(validatePersistPath({ path: "./**/node_modules" })).toBeNull();
      expect(validatePersistPath({ path: "./*/node_modules" })).toBeNull();
      expect(validatePersistPath({ path: "./packages/*/dist" })).toBeNull();
      expect(validatePersistPath({ path: "./**/.venv" })).toBeNull();
    });

    test("accepts literal paths unchanged", () => {
      expect(validatePersistPath({ path: "~/.claude" })).toBeNull();
      expect(validatePersistPath({ path: "./node_modules" })).toBeNull();
      expect(validatePersistPath({ path: "/home/sandbox/.config" })).toBeNull();
    });
  });
});

describe("hasGlobChars", () => {
  test("detects asterisk glob", () => {
    expect(hasGlobChars("./*/node_modules")).toBe(true);
    expect(hasGlobChars("./**/node_modules")).toBe(true);
    expect(hasGlobChars("./packages/*.json")).toBe(true);
  });

  test("detects ** recursive glob", () => {
    expect(hasGlobChars("./**/node_modules")).toBe(true);
  });

  test("detects question mark glob", () => {
    expect(hasGlobChars("./file?.txt")).toBe(true);
  });

  test("detects bracket patterns", () => {
    expect(hasGlobChars("./file[0-9].txt")).toBe(true);
    expect(hasGlobChars("./dir{a,b,c}")).toBe(true);
  });

  test("returns false for non-glob paths", () => {
    expect(hasGlobChars("/home/sandbox")).toBe(false);
    expect(hasGlobChars("./node_modules")).toBe(false);
    expect(hasGlobChars("./path/to/file.txt")).toBe(false);
  });
});

describe("validateSettingsPattern", () => {
  test("accepts home-relative patterns", () => {
    expect(validateSettingsPattern("~/.claude")).toBeNull();
    expect(validateSettingsPattern("~/.claude/skills/")).toBeNull();
    expect(validateSettingsPattern("~/.claude/*.json")).toBeNull();
    expect(validateSettingsPattern("~/.config/opencode/*")).toBeNull();
  });

  test("accepts exclusion patterns with !~/", () => {
    expect(validateSettingsPattern("!~/.git")).toBeNull();
    expect(validateSettingsPattern("!~/node_modules")).toBeNull();
    expect(validateSettingsPattern("!~/.claude/projects/**")).toBeNull();
  });

  test("rejects patterns without ~/ prefix", () => {
    const result = validateSettingsPattern(".claude/skills/");
    expect(result).not.toBeNull();
    expect(result).toContain('Must start with "~/"');
  });

  test("rejects exclusion patterns without !~/ prefix", () => {
    const result = validateSettingsPattern("!node_modules");
    expect(result).not.toBeNull();
    expect(result).toContain('Must start with "!~/"');
  });

  test("rejects bare paths", () => {
    expect(validateSettingsPattern("node_modules")).not.toBeNull();
    expect(validateSettingsPattern(".claude")).not.toBeNull();
  });
});

describe("use_named_volume", () => {
  test("accepts valid use_named_volume with absolute path outside /home/sandbox", () => {
    expect(
      validatePersistPath({ path: "/nix", use_named_volume: "nix" }),
    ).toBeNull();
    expect(
      validatePersistPath({ path: "/data", use_named_volume: "mydata" }),
    ).toBeNull();
  });

  test("rejects use_named_volume with default field", () => {
    const result = validatePersistPath({
      path: "/nix",
      use_named_volume: "nix",
      default: "content",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("cannot be combined with default");
  });

  test("rejects use_named_volume with only_if_exists", () => {
    const result = validatePersistPath({
      path: "/nix",
      use_named_volume: "nix",
      only_if_exists: true,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("cannot be combined with only_if_exists");
  });

  test("rejects use_named_volume with glob path", () => {
    const result = validatePersistPath({
      path: "/nix/*",
      use_named_volume: "nix",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("cannot be combined with glob paths");
  });

  test("accepts use_named_volume with home-relative path", () => {
    const result = validatePersistPath({
      path: "~/nix",
      use_named_volume: "nix",
    });
    expect(result).toBeNull();
  });

  test("accepts use_named_volume path inside /home/sandbox", () => {
    const result = validatePersistPath({
      path: "/home/sandbox/nix",
      use_named_volume: "nix",
    });
    expect(result).toBeNull();
  });

  test("rejects use_named_volume with project-relative path", () => {
    const result = validatePersistPath({
      path: "./nix",
      use_named_volume: "nix",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("requires an absolute or home-relative");
  });
});

describe("validateConfig", () => {
  test("returns valid for empty config", () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("returns valid for config with valid object paths", () => {
    const result = validateConfig({
      persist_paths: [
        { path: "~/.local/state" },
        { path: "~/.config.json", default: "{}" },
        { path: "~/.credentials", global: true },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns valid for various path formats", () => {
    const result = validateConfig({
      persist_paths: [
        { path: "/home/sandbox" },
        { path: "./node_modules" },
        { path: "~/.local/state" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns warnings for bare paths without prefix", () => {
    const result = validateConfig({
      persist_paths: [{ path: ".claude" }, { path: "node_modules" }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.suggestRegenerate).toBe(true);
  });

  test("returns warnings for global with project-relative path", () => {
    const result = validateConfig({
      persist_paths: [{ path: "./config", global: true }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("Global paths cannot"))).toBe(
      true,
    );
  });

  test("includes specific path in warning message", () => {
    const result = validateConfig({
      persist_paths: [{ path: "old-style-path" }],
    });
    expect(result.warnings.some((w) => w.includes("old-style-path"))).toBe(
      true,
    );
  });

  test("does not suggest regenerate for valid config", () => {
    const result = validateConfig({
      persist_paths: [{ path: "~/.local/state" }, { path: "~/.claude" }],
    });
    expect(result.suggestRegenerate).toBe(false);
  });

  test("returns valid for config with valid settings patterns", () => {
    const result = validateConfig({
      settings: ["~/.claude/skills/", "~/.codex/*.json", "!~/node_modules"],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("returns errors for settings patterns without ~/ prefix", () => {
    const result = validateConfig({
      settings: [".claude/skills/", "!node_modules"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.suggestRegenerate).toBe(true);
  });

  test("rejects non-canonical and escaping settings paths", () => {
    const result = validateConfig({
      settings: [
        "~/.codex/./config.toml",
        "~/.codex/../config.toml",
        "~/.codex//config.toml",
        "~/.codex\\config.toml",
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(4);
    expect(result.errors.every((error) => error.includes("normalized"))).toBe(
      true,
    );
  });

  test("accepts literal copy settings", () => {
    const result = validateConfig({
      settings: [{ path: "~/.codex/config.toml", mode: "copy" }],
    });
    expect(result.valid).toBe(true);
  });

  test("rejects copy globs and exclusions", () => {
    const result = validateConfig({
      settings: [
        { path: "~/.codex/*.toml", mode: "copy" },
        { path: "!~/.codex/config.toml", mode: "copy" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Copy setting path must be literal and cannot contain a glob: "~/.codex/*.toml".',
      'Copy setting path must not be an exclusion: "!~/.codex/config.toml".',
    ]);
  });

  describe("use_named_volume", () => {
    test("returns valid for correct use_named_volume entry", () => {
      const result = validateConfig({
        persist_paths: [{ path: "/nix", use_named_volume: "nix" }],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("warns about duplicate use_named_volume values", () => {
      const result = validateConfig({
        persist_paths: [
          { path: "/nix", use_named_volume: "nix" },
          { path: "/nix2", use_named_volume: "nix" },
        ],
      });
      expect(result.warnings).toContainEqual(
        expect.stringContaining('Duplicate use_named_volume value: "nix"'),
      );
    });
  });

  describe("glob patterns", () => {
    test("warns when only_if_exists is false with glob", () => {
      const result = validateConfig({
        persist_paths: [{ path: "./**/node_modules", only_if_exists: false }],
      });
      expect(result.valid).toBe(true); // Warning, not error
      expect(result.warnings).toContainEqual(
        expect.stringContaining("only_if_exists: false has no effect"),
      );
    });

    test("no warning when only_if_exists is true with glob", () => {
      const result = validateConfig({
        persist_paths: [{ path: "./**/node_modules", only_if_exists: true }],
      });
      expect(result.warnings).toHaveLength(0);
    });

    test("no warning when only_if_exists is undefined with glob", () => {
      const result = validateConfig({
        persist_paths: [{ path: "./**/node_modules" }],
      });
      expect(result.warnings).toHaveLength(0);
    });

    test("returns error for global: true with glob pattern", () => {
      // Use home-relative glob to specifically test the global+glob validation
      const result = validateConfig({
        persist_paths: [{ path: "~/**/.cache", global: true }],
      });
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Glob patterns cannot be used with global"),
      );
      expect(result.suggestRegenerate).toBe(true);
    });

    test("returns error for glob in non-project-relative path", () => {
      const result = validateConfig({
        persist_paths: [{ path: "~/**/.cache" }],
      });
      expect(result.warnings).toContainEqual(
        expect.stringContaining("only supported for project-relative"),
      );
    });
  });
});

describe("persist path traversal", () => {
  test.each([
    "~/../.ssh/authorized_keys",
    "./../outside",
    "/home/sandbox/../../etc/passwd",
    "~/.cache/../../escape",
    "~/.cache/./state",
    "~/.cache//state",
    "~/..\\.ssh",
    "~/",
    "./",
    "/home/sandbox/",
    "/",
  ])("rejects %s as an error", (persistPath) => {
    const result = validateConfig({ persist_paths: [{ path: persistPath }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining(persistPath)]);
  });

  test("accepts normalized persist paths with a trailing separator", () => {
    const result = validateConfig({
      persist_paths: [{ path: "~/.cache/" }, { path: "./**/.venv" }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
