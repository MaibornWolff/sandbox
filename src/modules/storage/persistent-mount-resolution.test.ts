import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  cleanupTestDir,
  createPersistPath,
  createTestDir,
} from "#test/utils.js";
import {
  getGlobalPersistDir as getGlobalPersistDirWithoutScope,
  getProjectPersistDir as getProjectPersistDirWithoutScope,
} from "./persistence-paths.js";
import { getPersistentMounts as getPersistentMountsWithoutScope } from "./persistent-mount-resolution.js";

const defaultScopeRoot = createTestDir("persistent-mount-scope");
let testDataHome = path.join(defaultScopeRoot, "data");
let testHome = path.join(defaultScopeRoot, "home");
fs.mkdirSync(testDataHome, { recursive: true });
fs.mkdirSync(testHome, { recursive: true });
afterAll(() => cleanupTestDir(defaultScopeRoot));

function inStorageScope<T>(callback: () => T): T {
  return runWithTestLogger(callback, {
    variables: { XDG_DATA_HOME: testDataHome },
    homeDirectory: testHome,
  });
}

function getGlobalPersistDir(): string {
  return inStorageScope(getGlobalPersistDirWithoutScope);
}

function getProjectPersistDir(projectRoot: string): string {
  return inStorageScope(() => getProjectPersistDirWithoutScope(projectRoot));
}

function getPersistentMounts(
  ...args: Parameters<typeof getPersistentMountsWithoutScope>
): ReturnType<typeof getPersistentMountsWithoutScope> {
  return inStorageScope(() => getPersistentMountsWithoutScope(...args));
}

const projectPath = process.cwd();
const CONTAINER_HOME = "/home/sandbox";

describe("owned persistence paths", () => {
  test("returns the global persistence directory", () => {
    expect(getGlobalPersistDir()).toEndWith(path.join("sandbox", "global"));
  });

  test("returns the project persistence directory", () => {
    expect(getProjectPersistDir("/example/project")).toMatch(
      /sandbox[/\\]example-project-[a-f0-9]{4}$/u,
    );
  });
});

describe("getPersistentMounts", () => {
  test("returns empty when no persist paths configured", async () => {
    const result = await getPersistentMounts(projectPath, []);
    expect(result.mounts).toHaveLength(0);
  });

  test("returns mount for home-relative path", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(
      `${CONTAINER_HOME}/.local/state`,
    );
    expect(result.mounts[0]?.mode).toBe("rw");
  });

  test("returns mount for dotfile path", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.claude"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(`${CONTAINER_HOME}/.claude`);
  });

  test("returns multiple mounts for multiple paths", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
      createPersistPath("~/.claude"),
      createPersistPath("~/.codex"),
    ]);
    expect(result.mounts).toHaveLength(3);
  });

  test("host path for project includes project slug", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
    ]);
    expect(result.mounts[0]?.hostPath).toContain("sandbox/");
  });

  test("host path for global uses global directory", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.credentials", { global: true }),
    ]);
    expect(result.mounts[0]?.hostPath).toContain("sandbox/global");
  });

  test("skips entries with useNamedVolume (mounted as named volumes instead)", async () => {
    const result = await getPersistentMounts(projectPath, [
      {
        path: `${CONTAINER_HOME}/.cache/composer`,
        global: false,
        onlyIfExists: false,
        useNamedVolume: "composer-cache",
      },
      createPersistPath("~/.local/state"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(
      `${CONTAINER_HOME}/.local/state`,
    );
  });

  test("returns separate mounts for global and project paths", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
      createPersistPath("~/.credentials", { global: true }),
    ]);
    expect(result.mounts).toHaveLength(2);

    const globalMount = result.mounts.find((m) =>
      m.hostPath.includes("sandbox/global"),
    );
    const projectMount = result.mounts.find(
      (m) => !m.hostPath.includes("sandbox/global"),
    );

    expect(globalMount).toBeDefined();
    expect(projectMount).toBeDefined();
  });
});

describe("path resolution", () => {
  test("home-relative paths resolve to container home", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
    ]);
    expect(result.mounts[0]?.containerPath).toBe(
      `${CONTAINER_HOME}/.local/state`,
    );
  });

  test("project-relative paths resolve to the project root", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("./node_modules"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(`${projectPath}/node_modules`);
    expect(result.mounts[0]?.hostPath).toContain("workdir/node_modules");
  });

  test("absolute paths under container home resolve correctly", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath(`${CONTAINER_HOME}/.config`),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(`${CONTAINER_HOME}/.config`);
  });

  test("skips invalid paths", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~"), // Can't persist entire home
      createPersistPath("/tmp/outside"), // Outside container home
      createPersistPath(".claude"), // Bare path (invalid format)
      createPersistPath("node_modules"), // Bare path (invalid format)
    ]);
    expect(result.mounts).toHaveLength(0);
  });

  test("skips /nix even with global = true (bind-mounting over /nix would shadow the image-installed Nix store)", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("/nix", { global: true }),
    ]);
    expect(result.mounts).toHaveLength(0);
  });
});

