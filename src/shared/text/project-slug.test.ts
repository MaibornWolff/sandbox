import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { safeResolve } from "./index.js";
import { generateProjectSlug } from "./project-slug.js";

describe("generateProjectSlug", () => {
  test("generates slug with project name and hash", () => {
    const result = generateProjectSlug(process.cwd());

    // Should contain the current directory name (lowercased, sanitized)
    const dirName = path.basename(process.cwd()).toLowerCase();
    expect(result).toContain(dirName);
    // Should have a dash followed by 4-char hash
    expect(result).toMatch(/.*-[a-f0-9]{4}$/);
  });

  test("generates different slugs for different paths", () => {
    const slug1 = generateProjectSlug("/Users/bob/projects/my-app");
    const slug2 = generateProjectSlug("/Users/bob/work/my-app");

    // Different paths should produce different hashes
    expect(slug1).not.toBe(slug2);
    // Both should have valid format
    expect(slug1).toMatch(/^[a-z0-9-]+-[a-f0-9]{4}$/);
    expect(slug2).toMatch(/^[a-z0-9-]+-[a-f0-9]{4}$/);
  });

  test("sanitizes special characters", () => {
    const result = generateProjectSlug("/Users/bob/My Projects/App_Name!");

    // Should be lowercase and only contain alphanumeric + dash
    expect(result).toMatch(/^[a-z0-9-]+$/);
    // Should not contain spaces or special chars
    expect(result).not.toContain(" ");
    expect(result).not.toContain("_");
    expect(result).not.toContain("!");
  });

  test("generates same slug for same path", () => {
    const slug1 = generateProjectSlug(process.cwd());
    const slug2 = generateProjectSlug(process.cwd());

    // Same path should always produce same slug
    expect(slug1).toBe(slug2);
  });

  test("respects max length of 63 characters", () => {
    // Create a very long path
    const longPath = "/very/long/path/with/many/segments/to/test/length/limits";
    const result = generateProjectSlug(longPath);

    // Should not exceed Docker name limit
    expect(result.length).toBeLessThanOrEqual(63);
  });

  test("extracts last 1-2 path components", () => {
    const result = generateProjectSlug("/Users/bob/projects/client/website");

    // Should contain both "client" and "website"
    expect(result).toContain("client-website");
  });

  test("handles paths with trailing slashes", () => {
    const slug1 = generateProjectSlug("/Users/bob/project");
    const slug2 = generateProjectSlug("/Users/bob/project/");

    // Should produce the same slug regardless of trailing slash
    expect(slug1).toBe(slug2);
  });

  test("handles relative paths", () => {
    const result = generateProjectSlug(".");

    // Should resolve to current directory and produce valid slug
    expect(result).toBeTruthy();
    expect(result).toMatch(/^[a-z0-9-]+-[a-f0-9]{4}$/);
  });

  test("collapses multiple dashes", () => {
    const result = generateProjectSlug("/Users/bob/my---project___name");

    // Should collapse multiple dashes into single dash
    expect(result).not.toContain("--");
    expect(result).not.toContain("___");
  });

  test("trims dashes from ends", () => {
    const result = generateProjectSlug("/Users/bob/-project-");

    // Should not start or end with dash (except for the hash separator)
    const withoutHash = result.substring(0, result.lastIndexOf("-"));
    expect(withoutHash).not.toMatch(/^-/);
    expect(withoutHash).not.toMatch(/-$/);
  });

  test("handles Windows absolute paths", () => {
    // This test verifies Windows paths aren't mangled by path.resolve()
    // On Git Bash, path.resolve("C:/project") wrongly becomes "/current/dir/C:/project"
    // With safeResolve, "C:/project" stays "C:/project"
    expect(safeResolve("C:/Users/test/project")).toBe("C:/Users/test/project");
  });
});

describe("generateProjectSlug - Windows path normalization", () => {
  test("generates same slug for forward-slash and backslash Windows paths", () => {
    const slug1 = generateProjectSlug("C:/Development/myproject");
    const slug2 = generateProjectSlug("C:\\Development\\myproject");
    expect(slug1).toBe(slug2);
  });

  test("does not include drive letter prefix in slug components", () => {
    const slug = generateProjectSlug("C:/Development/myproject");
    expect(slug).toMatch(/^development-myproject-[a-f0-9]{4}$/);
  });

  test("handles short Windows paths with drive letter", () => {
    const slug = generateProjectSlug("C:/myproject");
    // "C:" becomes "c" after sanitization, acceptable for uniqueness
    expect(slug).toMatch(/^c-myproject-[a-f0-9]{4}$/);
  });
});
