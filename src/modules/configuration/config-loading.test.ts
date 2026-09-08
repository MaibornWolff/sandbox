import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { runWithConfigurationTestScope } from "./__test__/index.js";
import {
  loadTomlConfig as loadTomlConfigInScope,
  parseTomlDocument,
} from "./toml-config-loading.js";

const loadTomlConfig: typeof loadTomlConfigInScope = (...args) =>
  runWithConfigurationTestScope(() => loadTomlConfigInScope(...args));

describe("TOML configuration loading", () => {
  test("returns null for a missing optional file", () => {
    expect(loadTomlConfig("/nonexistent/path/config.toml")).toBeNull();
  });

  test("parses a valid file from a real temporary filesystem", () => {
    const root = createTestDir("toml-loading");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(file, 'runtime = "docker"\nreadonly = true\n');

    expect(loadTomlConfig(file)).toMatchObject({
      runtime: "docker",
      readonly: true,
    });
  });

  test("parses mixed arrays with strings, nested arrays, and inline tables", () => {
    const configPath = "/virtual/mixed-config.toml";
    const parsed = parseTomlDocument(
      `pattern = ['git', ['status', 'diff'], { regex = 'feature-[0-9]+' }]`,
      configPath,
    );

    expect(parsed).toEqual({
      pattern: ["git", ["status", "diff"], { regex: "feature-[0-9]+" }],
    });
  });

  test("preserves existing TOML value forms", () => {
    const parsed = parseTomlDocument(
      `# Existing Sandbox configuration value forms
name = "sandbox"
retries = 3
enabled = true
items = ["one", "two"]
metadata = { owner = "configuration", active = true }
description = """first line
second line"""

[[rules]]
name = "first"

[[rules]]
name = "second"
`,
      "/virtual/value-forms.toml",
    );

    expect(parsed).toEqual({
      name: "sandbox",
      retries: 3,
      enabled: true,
      items: ["one", "two"],
      metadata: { owner: "configuration", active: true },
      description: "first line\nsecond line",
      rules: [{ name: "first" }, { name: "second" }],
    });
  });

  test("rejects unreadable configuration paths", () => {
    const root = createTestDir("toml-read-error");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));

    expect(() => loadTomlConfig(root)).toThrow(
      `Failed to read config at ${root}`,
    );
  });

  test("rejects duplicate keys, malformed TOML, and unsupported values", () => {
    const root = createTestDir("toml-errors");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");

    fs.writeFileSync(file, "readonly = true\nreadonly = false\n");
    expect(() => loadTomlConfig(file)).toThrow(
      `Failed to parse config at ${file}`,
    );

    fs.writeFileSync(file, "readonly = [\n");
    expect(() => loadTomlConfig(file)).toThrow(
      `Failed to parse config at ${file}`,
    );

    fs.writeFileSync(file, "readonly = 1979-05-27\n");
    expect(() => loadTomlConfig(file)).toThrow(`Invalid config at ${file}`);
    expect(() => loadTomlConfig(file)).toThrow("readonly");

    fs.writeFileSync(file, 'runtime = "invalid"\n');
    expect(() => loadTomlConfig(file)).toThrow(file);
    expect(() => loadTomlConfig(file)).toThrow("runtime");
  });

  test("rejects semantic configuration errors but permits warnings", () => {
    const root = createTestDir("toml-semantic-errors");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(file, 'settings = [".claude/settings.json"]\n');

    expect(() => loadTomlConfig(file)).toThrow(`Invalid config at ${file}`);
    expect(() => loadTomlConfig(file)).toThrow("Invalid settings pattern");

    fs.writeFileSync(file, 'persist_paths = [{ path = "relative-path" }]\n');
    expect(loadTomlConfig(file)).toMatchObject({
      persist_paths: [{ path: "relative-path" }],
    });
  });

  test("loads structured rules with recursive matcher forms and removes no data yet", () => {
    const root = createTestDir("toml-host-command-rules");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      `[[allow_host_commands]]
pattern = ["git", ["status", [{ regex = 'diff-[0-9]+' }]]]
test_match = [["git", "status"], ["git", "diff-12"]]
test_no_match = [["git", "push"]]

[[allow_host_commands]]
pattern = ["open", { repeat = [{ regex = 'https?://\\S+' }, { regex = '[^-].*\\.html?', flags = "i" }], min = 1, max = 2 }]
test_match = [["open", "REPORT.HTML", "https://example.com"]]
`,
    );

    expect(loadTomlConfig(file)?.allow_host_commands).toEqual([
      {
        pattern: ["git", ["status", [{ regex: "diff-[0-9]+" }]]],
        test_match: [
          ["git", "status"],
          ["git", "diff-12"],
        ],
        test_no_match: [["git", "push"]],
      },
      {
        pattern: [
          "open",
          {
            repeat: [
              { regex: "https?://\\S+" },
              { regex: "[^-].*\\.html?", flags: "i" },
            ],
            min: 1,
            max: 2,
          },
        ],
        test_match: [["open", "REPORT.HTML", "https://example.com"]],
      },
    ]);
  });

  test("loads argument wildcards and validates their rule examples", () => {
    const root = createTestDir("toml-host-command-wildcards");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      `[[allow_host_commands]]
pattern = ["tool", "?", "*", "done"]
test_match = [["tool", "one", "done"], ["tool", "one", "two", "three", "done"]]
test_no_match = [["tool", "done"], ["tool", "one", "two"]]
`,
    );

    expect(loadTomlConfig(file)?.allow_host_commands).toEqual([
      {
        pattern: ["tool", "?", "*", "done"],
        test_match: [
          ["tool", "one", "done"],
          ["tool", "one", "two", "three", "done"],
        ],
        test_no_match: [
          ["tool", "done"],
          ["tool", "one", "two"],
        ],
      },
    ]);
  });

  test("rejects invalid regex flags, expressions, and repetition", () => {
    const root = createTestDir("toml-host-command-invalid-matchers");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    const invalidCases = [
      [`pattern = ["tool", { regex = ".+", flags = "g" }]`, 'flag "i"'],
      [`pattern = ["tool", { regex = "(?=unsafe)" }]`, "RE2 engine"],
      [
        `pattern = ["tool", { repeat = "value", min = 2, max = 1 }]`,
        "greater than or equal to min",
      ],
      [
        `pattern = ["tool", { repeat = { repeat = "value", min = 0, max = 1 }, min = 0, max = 1 }]`,
        "nested repetition is not supported",
      ],
      [`pattern = ["tool", ["safe", "*"]]`, "top-level pattern segment"],
    ] as const;

    for (const [rule, expected] of invalidCases) {
      fs.writeFileSync(file, `[[allow_host_commands]]\n${rule}\n`);
      expect(() => loadTomlConfig(file)).toThrow(file);
      expect(() => loadTomlConfig(file)).toThrow(expected);
    }
  });

  test("reports failing rule examples with source locations and argument vectors", () => {
    const root = createTestDir("toml-host-command-test-errors");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      `[[allow_host_commands]]
pattern = ["git", "status"]
test_match = [["git", "diff"]]
test_no_match = [["git", "status"]]
`,
    );

    expect(() => loadTomlConfig(file)).toThrow(file);
    expect(() => loadTomlConfig(file)).toThrow("test_match[1]");
    expect(() => loadTomlConfig(file)).toThrow("rule 1");
    expect(() => loadTomlConfig(file)).toThrow('["git","diff"]');
    expect(() => loadTomlConfig(file)).toThrow("test_no_match[1]");
    expect(() => loadTomlConfig(file)).toThrow('["git","status"]');
  });

  test("rejects legacy string rules with actionable migration guidance", () => {
    const root = createTestDir("toml-host-command-migration");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(file, 'allow_host_commands = ["open *"]\n');

    expect(() => loadTomlConfig(file)).toThrow(file);
    expect(() => loadTomlConfig(file)).toThrow("wildcard strings");
    expect(() => loadTomlConfig(file)).toThrow("[[allow_host_commands]]");
    expect(() => loadTomlConfig(file)).toThrow(
      'pattern = ["bun", "run", "test:e2e"]',
    );
  });

  test("rejects unknown top-level and nested configuration fields", () => {
    const root = createTestDir("toml-unknown-fields");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const file = path.join(root, "config.toml");
    fs.writeFileSync(file, "unexpected = true\n");
    expect(() => loadTomlConfig(file)).toThrow("unexpected");

    fs.writeFileSync(
      file,
      'persist_paths = [{ path = "~/.cache", unexpected = true }]\n',
    );
    expect(() => loadTomlConfig(file)).toThrow("unexpected");
    expect(() => loadTomlConfig(file)).toThrow("persist_paths");
  });
});
