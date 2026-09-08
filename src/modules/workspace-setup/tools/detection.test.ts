import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { defineCategory } from "./category-definition.js";
import {
  detectProjectCapabilities,
  detectUserCapabilities,
  hasExecutable,
  hasPath,
  resolveProjectDetectorPath,
  resolveUserDetectorPath,
} from "./detection.js";
import type { ToolDefinition } from "./tool-definition.js";

const category = defineCategory({
  id: "detection-test",
  name: "Detection test",
  section: "tools",
  description: "Capabilities used to test detection",
});

function tool(
  id: string,
  detect: ToolDefinition<typeof category>["detect"],
): ToolDefinition<typeof category> {
  return {
    id,
    name: id,
    description: id,
    category,
    detect,
  };
}

function createScopedTestDirectory(prefix: string): {
  path: string;
  [Symbol.dispose](): void;
} {
  const testDirectory = createTestDir(prefix);
  return {
    path: testDirectory,
    [Symbol.dispose]() {
      cleanupTestDir(testDirectory);
    },
  };
}

describe("user capability detection", () => {
  test("selects a capability when any executable or path declaration matches", async () => {
    using testDirectory = createScopedTestDirectory("user-detection");
    const marker = path.join(testDirectory.path, ".configured");
    fs.writeFileSync(marker, "configured");
    const capabilities = [
      tool("from-executable", {
        duringUserInit: [hasExecutable("available"), hasPath("~/.missing")],
        duringProjectInit: [],
      }),
      tool("from-path", {
        duringUserInit: [hasExecutable("missing"), hasPath("~/.configured")],
        duringProjectInit: [],
      }),
      tool("not-detected", {
        duringUserInit: [hasExecutable("missing"), hasPath("~/.missing")],
        duringProjectInit: [],
      }),
    ];

    const selected = await detectUserCapabilities(capabilities, {
      homeDirectory: testDirectory.path,
      pathApi: path.posix,
      executableExists: async (executable) => executable === "available",
      pathExists: fs.existsSync,
    });

    expect(selected.map((capability) => capability.id)).toEqual([
      "from-executable",
      "from-path",
    ]);
  });

  test("rejects relative user paths", async () => {
    const capability = tool("invalid", {
      duringUserInit: [hasPath("config/file")],
      duringProjectInit: [],
    });

    expect(
      detectUserCapabilities([capability], {
        homeDirectory: "/home/test",
        pathApi: path.posix,
        executableExists: async () => false,
        pathExists: () => false,
      }),
    ).rejects.toThrow(
      'User detector path must start with "~/" or be absolute: config/file',
    );
  });
});

describe("project capability detection", () => {
  test("selects only capabilities with matching exact project paths", async () => {
    using testDirectory = createScopedTestDirectory("project-detection");
    fs.writeFileSync(path.join(testDirectory.path, "package.json"), "{}");
    fs.writeFileSync(path.join(testDirectory.path, "pnpm-lock.yaml"), "");
    const capabilities = [
      tool("node", {
        duringUserInit: [],
        duringProjectInit: [hasPath("./package.json")],
      }),
      tool("pnpm", {
        duringUserInit: [],
        duringProjectInit: [
          hasPath("./pnpm-workspace.yaml"),
          hasPath("./pnpm-lock.yaml"),
        ],
      }),
      tool("bun", {
        duringUserInit: [],
        duringProjectInit: [hasPath("./bun.lock")],
      }),
    ];

    const selected = await detectProjectCapabilities(
      capabilities,
      testDirectory.path,
      { pathApi: path.posix, pathExists: fs.existsSync },
    );

    expect(selected.map((capability) => capability.id)).toEqual([
      "node",
      "pnpm",
    ]);
    expect(fs.existsSync(path.join(testDirectory.path, ".sandbox"))).toBe(
      false,
    );
  });

  test("never invokes executable detection", async () => {
    const malformedProjectDetector = hasExecutable("host-command");
    const capability = tool("invalid", {
      duringUserInit: [],
      duringProjectInit: [
        malformedProjectDetector as unknown as ReturnType<typeof hasPath>,
      ],
    });
    let executableChecks = 0;

    const projectEnvironment = {
      pathApi: path.posix,
      pathExists: () => false,
      executableExists: async () => {
        executableChecks += 1;
        return true;
      },
    };

    await expect(
      detectProjectCapabilities([capability], "/project", projectEnvironment),
    ).rejects.toThrow("Project detector must be a path detector");
    expect(executableChecks).toBe(0);
  });

  test.each([
    ["absolute POSIX path", path.posix, "/project", "/etc/config"],
    ["escaping POSIX path", path.posix, "/project", "./../config"],
    [
      "absolute Windows path",
      path.win32,
      "C:\\project",
      "C:\\Users\\test\\config",
    ],
    ["escaping Windows path", path.win32, "C:\\project", "./..\\config"],
  ])("rejects an %s", async (_name, pathApi, root, detectorPath) => {
    const capability = tool("invalid", {
      duringUserInit: [],
      duringProjectInit: [hasPath(detectorPath)],
    });

    expect(
      detectProjectCapabilities([capability], root, {
        pathApi,
        pathExists: () => false,
      }),
    ).rejects.toThrow(/Project detector path/);
  });
});

describe("detector path resolution", () => {
  test.each([
    [path.posix, "/home/test", "~/.config/tool", "/home/test/.config/tool"],
    [
      path.win32,
      "C:\\Users\\test",
      "~/.config/tool",
      "C:\\Users\\test\\.config\\tool",
    ],
    [path.posix, "/home/test", "/opt/tool", "/opt/tool"],
    [
      path.win32,
      "C:\\Users\\test",
      "D:\\tools\\tool.exe",
      "D:\\tools\\tool.exe",
    ],
  ])(
    "resolves user paths with an explicit platform fixture",
    (pathApi, home, detectorPath, expected) => {
      expect(resolveUserDetectorPath(detectorPath, home, pathApi)).toBe(
        expected,
      );
    },
  );

  test.each([
    [path.posix, "/repo", "./config/tool", "/repo/config/tool"],
    [path.win32, "C:\\repo", "./config/tool", "C:\\repo\\config\\tool"],
  ])(
    "resolves project paths with an explicit platform fixture",
    (pathApi, root, detectorPath, expected) => {
      expect(resolveProjectDetectorPath(detectorPath, root, pathApi)).toBe(
        expected,
      );
    },
  );
});
