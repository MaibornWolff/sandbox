import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createSandboxEnvironment,
  provideSandboxEnvironment,
} from "#platform/environment/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { diagnoseContainerX11 } from "./x11.js";

async function diagnose(options: {
  readonly display?: string;
  readonly output?: string;
  readonly error?: Error;
}) {
  const processes = createProcessTestHarness();
  if (options.error) processes.expectStart().rejectResult(options.error);
  if (options.output !== undefined) {
    processes
      .expectStart({ match: { command: "xdpyinfo", args: [] } })
      .resolveResult({
        exitCode: 0,
        stdout: options.output,
        stderr: "",
      });
  }
  const environment = createSandboxEnvironment({
    filesystemRoot: "/container",
    homeDirectory: "/container/home/sandbox",
    variables: options.display ? { DISPLAY: options.display } : {},
    platform: "linux",
  });
  return runWithDependencies(
    [
      provideSandboxEnvironment(environment),
      provideProcessManager(processes.manager),
    ],
    diagnoseContainerX11,
  );
}

describe("container X11 diagnostics", () => {
  test("rejects a missing display", async () => {
    expect(await diagnose({})).toEqual({
      exitCode: 1,
      output: "❌ DISPLAY not set\n",
    });
  });

  test("reports a missing xdpyinfo executable", async () => {
    const error = Object.assign(new Error("spawn xdpyinfo ENOENT"), {
      code: "ENOENT",
    });
    expect(await diagnose({ display: ":0", error })).toEqual({
      exitCode: 1,
      output: "❌ xdpyinfo not installed\n",
    });
  });

  test("reports failed connections", async () => {
    const result = await diagnose({
      display: "host.internal:0",
      error: new Error("connection refused"),
    });
    expect(result).toEqual({
      exitCode: 1,
      output: "❌ Cannot connect to X server at host.internal:0\n",
    });
  });

  test("reports display and screen details on success", async () => {
    const result = await diagnose({
      display: ":1",
      output:
        "header\nscreen #0:\n  dimensions: 1920x1080\n  resolution: 96x96\ntrailer\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "✅ X11 connection successful\n   Display: :1\nscreen #0:\n  dimensions: 1920x1080\n  resolution: 96x96\n",
    );
  });
});