describe("onlyIfExists behavior", () => {
  let testDir: string;
  let testProjectPath: string;

  beforeEach(() => {
    testDir = createTestDir("persist-test");
    testProjectPath = path.join(testDir, "project");
    fs.mkdirSync(testProjectPath, { recursive: true });
    testDataHome = testDir;
    testHome = path.join(testDir, "home");
    fs.mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("creates mount when onlyIfExists=false (default)", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("~/.test-persist"),
    ]);
    expect(result.mounts).toHaveLength(1);
  });

  test("skips mount when onlyIfExists=true and home path does not exist", async () => {
    // ~/.nonexistent-sandbox-test does not exist on the actual host home
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("~/.nonexistent-sandbox-test-abc123", {
        onlyIfExists: true,
      }),
    ]);
    expect(result.mounts).toHaveLength(0);
  });

  test("creates mount when onlyIfExists=true and home path exists", async () => {
    const homePath = path.join(testHome, ".sandbox-test-existing-abc123");
    fs.mkdirSync(homePath, { recursive: true });

    try {
      const result = await getPersistentMounts(testProjectPath, [
        createPersistPath("~/.sandbox-test-existing-abc123", {
          global: true,
          onlyIfExists: true,
        }),
      ]);
      expect(result.mounts).toHaveLength(1);
    } finally {
      fs.rmSync(homePath, { recursive: true, force: true });
    }
  });

  test("skips mount when onlyIfExists=true and project-relative path does not exist", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./node_modules", { onlyIfExists: true }),
    ]);
    expect(result.mounts).toHaveLength(0);
  });

  test("creates mount when onlyIfExists=true and project-relative path exists", async () => {
    // Create node_modules in the test project directory
    fs.mkdirSync(path.join(testProjectPath, "node_modules"), {
      recursive: true,
    });

    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./node_modules", { onlyIfExists: true }),
    ]);
    expect(result.mounts).toHaveLength(1);
  });
});

describe("default content", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir("persist-test");
    testDataHome = testDir;
    testHome = path.join(testDir, "home");
    fs.mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("creates file with default content when provided", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.config.json", { global: true, default: "{}" }),
    ]);
    expect(result.mounts).toHaveLength(1);

    // Check that file was created with content
    const createdPath = result.mounts[0]?.hostPath;
    if (!createdPath) throw new Error("Expected mount hostPath to be defined");
    expect(fs.existsSync(createdPath)).toBe(true);
    expect(fs.readFileSync(createdPath, "utf-8")).toBe("{}");
  });

  test("creates directory when no default content", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.test-dir", { global: true }),
    ]);
    expect(result.mounts).toHaveLength(1);

    // Check that directory was created
    const createdPath = result.mounts[0]?.hostPath;
    if (!createdPath) throw new Error("Expected mount hostPath to be defined");
    expect(fs.existsSync(createdPath)).toBe(true);
    expect(fs.statSync(createdPath).isDirectory()).toBe(true);
  });

  test("does not overwrite existing content", async () => {
    // Pre-create the file with different content
    const globalDir = path.join(testDir, "sandbox", "global");
    const filePath = path.join(globalDir, ".existing.json");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(filePath, '{"existing": true}');

    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.existing.json", {
        global: true,
        default: '{"new": true}',
      }),
    ]);
    expect(result.mounts).toHaveLength(1);

    // Check that original content was preserved
    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"existing": true}');
  });
});

describe("consistent paths", () => {
  test("multiple calls return same host path for same project", async () => {
    const result1 = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
    ]);
    const result2 = await getPersistentMounts(projectPath, [
      createPersistPath("~/.local/state"),
    ]);
    expect(result1.mounts[0]?.hostPath).toBe(result2.mounts[0]?.hostPath);
  });
});

