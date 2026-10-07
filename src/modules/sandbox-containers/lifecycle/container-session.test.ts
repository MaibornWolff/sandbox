import { describe, expect, test } from "bun:test";
import { getClock } from "#platform/clock/index.js";
import {
  createRuntimeExecProcess,
  createStatefulContainerRuntimeHarness,
} from "#platform/container-runtime/__test__/index.js";
import type { SandboxInstanceOperations } from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  buildHostBridgeFirewallPlan,
  ContainerReadinessError,
  prepareContainerSession,
} from "./container-session.js";

function withSessionControl(
  containers: SandboxInstanceOperations,
): SandboxInstanceOperations {
  return {
    ...containers,
    async openExec(id, spec) {
      const result = await containers.exec(id, spec);
      return createRuntimeExecProcess({
        result: {
          ...result,
          stdout:
            result.exitCode === 0
              ? `${result.stdout}sandbox-session-control-ready\n`
              : result.stdout,
        },
        keepOpen: result.exitCode === 0,
      });
    },
  };
}

function installedRuleComment(command: readonly string[] | undefined): string {
  const commentIndex = command?.indexOf("--comment") ?? -1;
  const comment = command?.[commentIndex + 1];
  if (commentIndex < 0 || !comment)
    throw new Error("Missing session rule comment");
  return comment;
}

