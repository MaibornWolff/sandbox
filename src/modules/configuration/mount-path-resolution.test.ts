import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { runWithConfigurationTestScope } from "./__test__/index.js";
import {
  resolveExistingMounts as resolveExistingMountsInScope,
  resolveMount as resolveMountInScope,
} from "./mount-path-resolution.js";

const resolveMount: typeof resolveMountInScope = (...args) =>
  runWithConfigurationTestScope(() => resolveMountInScope(...args));
const resolveExistingMounts: typeof resolveExistingMountsInScope = (...args) =>
  runWithConfigurationTestScope(() => resolveExistingMountsInScope(...args));

const CONTAINER_HOME = "/home/sandbox";
const projectDir = "/test/project";

describe("resolveMount", () => {
  describe("global config or CLI (isProjectConfig=false)", () => {
    test("resolves absolute path", async () => {
      const result = resolveMount("/tmp", projectDir, false);
      expect(result).toContain("/tmp:/tmp:ro");
    });

    test("resolves relative path to absolute", async () => {
      const result = resolveMount("./data", projectDir, false);
      expect(result).toContain(":ro");
      expect(result.startsWith("/")).toBe(true);
    });

    test("preserves mount mode when specified", async () => {
      const result = resolveMount("/src:/dst:rw", projectDir, false);
      expect(result).toBe("/src:/dst:rw");
    });

    describe("Windows absolute paths", () => {
      test("handles Windows path with forward slashes (C:/Users/...)", () => {
        const result = resolveMount("C:/Users/foo/.npmrc", projectDir, false);
        expect(result).toBe("C:/Users/foo/.npmrc:/mnt/c/Users/foo/.npmrc:ro");
      });

      test("handles Windows path with backslashes (C:\\Users\\...)", () => {
        const result = resolveMount(
          "C:\\Users\\foo\\.npmrc",
          projectDir,
          false,
        );
        expect(result).toBe(
          "C:\\Users\\foo\\.npmrc:/mnt/c/Users/foo/.npmrc:ro",
        );
      });

      test("handles Windows path with destination and mode", () => {
        const result = resolveMount(
          "C:/Users/foo/.npmrc:/home/sandbox/.npmrc:ro",
          projectDir,
          false,
        );
        expect(result).toBe("C:/Users/foo/.npmrc:/home/sandbox/.npmrc:ro");
      });

      test("handles Windows path on different drive", () => {
        const result = resolveMount("D:/data", projectDir, false);
        expect(result).toBe("D:/data:/mnt/d/data:ro");
      });
    });
  });

  describe("tilde expansion", () => {
    const hostHome = "/home/test";

    test("shorthand ~ expands host to homedir and container to /home/sandbox", () => {
      // This is the key test: shorthand should expand container side to /home/sandbox
      const result = resolveMount("~/.npmrc", projectDir, false);
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc:ro`);
    });

    test("expands ~ on host side to user home directory", () => {
      const result = resolveMount("~/.npmrc:~/.npmrc", projectDir, false);
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc:ro`);
    });

    test("expands ~ on container side to /home/sandbox", () => {
      const result = resolveMount("~/.npmrc:~/.npmrc", projectDir, false);
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc:ro`);
    });

    test("expands ~ on both sides with mode", () => {
      const result = resolveMount("~/.npmrc:~/.npmrc:rw", projectDir, false);
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc:rw`);
    });

    test("expands ~ with mode shorthand", () => {
      // Shorthand "~/.config:rw" → "~/.config:~/.config:rw" → both tildes expanded
      const result = resolveMount("~/.config:rw", projectDir, false);
      expect(result).toBe(`${hostHome}/.config:${CONTAINER_HOME}/.config:rw`);
    });

    test("expands host ~ with absolute container path", () => {
      const result = resolveMount("~/.ssh:/root/.ssh:ro", projectDir, false);
      expect(result).toBe(`${hostHome}/.ssh:/root/.ssh:ro`);
    });
  });

  describe("project config (isProjectConfig=true)", () => {
    test("rejects absolute paths outside project", async () => {
      expect(() => resolveMount("/tmp", projectDir, true)).toThrow(
        "Project config cannot mount paths outside project",
      );
    });

    test("rejects tilde paths that expand outside project", async () => {
      expect(() => resolveMount("~/.npmrc", projectDir, true)).toThrow(
        "Project config cannot mount paths outside project",
      );
    });

    test("rejects Windows absolute paths outside project (C:/Users/...)", () => {
      expect(() =>
        resolveMount("C:/Users/foo/.npmrc", projectDir, true),
      ).toThrow("Project config cannot mount paths outside project");
    });

    test("rejects Windows absolute paths outside project (C:\\Users\\...)", () => {
      expect(() =>
        resolveMount("C:\\Users\\foo\\.npmrc", projectDir, true),
      ).toThrow("Project config cannot mount paths outside project");
    });

    test("accepts absolute path within project directory", () => {
      const testDir = createTestDir("resolver-abs-within-project");
      try {
        const subdir = path.join(testDir, "data");
        fs.mkdirSync(subdir, { recursive: true });
        const result = resolveMount(`${subdir}:/container:ro`, testDir, true);
        expect(result).toBe(`${subdir}:/container:ro`);
      } finally {
        cleanupTestDir(testDir);
      }
    });

    test("resolves relative path to project directory", async () => {
      const result = resolveMount("./data", projectDir, true);
      expect(result).toContain(path.join(projectDir, "data"));
      expect(result).toContain(":ro");
    });

    test("handles destination and mode", async () => {
      const result = resolveMount("./src:/dest:rw", projectDir, true);
      expect(result).toContain(path.join(projectDir, "src"));
      expect(result).toContain(":/dest:rw");
    });

    describe("path traversal security", () => {
      test("rejects sibling directory traversal (../sibling)", async () => {
        expect(() => resolveMount("../sibling", projectDir, true)).toThrow(
          "Project config cannot mount paths outside project",
        );
      });

      test("rejects parent directory traversal (../../parent)", async () => {
        expect(() => resolveMount("../../parent", projectDir, true)).toThrow(
          "Project config cannot mount paths outside project",
        );
      });

      test("rejects deep parent traversal (../../../escape)", async () => {
        expect(() => resolveMount("../../../escape", projectDir, true)).toThrow(
          "Project config cannot mount paths outside project",
        );
      });

      test("accepts subdirectory paths (./sub)", async () => {
        const result = resolveMount("./sub", projectDir, true);
        expect(result).toContain(path.join(projectDir, "sub"));
      });

      test("accepts nested subdirectory paths (./sub/nested)", async () => {
        const result = resolveMount("./sub/nested", projectDir, true);
        expect(result).toContain(path.join(projectDir, "sub", "nested"));
      });

      test("accepts current directory (.)", async () => {
        const result = resolveMount(".", projectDir, true);
        expect(result).toContain(projectDir);
      });

      test("rejects traversal with destination mapping", async () => {
        expect(() =>
          resolveMount("../../parent:/dest", projectDir, true),
        ).toThrow("Project config cannot mount paths outside project");
      });

      test("rejects path traversal with forward-slash project dir", () => {
        // Simulates projectDir from getRepoRootPath (always forward slashes after fix)
        expect(() =>
          resolveMount("../escape", "C:/Users/test/project", true),
        ).toThrow("Project config cannot mount paths outside project");
      });
    });
  });
});