describe("Windows path handling", () => {
  test("project-relative paths resolve with a Windows project root", async () => {
    const result = await getPersistentMounts("C:\\Users\\testuser\\project", [
      createPersistPath("./node_modules"),
    ]);
    expect(result.mounts).toHaveLength(1);
    // Container path must be POSIX format, not Windows
    expect(result.mounts[0]?.containerPath).toBe(
      "/mnt/c/Users/testuser/project/node_modules",
    );
  });

  test("project-relative paths resolve with a forward-slash Windows project root", async () => {
    const result = await getPersistentMounts("C:/Users/testuser/project", [
      createPersistPath("./src"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(
      "/mnt/c/Users/testuser/project/src",
    );
  });
});

describe("deduplication", () => {
  test("duplicate containerPaths produce only one mount", async () => {
    const result = await getPersistentMounts(projectPath, [
      createPersistPath("~/.claude"),
      createPersistPath("~/.claude"),
    ]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.containerPath).toBe(`${CONTAINER_HOME}/.claude`);
  });
});

describe("glob patterns", () => {
  let testDir: string;
  let testProjectPath: string;

  beforeEach(() => {
    testDir = createTestDir("glob-persist");
    testProjectPath = path.join(testDir, "project");
    // Create test project structure with multiple node_modules
    fs.mkdirSync(path.join(testProjectPath, "apps/web/node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testProjectPath, "apps/api/node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testProjectPath, "packages/ui/node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testProjectPath, ".git"), { recursive: true });
    testDataHome = testDir;
    testHome = path.join(testDir, "home");
    fs.mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("glob pattern creates mount for each match", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/node_modules"),
    ]);

    expect(result.mounts.length).toBe(3);
    expect(result.mounts.map((m) => m.containerPath)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("apps/web/node_modules"),
        expect.stringContaining("apps/api/node_modules"),
        expect.stringContaining("packages/ui/node_modules"),
      ]),
    );
  });

  test("glob matches resolve relative to the project root", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/node_modules"),
    ]);

    expect(result.mounts.map((mount) => mount.containerPath)).toContain(
      path.join(testProjectPath, "apps", "web", "node_modules"),
    );
  });

  test("each mount has correct storage path", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/node_modules"),
    ]);

    for (const mount of result.mounts) {
      // Host path should be under sandbox data dir
      expect(mount.hostPath).toContain("sandbox");
      expect(mount.hostPath).toContain("workdir");
      // Should be read-write
      expect(mount.mode).toBe("rw");
    }
  });

  test("mixed literal and glob paths work together", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("~/.claude"),
      createPersistPath("./**/node_modules"),
    ]);

    // 1 literal + 3 glob matches
    expect(result.mounts.length).toBe(4);
    expect(result.mounts.some((m) => m.containerPath.includes(".claude"))).toBe(
      true,
    );
  });

  test("glob with no matches produces no mounts", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/nonexistent"),
    ]);

    expect(result.mounts).toEqual([]);
  });

  test("glob does not match .git directory contents", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/*"),
    ]);

    expect(result.mounts.every((m) => !m.containerPath.includes(".git/"))).toBe(
      true,
    );
  });

  test("glob pattern with single level wildcard", async () => {
    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./apps/*/node_modules"),
    ]);

    expect(result.mounts.length).toBe(2);
    expect(result.mounts.map((m) => m.containerPath)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("apps/web/node_modules"),
        expect.stringContaining("apps/api/node_modules"),
      ]),
    );
    // Should NOT include packages/ui/node_modules
    expect(
      result.mounts.some((m) => m.containerPath.includes("packages/ui")),
    ).toBe(false);
  });

  test("glob does not match paths inside sandbox data directory", async () => {
    // Simulate the Windows bug: sandbox data dir is under the project root.
    // XDG_DATA_HOME is already set to testDir in beforeEach, so sandbox data
    // lives at testDir/sandbox/... which is OUTSIDE testProjectPath.
    // To reproduce the bug, keep the scoped data dir inside the project.
    testDataHome = path.join(testProjectPath, ".local", "share");

    // Create a .venv inside sandbox persist storage (from another project)
    const sandboxInternalVenv = path.join(
      testProjectPath,
      ".local",
      "share",
      "sandbox",
      "other-project-abc1",
      "workdir",
      ".venv",
    );
    fs.mkdirSync(sandboxInternalVenv, { recursive: true });

    // Create a real .venv in the actual project
    fs.mkdirSync(path.join(testProjectPath, "myapp", ".venv"), {
      recursive: true,
    });

    const result = await getPersistentMounts(testProjectPath, [
      createPersistPath("./**/.venv"),
    ]);

    // Should only match myapp/.venv, not the one inside sandbox data dir
    expect(result.mounts.length).toBe(1);
    expect(result.mounts[0]?.containerPath).toContain("myapp/.venv");
  });
});
