import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createContainerSettingsSetup } from "./container-settings-setup.js";

function createFixture(name: string) {
  const configDirectory = createTestDir(name);
  const run = (
    entries: Parameters<typeof createContainerSettingsSetup>[0]["entries"],
  ) =>
    runWithTestLogger(
      () => createContainerSettingsSetup({ entries, persistentMounts: [] }),
      {
        variables: { SANDBOX_CONFIG_DIR: configDirectory },
        homeDirectory: "/test/home",
      },
    );
  return { configDirectory, run };
}

describe("createContainerSettingsSetup", () => {
  test("rejects a mount-mode setting that covers a copy destination", async () => {
    const fixture = createFixture("settings-mode-conflict");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(fixture.configDirectory));
    const codexDirectory = path.join(
      fixture.configDirectory,
      "settings",
      ".codex",
    );
    fs.mkdirSync(codexDirectory, { recursive: true });
    fs.writeFileSync(path.join(codexDirectory, "config.toml"), "host");

    await expect(
      fixture.run([
        { path: ".codex/", mode: "mount" },
        { path: ".codex/config.toml", mode: "copy" },
      ]),
    ).rejects.toThrow("mount-mode setting /home/sandbox/.codex");
  });

  test("rejects links that cannot be followed inside the container", async () => {
    const fixture = createFixture("settings-copy-link");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(fixture.configDirectory));
    const sourceDirectory = path.join(
      fixture.configDirectory,
      "settings",
      "tool",
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    const external = path.join(fixture.configDirectory, "external.txt");
    fs.writeFileSync(external, "external");
    fs.symlinkSync(external, path.join(sourceDirectory, "linked.txt"));

    await expect(
      fixture.run([{ path: "tool/", mode: "copy" }]),
    ).rejects.toThrow("symbolic link target must be relative and stay inside");
  });
});
