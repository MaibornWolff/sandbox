import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createTestSandboxEnvironment } from "#platform/environment/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { applyContainerStartSettings } from "./container-start-settings.js";

function createFixture(copyPaths: readonly string[]) {
  const root = createTestDir("settings-copy");
  const homeDirectory = path.join(root, "home", "sandbox");
  const settingsDirectory = path.join(root, "etc", "sandbox", "settings");
  fs.mkdirSync(homeDirectory, { recursive: true });
  fs.mkdirSync(settingsDirectory, { recursive: true });
  const environment = createTestSandboxEnvironment({
    filesystemRoot: root,
    homeDirectory,
    variables: {
      SANDBOX_SETTINGS: JSON.stringify({ mountPaths: [], copyPaths }),
    },
    platform: "linux",
  });
  return {
    root,
    homeDirectory,
    settingsDirectory,
    run: () =>
      runWithTestLogger(() => environment.run(applyContainerStartSettings), {
        homeDirectory: homeDirectory,
      }),
  };
}

describe("applyContainerStartSettings", () => {
  test("replaces a file from the host source on every application", async () => {
    const fixture = createFixture([".codex/config.toml"]);
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(fixture.root));
    const source = path.join(
      fixture.settingsDirectory,
      ".codex",
      "config.toml",
    );
    const destination = path.join(
      fixture.homeDirectory,
      ".codex",
      "config.toml",
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(source, "host");
    fs.writeFileSync(destination, "sandbox");

    await fixture.run();

    expect(fs.readFileSync(destination, "utf8")).toBe("host");
    fs.renameSync(destination, `${destination}.old`);
    fs.writeFileSync(destination, "changed");
    await fixture.run();
    expect(fs.readFileSync(destination, "utf8")).toBe("host");
    expect(fs.readFileSync(source, "utf8")).toBe("host");
  });

  test("replaces complete directories and follows source links", async () => {
    const fixture = createFixture(["tool/config/"]);
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(fixture.root));
    const source = path.join(fixture.settingsDirectory, "tool", "config");
    const destination = path.join(fixture.homeDirectory, "tool", "config");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, "host.txt"), "host");
    fs.writeFileSync(path.join(destination, "stale.txt"), "stale");
    fs.symlinkSync("host.txt", path.join(source, "linked.txt"));

    await fixture.run();

    expect(fs.existsSync(path.join(destination, "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "linked.txt"), "utf8")).toBe(
      "host",
    );
    expect(fs.lstatSync(path.join(destination, "linked.txt")).isFile()).toBe(
      true,
    );
  });

  test("applies existing sources and skips missing sources", async () => {
    const fixture = createFixture([
      ".codex/config.toml",
      ".missing/config.toml",
    ]);
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(fixture.root));
    const source = path.join(
      fixture.settingsDirectory,
      ".codex",
      "config.toml",
    );
    const destination = path.join(
      fixture.homeDirectory,
      ".codex",
      "config.toml",
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(source, "host");
    fs.writeFileSync(destination, "stale");

    await fixture.run();

    expect(fs.readFileSync(destination, "utf8")).toBe("host");
    expect(
      fs.existsSync(
        path.join(fixture.homeDirectory, ".missing", "config.toml"),
      ),
    ).toBe(false);
  });
});
