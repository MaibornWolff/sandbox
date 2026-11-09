import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  injectAllowedDomains,
  readNetworkConfigFile,
  writeNetworkConfigFile,
} from "./allowed-network-config-update.js";

describe("injectAllowedDomains", () => {
  test("empty content creates new allow_network section", () => {
    const result = injectAllowedDomains("", ["github.com"]);
    expect(result).toMatch(/^allow_network\s*=\s*\[/m);
    expect(result).toContain('"github.com"');
  });

  test("empty domains returns content unchanged", () => {
    const content = 'allow_network = [\n  "existing.com",\n]';
    expect(injectAllowedDomains(content, [])).toBe(content);
  });

  test("existing allow_network array injects before closing bracket", () => {
    const content = 'allow_network = [\n  "existing.com",\n]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
    expect(parsed.allow_network).toHaveLength(2);
  });

  test("single-line allow_network array injects before closing bracket", () => {
    const content = 'allow_network = ["existing.com"]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
  });

  test("commented-out allow_network appends new section", () => {
    const content = '# allow_network = [\n# "example.com",\n# ]';
    const result = injectAllowedDomains(content, ["github.com"]);
    expect(result).toMatch(/^allow_network\s*=\s*\[/m);
    expect(result).toContain('"github.com"');
  });

  test("commented allow_network before real block inserts into real block", () => {
    const content =
      '# allow_network = [\n#   "commented.com",\n# ]\nallow_network = [\n  "existing.com",\n]';
    const result = injectAllowedDomains(content, ["github.com"]);
    expect(result).toContain('"github.com"');
    // The commented block must remain unchanged
    expect(result).toContain("# allow_network = [");
    expect(result).toContain('#   "commented.com",');
    // Domain appears only inside the real (uncommented) block
    const commentedSection = result.slice(0, result.indexOf("\nallow_network"));
    expect(commentedSection).not.toContain('"github.com"');
    // Only one uncommented allow_network block
    const matches = result.match(/^allow_network\s*=\s*\[/gm);
    expect(matches).toHaveLength(1);
  });

  test("preserves surrounding config sections", () => {
    const content =
      'env = [\n  "FOO=bar",\n]\nallow_network = [\n]\nruntime = "docker"';
    const result = injectAllowedDomains(content, ["github.com"]);
    expect(result).toContain("env = [");
    expect(result).toContain('runtime = "docker"');
    expect(result).toContain('"github.com"');
  });

  test("injects multiple domains at once", () => {
    const content = "allow_network = [\n]";
    const result = injectAllowedDomains(content, [
      "github.com",
      "api.stripe.com",
      "registry.npmjs.org",
    ]);
    expect(result).toContain('"github.com"');
    expect(result).toContain('"api.stripe.com"');
    expect(result).toContain('"registry.npmjs.org"');
    // Still one allow_network block
    expect((result.match(/^allow_network\s*=\s*\[/gm) ?? []).length).toBe(1);
  });

  test("indented allow_network is detected and injected into (not duplicated)", () => {
    const content = '  allow_network = [\n    "existing.com",\n  ]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
    // No duplicate key appended
    expect((result.match(/allow_network\s*=/g) ?? []).length).toBe(1);
  });

  test("inline comment on last item: comma inserted before comment, result is valid TOML", () => {
    const content = 'allow_network = [\n  "existing.com" # keep me\n]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
    // Comment must still be present
    expect(result).toContain("# keep me");
    // Comma must not appear after the comment text
    expect(result).not.toMatch(/# keep me,/);
  });

  test("comment-only last line: comma not inserted, result is valid TOML", () => {
    const content = "allow_network = [\n  # existing comment\n]";
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("github.com");
    // Comment must still be present
    expect(result).toContain("# existing comment");
    // No comma should appear before or on the comment-only line
    expect(result).not.toMatch(/,\s*#/);
  });

  test("trailing comment line after value keeps valid TOML", () => {
    const content = 'allow_network = [\n  "existing.com"\n  # keep comment\n]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
    expect(result).toContain("# keep comment");
  });

  test("indented key with inline comment injects correctly", () => {
    const content = '  allow_network = [\n    "existing.com" # note\n  ]';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toContain("existing.com");
    expect(parsed.allow_network).toContain("github.com");
    expect(result).toContain("# note");
    expect(result).not.toMatch(/# note,/);
  });

  test("appends allow_network before the first table so it stays top-level", () => {
    const content =
      'runtime = "docker"\n\n[[allow_host_commands]]\npattern = ["git"]\n';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as {
      allow_network: string[];
      allow_host_commands: { pattern: string[] }[];
    };
    expect(parsed.allow_network).toEqual(["github.com"]);
    expect(parsed.allow_host_commands).toEqual([{ pattern: ["git"] }]);
  });

  test("ignores a closing bracket inside a comment", () => {
    const content = 'allow_network = [\n  "existing.com", # see [docs]\n]\n';
    const result = injectAllowedDomains(content, ["github.com"]);
    const parsed = parseToml(result) as { allow_network: string[] };
    expect(parsed.allow_network).toEqual(["existing.com", "github.com"]);
    expect(result).toContain("# see [docs]");
  });

  test.each([
    'a.com","*.evil.com',
    "a.com\nconf-file=/x",
    "a.com b.com",
    "",
    "*",
  ])("rejects %j as a network entry", (domain) => {
    expect(() => injectAllowedDomains("", [domain])).toThrow(
      /Invalid network entry/,
    );
  });

  test.each([
    "github.com",
    "*.github.com:443",
    "10.0.0.1:{80,443}",
    "api.x.io:*",
  ])("accepts %s as a network entry", (domain) => {
    const parsed = parseToml(injectAllowedDomains("", [domain])) as {
      allow_network: string[];
    };
    expect(parsed.allow_network).toEqual([domain]);
  });
});

describe("readNetworkConfigFile", () => {
  test("returns empty content for a missing file", () => {
    const dir = createTestDir("network-config-read");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(dir) };
    expect(readNetworkConfigFile(path.join(dir, "config.toml"))).toBe("");
  });

  test("throws for a path that cannot be read", () => {
    const dir = createTestDir("network-config-read");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(dir) };
    expect(() => readNetworkConfigFile(dir)).toThrow(/EISDIR/);
  });
});

describe("writeNetworkConfigFile", () => {
  test("creates parent directories and leaves no temporary files", () => {
    const dir = createTestDir("network-config-write");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(dir) };
    const target = path.join(dir, "nested", "config.toml");
    writeNetworkConfigFile(target, "a = 1\n");
    writeNetworkConfigFile(target, "a = 2\n");
    expect(fs.readFileSync(target, "utf8")).toBe("a = 2\n");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["config.toml"]);
  });
});
