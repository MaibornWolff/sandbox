import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { injectAllowedDomains } from "./allowed-network-config-update.js";

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
});
