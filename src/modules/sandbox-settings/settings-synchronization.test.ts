import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { createTestSandboxEnvironment } from "#platform/environment/__test__/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { parseSettingsManifest } from "./settings-manifest.js";
import { syncNewContainerSettings } from "./settings-synchronization.js";

function setup(
  root: string,
  patterns: readonly string[],
  debug = false,
  copyPaths: readonly string[] = [],
) {
  const terminal = createTestTerminal();
  const homeDirectory = path.join(root, "home", "sandbox");
  const environment = createTestSandboxEnvironment({
    filesystemRoot: root,
    homeDirectory,
    variables: {
      SANDBOX_SETTINGS: JSON.stringify({
        mountPaths: patterns,
        copyPaths,
      }),
      ...(debug ? { SANDBOX_DEBUG: "1" } : {}),
    },
    platform: "linux",
  });
  return {
    terminal,
    homeDirectory,
    settingsDirectory: path.join(root, "etc", "sandbox", "settings"),
    run: () => environment.run(() => terminal.run(syncNewContainerSettings)),
  };
}

describe("settings manifest parsing", () => {
  test("accepts empty and mode-separated values", () => {
    expect(parseSettingsManifest(undefined)).toEqual({
      mountPaths: [],
      copyPaths: [],
    });
    expect(
      parseSettingsManifest(
        '{"mountPaths":[".claude/**"],"copyPaths":[".codex/config.toml"]}',
      ),
    ).toEqual({
      mountPaths: [".claude/**"],
      copyPaths: [".codex/config.toml"],
    });
  });

  test("rejects malformed and invalid manifest values", () => {
    expect(() => parseSettingsManifest("{")).toThrow(
      "Invalid SANDBOX_SETTINGS: expected valid JSON",
    );
    expect(() => parseSettingsManifest('["valid", 1]')).toThrow(
      "Invalid SANDBOX_SETTINGS",
    );
  });
});

describe("syncNewContainerSettings", () => {
  test("copies real literal, directory, recursive, exclusion, and symlink matches", async () => {
    const root = createTestDir("settings-sync");
    const fixture = setup(
      root,
      [
        "literal.json",
        "directory/",
        "glob/**",
        "!glob/excluded.json",
        "linked.json",
      ],
      true,
    );
    try {
      fs.mkdirSync(path.join(fixture.homeDirectory, "directory"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(fixture.homeDirectory, "glob"), {
        recursive: true,
      });
      fs.mkdirSync(fixture.settingsDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(fixture.homeDirectory, "literal.json"),
        "literal",
      );
      fs.writeFileSync(
        path.join(fixture.homeDirectory, "directory", "nested"),
        "nested",
      );
      fs.writeFileSync(
        path.join(fixture.homeDirectory, "glob", "keep.json"),
        "keep",
      );
      fs.writeFileSync(
        path.join(fixture.homeDirectory, "glob", "excluded.json"),
        "excluded",
      );
      const externalFile = path.join(root, "external.json");
      fs.writeFileSync(externalFile, "linked");
      fs.symlinkSync(
        externalFile,
        path.join(fixture.homeDirectory, "linked.json"),
      );

      expect(await fixture.run()).toEqual([
        "literal.json",
        "directory",
        "linked.json",
        "glob/keep.json",
      ]);
      expect(
        fs.readFileSync(
          path.join(fixture.settingsDirectory, "literal.json"),
          "utf8",
        ),
      ).toBe("literal");
      expect(
        fs.existsSync(
          path.join(fixture.settingsDirectory, "glob", "excluded.json"),
        ),
      ).toBe(false);
      expect(
        fs
          .lstatSync(path.join(fixture.settingsDirectory, "linked.json"))
          .isFile(),
      ).toBe(true);
      expect(fixture.terminal.stdout()).toContain(
        "→ Synced ~/literal.json to host\n",
      );
      expect(fixture.terminal.stderr()).toContain(
        "[settings] synced: literal.json\n",
      );
    } finally {
      cleanupTestDir(root);
    }
  });

  test("syncs new home-prefixed matches without overwriting seeded settings", async () => {
    const root = createTestDir("settings-sync-home-pattern");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const fixture = setup(root, ["~/.phase11/**", "!~/.phase11/excluded.txt"]);
    const sourceDirectory = path.join(fixture.homeDirectory, ".phase11");
    const destinationDirectory = path.join(
      fixture.settingsDirectory,
      ".phase11",
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(destinationDirectory, { recursive: true });
    fs.writeFileSync(path.join(destinationDirectory, "seeded.txt"), "seeded");
    fs.writeFileSync(path.join(sourceDirectory, "generated.txt"), "generated");
    fs.writeFileSync(path.join(sourceDirectory, "excluded.txt"), "excluded");

    expect(await fixture.run()).toEqual([".phase11/generated.txt"]);
    expect(
      fs.readFileSync(path.join(destinationDirectory, "generated.txt"), "utf8"),
    ).toBe("generated");
    expect(
      fs.readFileSync(path.join(destinationDirectory, "seeded.txt"), "utf8"),
    ).toBe("seeded");
    expect(fs.existsSync(path.join(destinationDirectory, "excluded.txt"))).toBe(
      false,
    );
  });

  test("does not sync copy-mode paths", async () => {
    const root = createTestDir("settings-sync-copy-exclusion");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const fixture = setup(root, [], false, [".codex/config.toml"]);
    fs.mkdirSync(path.join(fixture.homeDirectory, ".codex"), {
      recursive: true,
    });
    fs.mkdirSync(fixture.settingsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.homeDirectory, ".codex", "config.toml"),
      "container",
    );

    expect(await fixture.run()).toEqual([]);
    expect(
      fs.existsSync(
        path.join(fixture.settingsDirectory, ".codex", "config.toml"),
      ),
    ).toBe(false);
  });

  test("skips absent mounts and existing destinations", async () => {
    const root = createTestDir("settings-sync-skip");
    const fixture = setup(root, ["existing.json"]);
    try {
      fs.mkdirSync(fixture.homeDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(fixture.homeDirectory, "existing.json"),
        "source",
      );
      expect(await fixture.run()).toEqual([]);

      fs.mkdirSync(fixture.settingsDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(fixture.settingsDirectory, "existing.json"),
        "host",
      );
      expect(await fixture.run()).toEqual([]);
      expect(fixture.terminal.stdout()).toBe("");
    } finally {
      cleanupTestDir(root);
    }
  });

  test("reports copy failures to callers and scoped debug output", async () => {
    const root = createTestDir("settings-sync-failure");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const fixture = setup(root, ["blocked/new.json"], true);
    fs.mkdirSync(path.join(fixture.homeDirectory, "blocked"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.homeDirectory, "blocked", "new.json"),
      "new",
    );
    fs.mkdirSync(fixture.settingsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.settingsDirectory, "blocked"),
      "not a directory",
    );

    await expect(fixture.run()).rejects.toThrow(
      "Failed to sync settings:\n- blocked/new.json:",
    );
    expect(fixture.terminal.stdout()).toBe("");
    expect(fixture.terminal.stderr()).toContain(
      "[settings] failed to sync blocked/new.json:",
    );
  });
});
