import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { getSettingsMounts as getSettingsMountsWithoutScope } from "./settings-mount-resolution.js";
import { getSettingsDir as getSettingsDirWithoutScope } from "./settings-paths.js";
import { cleanStaleSettingsSymlinks as cleanStaleSettingsSymlinksWithoutScope } from "./stale-settings-symlink-cleanup.js";

let scopedConfigDirectory: string | undefined;
let scopedHomeDirectory: string | undefined;

function inSettingsScope<T>(callback: () => T): T {
  return runWithTestLogger(callback, {
    variables: scopedConfigDirectory
      ? { SANDBOX_CONFIG_DIR: scopedConfigDirectory }
      : {},
    homeDirectory: scopedHomeDirectory ?? "/test/home",
  });
}

function getSettingsDir(): string {
  return inSettingsScope(getSettingsDirWithoutScope);
}

function getSettingsMounts(
  ...args: Parameters<typeof getSettingsMountsWithoutScope>
): ReturnType<typeof getSettingsMountsWithoutScope> {
  return inSettingsScope(() => getSettingsMountsWithoutScope(...args));
}

function cleanStaleSettingsSymlinks(
  ...args: Parameters<typeof cleanStaleSettingsSymlinksWithoutScope>
): ReturnType<typeof cleanStaleSettingsSymlinksWithoutScope> {
  return inSettingsScope(() => cleanStaleSettingsSymlinksWithoutScope(...args));
}

describe("getSettingsDir", () => {
  test("returns correct settings directory path", () => {
    const result = getSettingsDir();

    // Should contain .config/sandbox/settings
    expect(result).toContain(".config");
    expect(result).toContain("sandbox");
    expect(result).toContain("settings");
    // Should be absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe("getSettingsMounts with patterns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTestDir("settings-mounts");
    scopedConfigDirectory = tmpDir;
    await fs.mkdir(path.join(tmpDir, "settings", ".claude", "skills"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpDir, "settings", ".config", "opencode"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpDir, "settings", ".claude", "settings.json"),
      "{}",
    );
    await fs.writeFile(
      path.join(tmpDir, "settings", ".claude", "skills", "s1.md"),
      "# Skill",
    );
    await fs.writeFile(
      path.join(tmpDir, "settings", ".config", "opencode", "config.yaml"),
      "key: val",
    );
  });

  afterEach(async () => {
    scopedConfigDirectory = undefined;
    cleanupTestDir(tmpDir);
  });

  test("includes base /etc/sandbox/settings mount plus pattern mounts", async () => {
    const mounts = await getSettingsMounts([".claude/settings.json"]);

    // Base mount always present
    const basMount = mounts.find(
      (m) => m.containerPath === "/etc/sandbox/settings",
    );
    expect(basMount).toBeDefined();

    // Pattern mount resolved
    const patternMount = mounts.find(
      (m) => m.containerPath === "/home/sandbox/.claude/settings.json",
    );
    expect(patternMount).toBeDefined();
    expect(patternMount?.mode).toBe("rw");
  });

  test("resolves glob patterns through full pipeline", async () => {
    const mounts = await getSettingsMounts([".config/opencode/*"]);

    const patternMounts = mounts.filter((m) =>
      m.containerPath.startsWith("/home/sandbox/"),
    );
    expect(patternMounts).toHaveLength(1);
    expect(patternMounts[0]?.containerPath).toBe(
      "/home/sandbox/.config/opencode/config.yaml",
    );
  });

  test("resolves directory patterns through full pipeline", async () => {
    const mounts = await getSettingsMounts([".claude/skills/"]);

    const patternMounts = mounts.filter((m) =>
      m.containerPath.startsWith("/home/sandbox/"),
    );
    expect(patternMounts).toHaveLength(1);
    expect(patternMounts[0]?.containerPath).toBe(
      "/home/sandbox/.claude/skills",
    );
  });

  test("applies exclusion patterns", async () => {
    const mounts = await getSettingsMounts([
      ".claude/settings.json",
      ".claude/skills/",
      "!.claude/skills",
    ]);

    const patternMounts = mounts.filter((m) =>
      m.containerPath.startsWith("/home/sandbox/"),
    );
    expect(patternMounts).toHaveLength(1);
    expect(patternMounts[0]?.containerPath).toBe(
      "/home/sandbox/.claude/settings.json",
    );
  });

  test("returns only base mount when no patterns provided", async () => {
    const mounts = await getSettingsMounts([]);

    const patternMounts = mounts.filter((m) =>
      m.containerPath.startsWith("/home/sandbox/"),
    );
    expect(patternMounts).toHaveLength(0);

    const baseMount = mounts.find(
      (m) => m.containerPath === "/etc/sandbox/settings",
    );
    expect(baseMount).toBeDefined();
  });
});

