import { describe, expect, test } from "bun:test";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { validateMountPath as validateMountPathWithoutScope } from "./mount-validation.js";

interface PlatformFixture {
  readonly platform: NodeJS.Platform;
  readonly variables?: Readonly<Record<string, string>>;
  readonly homeDirectory?: string;
}

function validateMountPath(path: string, fixture: PlatformFixture): void {
  runWithTestLogger(() => validateMountPathWithoutScope(path), fixture);
}

const linux = { platform: "linux" } as const;
const darwin = { platform: "darwin" } as const;
const windows = {
  platform: "win32",
  homeDirectory: "D:\\Users\\sandbox-test",
  variables: {
    APPDATA: "D:\\Users\\sandbox-test\\AppData\\Roaming",
    LOCALAPPDATA: "D:\\Users\\sandbox-test\\AppData\\Local",
  },
} as const;

describe("validateMountPath", () => {
  describe("filesystem roots", () => {
    for (const scenario of [
      { platform: linux, path: "/" },
      { platform: darwin, path: "/" },
      { platform: windows, path: "C:\\" },
      { platform: windows, path: "\\" },
    ]) {
      test(`blocks ${scenario.path} on ${scenario.platform.platform}`, () => {
        expect(() =>
          validateMountPath(scenario.path, scenario.platform),
        ).toThrow("Cannot mount filesystem root");
      });
    }
  });

  describe("Linux system paths", () => {
    const systemPaths = [
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib32",
      "/lib64",
      "/sys",
      "/proc",
      "/dev",
      "/boot",
      "/root",
      "/docker",
      "/run",
    ];

    for (const path of systemPaths) {
      test(`blocks ${path} and its descendants`, () => {
        expect(() => validateMountPath(path, linux)).toThrow(
          "Cannot mount system directory:",
        );
        expect(() =>
          validateMountPath(`${path}/sandbox-test-descendant`, linux),
        ).toThrow("Cannot mount system directory:");
      });
    }
  });

  describe("macOS system paths", () => {
    for (const path of [
      "/System",
      "/Library",
      "/private/etc",
      "/Applications",
    ]) {
      test(`blocks ${path} and its descendants`, () => {
        expect(() => validateMountPath(path, darwin)).toThrow(
          "Cannot mount system directory:",
        );
        expect(() =>
          validateMountPath(`${path}/sandbox-test-descendant`, darwin),
        ).toThrow("Cannot mount system directory:");
      });
    }
  });

  describe("Windows system paths", () => {
    for (const path of [
      "C:\\Windows",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData",
      windows.variables.APPDATA,
      windows.variables.LOCALAPPDATA,
      "D:\\Users\\sandbox-test\\AppData",
    ]) {
      test(`blocks ${path} and its descendants`, () => {
        expect(() => validateMountPath(path, windows)).toThrow(
          "Cannot mount system directory:",
        );
        expect(() =>
          validateMountPath(`${path}\\sandbox-test-descendant`, windows),
        ).toThrow("Cannot mount system directory:");
      });
    }
  });

  describe("safe paths", () => {
    for (const scenario of [
      { platform: linux, path: "/home/sandbox-test/projects" },
      { platform: linux, path: "/opt/sandbox-test" },
      { platform: darwin, path: "/Users/sandbox-test/projects" },
      { platform: darwin, path: "/var/folders/sandbox-test/project" },
      { platform: darwin, path: "/private/var/folders/sandbox-test/project" },
      { platform: darwin, path: "/opt/sandbox-test" },
      { platform: windows, path: "D:\\Users\\sandbox-test\\projects" },
      { platform: windows, path: "E:\\sandbox-test\\data" },
    ]) {
      test(`allows ${scenario.path} on ${scenario.platform.platform}`, () => {
        expect(() =>
          validateMountPath(scenario.path, scenario.platform),
        ).not.toThrow();
      });
    }
  });

  describe("error messages", () => {
    test("includes actionable context", () => {
      try {
        validateMountPath("/etc", linux);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("Cannot mount system directory");
        expect(message).toContain(
          "System directories are blocked for security",
        );
        expect(message).toContain("Try running from a user directory");
      }
    });
  });

  describe("path normalization", () => {
    for (const scenario of [
      { platform: linux, path: "/etc//sandbox-test" },
      { platform: darwin, path: "/System//sandbox-test" },
      { platform: windows, path: "C:\\Windows\\\\sandbox-test" },
    ]) {
      test(`normalizes separators on ${scenario.platform.platform}`, () => {
        expect(() =>
          validateMountPath(scenario.path, scenario.platform),
        ).toThrow("Cannot mount system directory:");
      });
    }

    test("handles non-existent Linux paths", () => {
      expect(() =>
        validateMountPath("/etc/sandbox-test-nonexistent", linux),
      ).toThrow("Cannot mount system directory:");
      expect(() =>
        validateMountPath("/home/sandbox-test-nonexistent", linux),
      ).not.toThrow();
    });
  });
});
