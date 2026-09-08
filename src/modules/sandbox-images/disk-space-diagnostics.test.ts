import { describe, expect, it } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  isNoSpaceError,
  warnIfNoSpaceError,
} from "./disk-space-diagnostics.js";

describe("isNoSpaceError", () => {
  it("recognizes the phrase case-insensitively in messages and process output", () => {
    expect(isNoSpaceError(new Error("no space left on device"))).toBe(true);
    expect(isNoSpaceError(new Error("No Space Left On Device"))).toBe(true);
    expect(
      isNoSpaceError(
        Object.assign(new Error("Command failed with exit code 1"), {
          stderr: "failed to extract: No space left on device",
          stdout: "",
        }),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors and non-error values", () => {
    expect(isNoSpaceError(new Error("permission denied"))).toBe(false);
    expect(isNoSpaceError("no space left on device")).toBe(false);
    expect(isNoSpaceError(null)).toBe(false);
  });
});

describe("warnIfNoSpaceError", () => {
  it("routes the runtime-specific prune hint through scoped output", async () => {
    for (const runtimeName of ["docker", "podman"] as const) {
      const root = createTestDir(`disk-space-${runtimeName}`);
      try {
        const harness = createStatefulContainerRuntimeHarness({
          runtime: runtimeName,
        });
        const runtime = await harness.provider.resolve(runtimeName);
        const output = await runInHostTestScope({ root }, () =>
          warnIfNoSpaceError(
            new Error("write failed: no space left on device"),
            runtime,
          ),
        );

        expect(output.stderr).toContain("No space left on device");
        expect(output.stderr).toContain(`${runtimeName} system prune`);
      } finally {
        cleanupTestDir(root);
      }
    }
  });

  it("does not write output for unrelated values", async () => {
    const root = createTestDir("disk-space-unrelated");
    try {
      const harness = createStatefulContainerRuntimeHarness();
      const runtime = await harness.provider.resolve();
      const output = await runInHostTestScope({ root }, () => {
        warnIfNoSpaceError(new Error("permission denied"), runtime);
        warnIfNoSpaceError(null, runtime);
      });
      expect(output.stdout).toBe("");
      expect(output.stderr).toBe("");
    } finally {
      cleanupTestDir(root);
    }
  });
});