describe("getSettingsMounts with symbolic links", () => {
  let homeDirectory: string;
  let settingsDirectory: string;
  let outsideDirectory: string;

  function homeMounts(mounts: Awaited<ReturnType<typeof getSettingsMounts>>) {
    return mounts.filter((mount) =>
      mount.containerPath.startsWith("/home/sandbox/"),
    );
  }

  beforeEach(async () => {
    homeDirectory = await fs.realpath(createTestDir("settings-links"));
    scopedHomeDirectory = homeDirectory;
    scopedConfigDirectory = path.join(homeDirectory, ".config", "sandbox");
    settingsDirectory = path.join(scopedConfigDirectory, "settings");
    outsideDirectory = path.join(homeDirectory, ".config", "claude");
    await fs.mkdir(settingsDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "settings.json"), "{}");
    await fs.writeFile(path.join(outsideDirectory, "other.json"), "{}");
  });

  afterEach(() => {
    scopedConfigDirectory = undefined;
    scopedHomeDirectory = undefined;
    cleanupTestDir(homeDirectory);
  });

  async function getErrorMessage(patterns: string[]): Promise<string> {
    const error = await getSettingsMounts(patterns).catch(
      (caught: unknown) => caught,
    );
    return stripVTControlCharacters(String(error));
  }

  test("rejects a relative link that leaves the settings directory", async () => {
    await fs.symlink("../../claude", path.join(settingsDirectory, ".claude"));

    const message = await getErrorMessage([".claude/"]);

    expect(message).toContain(
      "settings links point outside the settings directory",
    );
    expect(message).toContain(
      "~/.claude/  link ~/.config/sandbox/settings/.claude -> ../../claude",
    );
    expect(message).toContain('"~/.config/claude:~/.claude:rw",');
  });

  test("suggests the entry path for an absolute intermediate link", async () => {
    await fs.symlink(outsideDirectory, path.join(settingsDirectory, ".claude"));

    const message = await getErrorMessage([".claude/settings.json"]);

    expect(message).toContain(
      "~/.claude/settings.json  link ~/.config/sandbox/settings/.claude -> ~/.config/claude",
    );
    expect(message).toContain(
      '"~/.config/claude/settings.json:~/.claude/settings.json:rw",',
    );
  });

  test("suggests the static glob base below the link", async () => {
    await fs.mkdir(path.join(outsideDirectory, "agent"));
    await fs.writeFile(path.join(outsideDirectory, "agent", "a.md"), "a");
    await fs.writeFile(path.join(outsideDirectory, "agent", "b.md"), "b");
    await fs.symlink(outsideDirectory, path.join(settingsDirectory, ".claude"));

    const message = await getErrorMessage([".claude/agent/*"]);

    expect(message.match(/ link /g)).toHaveLength(1);
    expect(message).toContain('"~/.config/claude/agent:~/.claude/agent:rw",');
  });

  test("does not traverse linked directories in recursive globs", async () => {
    await fs.symlink(outsideDirectory, path.join(settingsDirectory, ".claude"));

    const mounts = await getSettingsMounts(["**/settings.json"]);

    expect(homeMounts(mounts)).toEqual([]);
  });

  test.each([".claude/*", ".claude/**", "*"])(
    "rejects glob %s through a linked directory",
    async (pattern) => {
      await fs.symlink(
        outsideDirectory,
        path.join(settingsDirectory, ".claude"),
      );

      const message = await getErrorMessage([pattern]);

      expect(message.match(/ link /g)).toHaveLength(1);
      expect(
        message.match(/"~\/\.config\/claude:~\/\.claude:rw"/g),
      ).toHaveLength(1);
    },
  );

  test("reports all rejected entries in one error", async () => {
    const codexDirectory = await fs.realpath(createTestDir("codex-config"));
    await fs.symlink(outsideDirectory, path.join(settingsDirectory, ".claude"));
    await fs.symlink(codexDirectory, path.join(settingsDirectory, ".codex"));
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(codexDirectory));

    const message = await getErrorMessage([
      ".claude/settings.json",
      ".claude/other.json",
      ".codex",
    ]);

    expect(message.match(/ link /g)).toHaveLength(3);
    expect(message).toContain(
      `~/.codex                 link ~/.config/sandbox/settings/.codex -> ${codexDirectory}`,
    );
    expect(message).toContain(
      [
        '     "~/.config/claude/settings.json:~/.claude/settings.json:rw",',
        '     "~/.config/claude/other.json:~/.claude/other.json:rw",',
        `     ${JSON.stringify(`${codexDirectory}:~/.codex:rw`)},`,
      ].join("\n"),
    );
    expect(message).toContain('"settings" in ~/.config/sandbox/config.toml');
  });

  test("mounts settings through a linked settings directory", async () => {
    const realSettings = path.join(homeDirectory, "real-settings");
    await fs.rename(settingsDirectory, realSettings);
    await fs.mkdir(path.join(realSettings, ".claude"));
    await fs.symlink(realSettings, settingsDirectory);

    const mounts = await getSettingsMounts([".claude/"]);

    expect(homeMounts(mounts)).toEqual([
      {
        hostPath: path.join(realSettings, ".claude"),
        containerPath: "/home/sandbox/.claude",
        mode: "rw",
      },
    ]);
  });

  test("mounts links that stay inside the settings directory", async () => {
    await fs.mkdir(path.join(settingsDirectory, "shared", "claude"), {
      recursive: true,
    });
    await fs.symlink(
      path.join("shared", "claude"),
      path.join(settingsDirectory, ".claude"),
    );

    const mounts = await getSettingsMounts([".claude/"]);

    expect(homeMounts(mounts)).toEqual([
      {
        hostPath: path.join(settingsDirectory, "shared", "claude"),
        containerPath: "/home/sandbox/.claude",
        mode: "rw",
      },
    ]);
  });

  test("mounts a directory that contains an external link", async () => {
    await fs.mkdir(path.join(settingsDirectory, ".claude"));
    await fs.symlink(
      outsideDirectory,
      path.join(settingsDirectory, ".claude", "linked"),
    );

    const mounts = await getSettingsMounts([".claude/"]);

    expect(homeMounts(mounts)).toEqual([
      {
        hostPath: path.join(settingsDirectory, ".claude"),
        containerPath: "/home/sandbox/.claude",
        mode: "rw",
      },
    ]);
  });
});

