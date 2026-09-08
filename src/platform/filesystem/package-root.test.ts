import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { findPackageRootPath } from "./package-root.js";

const directories: string[] = [];

function createPackage(layout: string): { entry: string; root: string } {
  const root = createTestDir("package-root");
  directories.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@maibornwolff/sandbox" }),
  );
  const entry = path.join(root, ...layout.split("/"), "main.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "");
  return { entry, root };
}

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTestDir(directory);
});

describe("findPackageRootPath", () => {
  test("resolves from a source layout", () => {
    const fixture = createPackage("src/platform/filesystem");
    expect(findPackageRootPath(fixture.entry)).toBe(fixture.root);
  });

  test("resolves from a deeply nested compiled layout", () => {
    const fixture = createPackage("dist/apps/sandbox/internal/deep");
    expect(findPackageRootPath(fixture.entry)).toBe(fixture.root);
  });

  test("resolves from a packed global-style installation", () => {
    const fixture = createPackage(
      "lib/node_modules/@maibornwolff/sandbox/dist/apps",
    );
    expect(findPackageRootPath(fixture.entry)).toBe(fixture.root);
  });

  test("source and packed layouts resolve the same package assets", () => {
    const fixture = createPackage("src/platform/filesystem");
    const packedEntry = path.join(
      fixture.root,
      "dist",
      "apps",
      "sandbox",
      "internal",
      "main.js",
    );
    fs.mkdirSync(path.dirname(packedEntry), { recursive: true });
    fs.writeFileSync(packedEntry, "");
    const asset = path.join("docker", "Dockerfile");

    expect(path.join(findPackageRootPath(fixture.entry), asset)).toBe(
      path.join(findPackageRootPath(packedEntry), asset),
    );
  });

  test("accepts Windows path separators", () => {
    const fixture = createPackage("dist/apps/sandbox");
    expect(findPackageRootPath(fixture.entry.replaceAll("/", "\\"))).toBe(
      fixture.root,
    );
  });

  test("reports the start location when no package root exists", () => {
    const root = createTestDir("missing-package-root");
    directories.push(root);
    const entry = path.join(root, "nested", "main.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");

    expect(() =>
      findPackageRootPath(entry, { packageName: "@example/missing" }),
    ).toThrow(`Could not find package root for @example/missing from ${entry}`);
  });
});
