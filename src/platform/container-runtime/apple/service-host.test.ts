import { describe, expect, test } from "bun:test";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { AppleContainerService } from "./service.js";

function givenBaseHost(
  commands: ReturnType<typeof createStatefulRuntimeCommandExecutor>,
  options: {
    readonly architecture?: string;
    readonly macOsVersion?: string;
    readonly runtimeVersion?: string;
    readonly status?: string;
  } = {},
): void {
  commands.givenOutput(
    { command: "uname", args: ["-m"] },
    options.architecture ?? "arm64",
  );
  commands.givenOutput(
    { command: "sw_vers", args: ["-productVersion"] },
    options.macOsVersion ?? "26.5.1",
  );
  commands.givenOutput(
    { command: "container", args: ["--version"] },
    options.runtimeVersion ?? "container CLI version 1.4.1",
  );
  commands.givenOutput(
    {
      command: "container",
      args: ["system", "status", "--format", "json"],
    },
    options.status ?? '{"status":"running"}',
  );
}

function ensureReady(
  commands: ReturnType<typeof createStatefulRuntimeCommandExecutor>,
  platform: NodeJS.Platform = "darwin",
): Promise<unknown> {
  return runWithTestLogger(
    () => new AppleContainerService(commands.executor).ensureHostReady(),
    { platform },
  );
}

describe("Apple container host validation", () => {
  test("rejects a non-macOS host before runtime commands", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    await expect(ensureReady(commands, "linux")).rejects.toThrow(
      "requires macOS 26",
    );
    expect(commands.events()).toEqual([]);
  });

  test("rejects Intel and old macOS hosts with specific errors", async () => {
    const intel = createStatefulRuntimeCommandExecutor();
    givenBaseHost(intel, { architecture: "x86_64" });
    await expect(ensureReady(intel)).rejects.toThrow(
      "requires Apple silicon. Found x86_64",
    );

    const oldMac = createStatefulRuntimeCommandExecutor();
    givenBaseHost(oldMac, { macOsVersion: "15.6" });
    await expect(ensureReady(oldMac)).rejects.toThrow(
      "requires macOS 26 or newer. Found 15.6",
    );
  });

  test("rejects old and malformed runtime versions", async () => {
    const oldRuntime = createStatefulRuntimeCommandExecutor();
    givenBaseHost(oldRuntime, {
      runtimeVersion: "container CLI version 1.4.0",
    });
    await expect(ensureReady(oldRuntime)).rejects.toThrow(
      "1.4.1 or newer is required",
    );

    const malformed = createStatefulRuntimeCommandExecutor();
    givenBaseHost(malformed, { runtimeVersion: "development" });
    await expect(ensureReady(malformed)).rejects.toThrow(
      "Could not parse Apple container version",
    );
  });

  test("reports stopped and malformed service state with recovery advice", async () => {
    const stopped = createStatefulRuntimeCommandExecutor();
    givenBaseHost(stopped, { status: '{"status":"stopped"}' });
    await expect(ensureReady(stopped)).rejects.toThrow(
      "container system start",
    );

    const malformed = createStatefulRuntimeCommandExecutor();
    givenBaseHost(malformed, { status: "not-json" });
    await expect(ensureReady(malformed)).rejects.toThrow(
      "Could not read the Apple container service state",
    );
  });
});