describe("cleanStaleSettingsSymlinks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTestDir("settings-clean");
  });

  afterEach(() => {
    cleanupTestDir(tmpDir);
  });

  test("removes symlinks pointing to /etc/sandbox/settings/", async () => {
    // Simulate a persist volume with stale symlinks
    const persistDir = path.join(tmpDir, ".claude");
    await fs.mkdir(persistDir, { recursive: true });
    await fs.symlink(
      "/etc/sandbox/settings/.claude/agents",
      path.join(persistDir, "agents"),
    );
    await fs.symlink(
      "/etc/sandbox/settings/.claude/settings.json",
      path.join(persistDir, "settings.json"),
    );

    await cleanStaleSettingsSymlinks(
      [
        {
          hostPath: persistDir,
          containerPath: "/home/sandbox/.claude",
          mode: "rw",
        },
      ],
      [".claude/agents/", ".claude/settings.json"],
    );

    // Symlinks should be gone
    const agentsStat = await fs
      .lstat(path.join(persistDir, "agents"))
      .catch(() => null);
    const settingsStat = await fs
      .lstat(path.join(persistDir, "settings.json"))
      .catch(() => null);
    expect(agentsStat).toBeNull();
    expect(settingsStat).toBeNull();
  });

  test("preserves non-stale symlinks", async () => {
    const persistDir = path.join(tmpDir, ".claude");
    await fs.mkdir(persistDir, { recursive: true });
    // Symlink pointing elsewhere — should NOT be removed
    await fs.symlink("/some/other/path", path.join(persistDir, "agents"));

    await cleanStaleSettingsSymlinks(
      [
        {
          hostPath: persistDir,
          containerPath: "/home/sandbox/.claude",
          mode: "rw",
        },
      ],
      [".claude/agents/"],
    );

    const stat = await fs.lstat(path.join(persistDir, "agents"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("preserves regular files and directories", async () => {
    const persistDir = path.join(tmpDir, ".claude");
    await fs.mkdir(path.join(persistDir, "agents"), { recursive: true });
    await fs.writeFile(path.join(persistDir, "settings.json"), "{}");

    await cleanStaleSettingsSymlinks(
      [
        {
          hostPath: persistDir,
          containerPath: "/home/sandbox/.claude",
          mode: "rw",
        },
      ],
      [".claude/agents/", ".claude/settings.json"],
    );

    // Regular dir and file should still exist
    const agentsStat = await fs.stat(path.join(persistDir, "agents"));
    expect(agentsStat.isDirectory()).toBe(true);
    const settingsStat = await fs.stat(path.join(persistDir, "settings.json"));
    expect(settingsStat.isFile()).toBe(true);
  });

  test("skips exclusion patterns and glob patterns", async () => {
    const persistDir = path.join(tmpDir, ".claude");
    await fs.mkdir(persistDir, { recursive: true });
    await fs.symlink(
      "/etc/sandbox/settings/.claude/agents",
      path.join(persistDir, "agents"),
    );

    // Only exclusion and glob patterns — nothing should be cleaned
    await cleanStaleSettingsSymlinks(
      [
        {
          hostPath: persistDir,
          containerPath: "/home/sandbox/.claude",
          mode: "rw",
        },
      ],
      ["!.claude/agents", ".config/opencode/*"],
    );

    const stat = await fs.lstat(path.join(persistDir, "agents"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("handles missing paths gracefully", async () => {
    // Persist dir exists but has no matching entries
    const persistDir = path.join(tmpDir, ".claude");
    await fs.mkdir(persistDir, { recursive: true });

    // Should not throw
    await cleanStaleSettingsSymlinks(
      [
        {
          hostPath: persistDir,
          containerPath: "/home/sandbox/.claude",
          mode: "rw",
        },
      ],
      [".claude/agents/", ".claude/nonexistent"],
    );
  });
});
