import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  allowHostCommandNetworkAccess,
  buildHostCommandFirewallPlan,
} from "./host-command-network-access.js";

describe("host-command broker network access", () => {
  test.each(["running", "exited", "missing"] as const)(
    "handles cleanup failure while the instance is %s",
    async (state) => {
      const harness = createStatefulContainerRuntimeHarness();
      harness.instances.create({
        name: "sandbox-project",
        image: "sandbox-project:latest",
        labels: {},
        status: "running",
      });
      const runtime = (await harness.provider.resolve()).runtime;
      let calls = 0;
      const instances = {
        ...runtime.instances,
        exec: async () => ({
          exitCode: ++calls === 1 ? 0 : 19,
          stdout: "",
          stderr: "instance stopped",
        }),
      };
      await runWithTestLogger(async () => {
        const handle = await allowHostCommandNetworkAccess(
          instances,
          "sandbox-project",
          "ws://host.container.internal:43123/session",
        );
        if (state === "missing")
          await runtime.instances.remove("sandbox-project", { force: true });
        if (state === "exited")
          await runtime.instances.signal("sandbox-project", "SIGTERM");
        const cleanup = handle[Symbol.asyncDispose]();
        if (state === "running")
          await expect(cleanup).rejects.toMatchObject({ exitCode: 19 });
        else await expect(cleanup).resolves.toBeUndefined();
      });
    },
  );

  test("allows only the exact broker host, port, and sandbox identity", () => {
    const plan = buildHostCommandFirewallPlan(
      "ws://host.container.internal:43123/session",
      "session",
    );

    expect(plan.add).toEqual([
      "/usr/sbin/iptables",
      "-I",
      "OUTPUT",
      "1",
      "-p",
      "tcp",
      "-d",
      "host.container.internal",
      "--dport",
      "43123",
      "-m",
      "owner",
      "--uid-owner",
      "sandbox",
      "-m",
      "comment",
      "--comment",
      "sandbox-host-command-session",
      "-j",
      "ACCEPT",
    ]);
    expect(plan.remove).toEqual([
      "/usr/sbin/iptables",
      "-D",
      "OUTPUT",
      "-p",
      "tcp",
      "-d",
      "host.container.internal",
      "--dport",
      "43123",
      "-m",
      "owner",
      "--uid-owner",
      "sandbox",
      "-m",
      "comment",
      "--comment",
      "sandbox-host-command-session",
      "-j",
      "ACCEPT",
    ]);
    expect(plan.add).not.toContain("192.168.0.0/16");
  });

  test("rejects endpoints without a bounded explicit port", () => {
    expect(() =>
      buildHostCommandFirewallPlan(
        "ws://host.container.internal/session",
        "session",
      ),
    ).toThrow("endpoint is invalid");
  });
});
