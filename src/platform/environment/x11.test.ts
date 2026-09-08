import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createProcessTestHarness,
  type ProcessTestHarness,
} from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createHostEnvironment,
  type HostEnvironment,
  provideHostEnvironment,
} from "./host-environment.js";
import { detectX11 } from "./x11.js";

function environment(
  platform: NodeJS.Platform,
  variables: Readonly<Record<string, string>> = {},
): HostEnvironment {
  return createHostEnvironment({
    currentWorkingDirectory: "/project",
    homeDirectory: "/home/user",
    variables,
    platform,
    interactive: false,
  });
}

function runX11Scope<T>(
  hostEnvironment: HostEnvironment,
  callback: (processes: ProcessTestHarness) => Promise<T>,
): Promise<T> {
  const processes = createProcessTestHarness();
  const displayNumber =
    hostEnvironment.variables.DISPLAY?.match(/:(\d+)/)?.[1] ?? "0";
  processes
    .expectStart({
      match: {
        command: "test",
        args: ["-e", `/tmp/.X11-unix/X${displayNumber}`],
      },
    })
    .resolveResult({
      exitCode: 1,
      stdout: "",
      stderr: "not found",
    });
  return runWithDependencies(
    [
      provideHostEnvironment(hostEnvironment),
      provideProcessManager(processes.manager),
    ],
    () => callback(processes),
  );
}

describe("detectX11", () => {
  test("detects XQuartz and caches the result inside one scope", async () => {
    await runX11Scope(environment("darwin"), async (processes) => {
      processes
        .expectStart({
          match: {
            command: "pgrep",
            args: ["-ix", "XQuartz|X11\\.bin"],
          },
        })
        .resolveResult({
          exitCode: 0,
          stdout: "123\n",
          stderr: "",
        });
      expect((await detectX11()).available).toBe(true);
      expect((await detectX11()).display).toBe(":0");
      expect(processes.requests).toHaveLength(1);
    });
  });

  test("invalidates detection when the same environment is rebound", async () => {
    const hostEnvironment = environment("linux", { DISPLAY: ":0" });
    const first = await runX11Scope(hostEnvironment, async (processes) => {
      processes
        .expectStart({ match: { command: "xdpyinfo", args: [] } })
        .resolveResult({
          exitCode: 0,
          stdout: "available",
          stderr: "",
        });
      return detectX11();
    });
    const second = await runX11Scope(hostEnvironment, async (processes) => {
      processes
        .expectStart({ match: { command: "xdpyinfo", args: [] } })
        .resolveResult({
          exitCode: 1,
          stdout: "",
          stderr: "display unavailable",
        });
      return detectX11();
    });

    expect(first.available).toBe(true);
    expect(second.available).toBe(false);
  });

  test("keeps parallel scopes isolated", async () => {
    const [linux, windows] = await Promise.all([
      runX11Scope(environment("linux"), async () => detectX11()),
      runX11Scope(environment("win32"), async (processes) => {
        processes
          .expectStart({
            match: {
              command: "tasklist",
              args: ["/FI", "IMAGENAME eq vcxsrv.exe"],
            },
          })
          .resolveResult({
            exitCode: 0,
            stdout: "vcxsrv.exe",
            stderr: "",
          });
        return detectX11();
      }),
    ]);
    expect(linux.available).toBe(false);
    expect(windows.available).toBe(true);
  });
});