describe("symlink resolution", () => {
  test("global config: resolves symlink to directory to real path", () => {
    const testDir = createTestDir("symlink-dir-global");
    try {
      const realDir = path.join(testDir, "real");
      const linkDir = path.join(testDir, "link");
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, linkDir);

      const result = resolveMount(
        `${linkDir}:/container:ro`,
        projectDir,
        false,
      );
      expect(result).toBe(`${realDir}:/container:ro`);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("global config: resolves symlink to file to real path", () => {
    const testDir = createTestDir("symlink-file-global");
    try {
      const realFile = path.join(testDir, "real.txt");
      const linkFile = path.join(testDir, "link.txt");
      fs.writeFileSync(realFile, "");
      fs.symlinkSync(realFile, linkFile);

      const result = resolveMount(
        `${linkFile}:/container/file.txt:ro`,
        projectDir,
        false,
      );
      expect(result).toBe(`${realFile}:/container/file.txt:ro`);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("global config: broken symlink is filtered out by resolveExistingMounts", () => {
    const testDir = createTestDir("symlink-broken-global");
    try {
      const linkFile = path.join(testDir, "broken.txt");
      fs.symlinkSync("/nonexistent/target", linkFile);

      const result = resolveExistingMounts(
        [`${linkFile}:/container:ro`],
        projectDir,
        false,
      );
      expect(result).toHaveLength(0);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("project config: resolves symlink to directory to real path", () => {
    const testDir = createTestDir("symlink-dir-project");
    try {
      const realDir = path.join(testDir, "real");
      const linkDir = path.join(testDir, "link");
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, linkDir);

      const result = resolveMount("./link:/container:ro", testDir, true);
      expect(result).toBe(`${realDir}:/container:ro`);
    } finally {
      cleanupTestDir(testDir);
    }
  });

  test("project config: broken symlink is filtered out by resolveExistingMounts", () => {
    const testDir = createTestDir("symlink-broken-project");
    try {
      const linkFile = path.join(testDir, "broken.txt");
      fs.symlinkSync("/nonexistent/target", linkFile);

      const result = resolveExistingMounts(
        ["./broken.txt:/container:ro"],
        testDir,
        true,
      );
      expect(result).toHaveLength(0);
    } finally {
      cleanupTestDir(testDir);
    }
  });
});

describe("resolveExistingMounts", () => {
  const tmpDir = os.tmpdir();

  test("resolves multiple valid mounts", () => {
    const mounts = [`${tmpDir}:/container1:ro`, `${tmpDir}:/container2:rw`];
    const result = resolveExistingMounts(mounts, projectDir, false);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain(tmpDir);
    expect(result[1]).toContain(tmpDir);
  });

  test("returns empty array when all mounts are invalid", () => {
    const mounts = [
      "/nonexistent1:/path:ro",
      "/nonexistent2:/path:ro",
      "~/.nonexistent-67890:/path:ro",
    ];
    const result = resolveExistingMounts(mounts, projectDir, false);

    expect(result).toHaveLength(0);
  });

  test("handles mixed valid and invalid mounts", () => {
    const mounts = [
      "/nonexistent:/bad:ro",
      `${tmpDir}:/good1:ro`,
      "/also-nonexistent:/bad:ro",
      `${tmpDir}:/good2:rw`,
    ];
    const result = resolveExistingMounts(mounts, projectDir, false);

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.includes(tmpDir))).toBe(true);
  });

  test("works with project config paths", () => {
    const testDir = createTestDir("resolve-all-project");
    try {
      fs.mkdirSync(path.join(testDir, "data"), { recursive: true });
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });

      const mounts = ["./data", "./src", "./nonexistent"];
      const result = resolveExistingMounts(mounts, testDir, true);

      // Only data and src should be resolved
      expect(result).toHaveLength(2);
      expect(result[0]).toContain("data");
      expect(result[1]).toContain("src");
    } finally {
      cleanupTestDir(testDir);
    }
  });
});
