import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { runWithConfigurationTestScope } from "./__test__/index.js";
import {
  getConfigHomeDir,
  getGlobalConfigPath,
  getGlobalDockerfilePath,
  getProjectConfigPath,
  getProjectDockerfilePath,
  getProjectSandboxDir,
  getSandboxConfigDir,
} from "./config-paths.js";

function withEnvironment<T>(
  options: {
    variables?: Readonly<Record<string, string>>;
    platform?: NodeJS.Platform;
    home?: string;
  },
  callback: () => T,
): T {
  return runWithConfigurationTestScope(callback, {
    currentWorkingDirectory: "/project",
    homeDirectory: options.home ?? "/home/test",
    variables: options.variables ?? {},
    platform: options.platform ?? "linux",
  });
}

describe("configuration paths", () => {
  test("uses explicit XDG and sandbox roots", () => {
    withEnvironment(
      {
        variables: {
          XDG_CONFIG_HOME: "/xdg",
          SANDBOX_CONFIG_DIR: "/sandbox-config",
        },
      },
      () => {
        expect(getConfigHomeDir()).toBe("/xdg");
        expect(getSandboxConfigDir()).toBe("/sandbox-config");
        expect(getGlobalConfigPath()).toBe(
          path.join("/sandbox-config", "config.toml"),
        );
        expect(getGlobalDockerfilePath()).toBe(
          path.join("/sandbox-config", "docker", "Dockerfile"),
        );
      },
    );
  });

  test("uses platform-specific scoped defaults", () => {
    withEnvironment({ home: "/home/test", platform: "linux" }, () => {
      expect(getConfigHomeDir()).toBe(path.join("/home/test", ".config"));
      expect(getSandboxConfigDir()).toBe(
        path.join("/home/test", ".config", "sandbox"),
      );
    });
    withEnvironment(
      {
        home: "C:\\Users\\test",
        platform: "win32",
        variables: { APPDATA: "C:\\Config" },
      },
      () => {
        expect(getConfigHomeDir()).toBe("C:\\Config");
        expect(getSandboxConfigDir()).toBe(path.join("C:\\Config", "sandbox"));
      },
    );
  });

  test("builds project paths from an explicit root", () => {
    expect(getProjectSandboxDir("/project")).toBe(
      path.join("/project", ".sandbox"),
    );
    expect(getProjectConfigPath("/project")).toBe(
      path.join("/project", ".sandbox", "config.toml"),
    );
    expect(getProjectDockerfilePath("/project")).toBe(
      path.join("/project", ".sandbox", "docker", "Dockerfile"),
    );
  });
});
