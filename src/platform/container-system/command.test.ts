import { describe, expect, test } from "bun:test";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { executeContainerCommand } from "./command.js";

describe("container command", () => {
  test("returns captured output through the scoped process owner", async () => {
    const processes = createProcessTestHarness();
    processes
      .expectStart({ match: { command: "tool", args: ["check"] } })
      .resolveResult({
        exitCode: 0,
        stdout: "ready\n",
        stderr: "",
      });

    expect(
      await processes.run(() => executeContainerCommand("tool", ["check"])),
    ).toBe("ready\n");
    expect(processes.requests).toEqual([{ command: "tool", args: ["check"] }]);
  });

  test("preserves child exit code and output", async () => {
    const processes = createProcessTestHarness();
    processes
      .expectStart({ match: { command: "tool", args: ["check"] } })
      .resolveResult({
        exitCode: 7,
        stdout: "partial output\n",
        stderr: "failed detail\n",
      });

    await expect(
      processes.run(() => executeContainerCommand("tool", ["check"])),
    ).rejects.toMatchObject({
      message: "tool failed with exit code 7: failed detail\npartial output",
      exitCode: 7,
    });
  });
});