describe("host bridge network access", () => {
  test("keeps the container active during connection and releases its session on disposal", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.instances.create({
      name: "sandbox-project",
      image: "image",
      labels: {},
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await runWithTestLogger(async () => {
      const handle = await prepareContainerSession({
        containers: runtime.instances,
        containerId: "sandbox-project",
      });
      await using resources = new AsyncDisposableStack();
      resources.use(handle);
      expect(container.snapshot().controls).toHaveLength(1);
      expect(container.snapshot().sessions).toHaveLength(0);
      await resources.disposeAsync();
      expect(container.snapshot().controls).toHaveLength(0);
    });
  });

  test.each([true, false])(
    "waits for delayed readiness in one exec with proxy=%s",
    async (proxy) => {
      const harness = createStatefulContainerRuntimeHarness();
      const container = harness.instances.create({
        name: "sandbox-project",
        image: "image",
        labels: {},
        status: "running",
        readyAfterAttempts: 3,
      });
      const runtime = (await harness.provider.resolve()).runtime;
      await runWithTestLogger(async () => {
        await using _session = await prepareContainerSession({
          containers: runtime.instances,
          containerId: "sandbox-project",
          endpoint: proxy
            ? "ws://host.container.internal:43123/session"
            : undefined,
        });
        expect(container.snapshot().readinessAttempts).toBe(4);
        const calls = harness
          .events()
          .filter((event) => event.type === "container.exec");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.command.includes("/usr/sbin/iptables")).toBe(proxy);
        expect(calls[0]?.options.user).toBe("root");
      });
      expect(
        harness.events().filter((event) => event.type === "container.exec"),
      ).toHaveLength(proxy ? 2 : 1);
    },
  );

  test.each([
    { stdout: "", readiness: true },
    { stdout: "sandbox-session-ready\n", readiness: false },
  ])(
    "distinguishes readiness and firewall timeout: $readiness",
    async ({ stdout, readiness }) => {
      const harness = createStatefulContainerRuntimeHarness();
      harness.instances.create({
        name: "sandbox-project",
        image: "image",
        labels: {},
        status: "running",
        logs: "startup output",
      });
      const runtime = (await harness.provider.resolve()).runtime;
      await runWithTestLogger(async () => {
        const calls: (readonly string[])[] = [];
        const preparation = prepareContainerSession({
          containers: withSessionControl({
            ...runtime.instances,
            exec: async (_id, spec) => {
              calls.push(spec.command);
              return { exitCode: 124, stdout, stderr: "failed" };
            },
          }),
          containerId: "sandbox-project",
          endpoint: "ws://host.container.internal:43123/session",
          timeoutMs: 50,
        });
        if (readiness) {
          await expect(preparation).rejects.toBeInstanceOf(
            ContainerReadinessError,
          );
          expect(harness.events()).toContainEqual({
            type: "container.logs",
            containerId: "container-1",
            tail: 50,
          });
        } else {
          await expect(preparation).rejects.toMatchObject({
            exitCode: 124,
            message:
              "Failed to add host bridge network access with exit code 124.",
          });
          expect(
            harness.events().filter((event) => event.type === "container.logs"),
          ).toHaveLength(0);
          expect(calls[1]?.at(-1)).toBe(installedRuleComment(calls[0]));
        }
        expect(calls).toHaveLength(2);
      });
    },
  );

  test("removes the candidate rule when a failed runtime result loses stdout", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "image",
      labels: {},
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    const calls: (readonly string[])[] = [];
    await runWithTestLogger(async () => {
      await expect(
        prepareContainerSession({
          containers: withSessionControl({
            ...runtime.instances,
            exec: async (_id, spec) => {
              calls.push(spec.command);
              return calls.length === 1
                ? { exitCode: 23, stdout: "", stderr: "exec response lost" }
                : { exitCode: 0, stdout: "", stderr: "" };
            },
          }),
          containerId: "sandbox-project",
          endpoint: "ws://host.container.internal:43123/session",
        }),
      ).rejects.toMatchObject({
        exitCode: 23,
        message: expect.stringContaining("exec response lost"),
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.at(-1)).toBe(installedRuleComment(calls[0]));
      expect(
        harness.events().filter((event) => event.type === "container.logs"),
      ).toHaveLength(0);
    });
  });

  test.each([
    "running",
    "stopping",
    "exited",
    "dead",
    "missing",
    "inspection-failed",
  ] as const)(
    "cleans the candidate rule after transport rejection with state %s",
    async (state) => {
      const harness = createStatefulContainerRuntimeHarness();
      if (state !== "missing") {
        harness.instances.create({
          name: "sandbox-project",
          image: "image",
          labels: {},
          status: state === "inspection-failed" ? "running" : state,
          logs: new Error("log transport unavailable"),
        });
      }
      const runtime = (await harness.provider.resolve()).runtime;
      const failure = Object.assign(new Error("exec transport disconnected"), {
        exitCode: 23,
      });
      const calls: (readonly string[])[] = [];
      await runWithTestLogger(async () => {
        const preparation = prepareContainerSession({
          containers: withSessionControl({
            ...runtime.instances,
            inspect: async (id) => {
              if (state === "inspection-failed")
                throw new Error("inspect unavailable");
              return runtime.instances.inspect(id);
            },
            exec: async (_id, spec) => {
              calls.push(spec.command);
              if (calls.length === 1) throw failure;
              return {
                exitCode: 19,
                stdout: "",
                stderr: "cleanup unavailable",
              };
            },
          }),
          containerId: "sandbox-project",
          endpoint: "ws://host.container.internal:43123/session",
        });
        if (state === "running" || state === "inspection-failed") {
          await expect(preparation).rejects.toBe(failure);
        } else {
          await expect(preparation).rejects.toBeInstanceOf(
            ContainerReadinessError,
          );
        }
        expect(calls).toHaveLength(2);
        expect(calls[1]?.at(-1)).toBe(installedRuleComment(calls[0]));
        expect(
          harness.events().filter((event) => event.type === "container.logs"),
        ).toHaveLength(
          state === "running" ||
            state === "inspection-failed" ||
            state === "missing"
            ? 0
            : 1,
        );
      });
    },
  );

  test.each(["removed", "cleanup-rejected", "no-proxy"] as const)(
    "preserves the original exec failure when %s",
    async (scenario) => {
      const harness = createStatefulContainerRuntimeHarness();
      harness.instances.create({
        name: "sandbox-project",
        image: "image",
        labels: {},
        status: "running",
      });
      const runtime = (await harness.provider.resolve()).runtime;
      const failure = Object.assign(new Error("exec response lost"), {
        exitCode: 23,
      });
      const calls: (readonly string[])[] = [];
      await runWithTestLogger(async () => {
        const output: string[] = [];
        const logger = createLogger(getClock(), (message) =>
          output.push(message),
        );
        await runWithDependencies([provideLogger(logger)], async () => {
          await expect(
            prepareContainerSession({
              containers: withSessionControl({
                ...runtime.instances,
                exec: async (_id, spec) => {
                  calls.push(spec.command);
                  if (calls.length === 1) throw failure;
                  if (scenario === "cleanup-rejected")
                    throw new Error("cleanup response lost");
                  return { exitCode: 0, stdout: "", stderr: "" };
                },
              }),
              containerId: "sandbox-project",
              endpoint:
                scenario === "no-proxy"
                  ? undefined
                  : "ws://host.container.internal:43123/session",
            }),
          ).rejects.toBe(failure);
        });
        if (scenario === "cleanup-rejected") {
          expect(output.join("\n")).toContain(
            "Could not remove the failed session's firewall rule: cleanup response lost",
          );
        } else {
          expect(output).toHaveLength(0);
        }
      });
      expect(calls).toHaveLength(scenario === "no-proxy" ? 1 : 2);
      expect(
        harness.events().filter((event) => event.type === "container.logs"),
      ).toHaveLength(0);
    },
  );

  test("preserves readiness failure when startup logs are unavailable", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "image",
      labels: {},
      status: "exited",
      logs: new Error("log transport unavailable"),
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await expect(
      runWithTestLogger(() =>
        prepareContainerSession({
          containers: runtime.instances,
          containerId: "sandbox-project",
        }),
      ),
    ).rejects.toBeInstanceOf(ContainerReadinessError);
  });

  test("uses unique rules and removes the exact installed match", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "image",
      labels: {},
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await runWithTestLogger(async () => {
      await using _first = await prepareContainerSession({
        containers: runtime.instances,
        containerId: "sandbox-project",
        endpoint: "ws://host.container.internal:43123/session",
      });
      await using _second = await prepareContainerSession({
        containers: runtime.instances,
        containerId: "sandbox-project",
        endpoint: "ws://host.container.internal:43123/session",
      });
    });
    const calls = harness
      .events()
      .filter((event) => event.type === "container.exec");
    const first = calls[0]?.command.slice(4) ?? [];
    const second = calls[1]?.command.slice(4) ?? [];
    expect(first).not.toEqual(second);
    expect(calls[2]?.command.at(-1)).toBe(installedRuleComment(second));
    expect(calls[3]?.command.at(-1)).toBe(installedRuleComment(first));
    expect(calls[0]?.command[2]).not.toContain("host.container.internal");
  });

  test.each(["running", "stopping", "exited", "missing"] as const)(
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
        inspect: async (id: string) => {
          const instance = await runtime.instances.inspect(id);
          return state === "stopping" && instance
            ? { ...instance, state: "stopping" as const }
            : instance;
        },
        exec: async () => ({
          exitCode: ++calls === 1 ? 0 : 19,
          stdout: "",
          stderr: "instance stopped",
        }),
      };
      await runWithTestLogger(async () => {
        const handle = await prepareContainerSession({
          containers: withSessionControl(instances),
          containerId: "sandbox-project",
          endpoint: "ws://host.container.internal:43123/session",
        });
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
    const plan = buildHostBridgeFirewallPlan(
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
      "sandbox-host-bridge-session",
      "-j",
      "ACCEPT",
    ]);
    expect(plan.remove.at(-1)).toBe("sandbox-host-bridge-session");
    expect(plan.add).not.toContain("192.168.0.0/16");
  });

  test("rejects endpoints without a bounded explicit port", () => {
    expect(() =>
      buildHostBridgeFirewallPlan(
        "ws://host.container.internal/session",
        "session",
      ),
    ).toThrow("endpoint is invalid");
  });
});
