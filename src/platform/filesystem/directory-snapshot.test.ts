import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { hashDirectoryContents } from "./directory-snapshot.js";

function createHashFixture(name: string): {
  readonly directory: string;
  readonly cleanup: Disposable;
} {
  const directory = createTestDir(name);
  return {
    directory,
    cleanup: {
      [Symbol.dispose]: () => cleanupTestDir(directory),
    },
  };
}

test("hashes relative paths, bytes, and normalized executable modes", () => {
  const first = createHashFixture("directory-hash-first");
  const second = createHashFixture("directory-hash-second");
  using cleanup = new DisposableStack();
  cleanup.use(first.cleanup);
  cleanup.use(second.cleanup);
  for (const directory of [first.directory, second.directory]) {
    mkdirSync(path.join(directory, "bin"));
    writeFileSync(path.join(directory, "z.json"), '{"version":"1.0.0"}');
    writeFileSync(path.join(directory, "bin", "tool"), "console.log('a')");
  }

  expect(hashDirectoryContents(second.directory)).toBe(
    hashDirectoryContents(first.directory),
  );
  writeFileSync(path.join(second.directory, "z.json"), '{"version":"1.0.1"}');
  expect(hashDirectoryContents(second.directory)).not.toBe(
    hashDirectoryContents(first.directory),
  );
  writeFileSync(path.join(second.directory, "z.json"), '{"version":"1.0.0"}');
  chmodSync(path.join(second.directory, "bin", "tool"), 0o755);
  expect(hashDirectoryContents(second.directory)).not.toBe(
    hashDirectoryContents(first.directory),
  );
});

test("rejects symbolic links instead of reading outside the package", () => {
  const fixture = createHashFixture("directory-hash-link");
  using _cleanup = fixture.cleanup;
  symlinkSync("missing", path.join(fixture.directory, "link"), "file");
  expect(() => hashDirectoryContents(fixture.directory)).toThrow(
    "requires regular files",
  );
});
