import { expect, test } from "bun:test";
import { createSessionStatusFixture } from "#modules/sandbox-containers/__test__/index.js";
import { buildSelectedSessionStatusCommand } from "#platform/container-system/index.js";
import type { VerifiedForegroundJob } from "#platform/foreground-job/index.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

const pgid = 4100;
const args = ["status", "--foreground-job", `${pgid}`, "--json"];
const sessionId = "cc64562d-7900-4a61-b675-82944cf1b78f";
const otherId = "fa67e191-f9a3-4c7e-b305-e4c01283a24f";
const containerId = "c".repeat(64);
const endpoint = "d".repeat(64);
const starting: VerifiedForegroundJob = {
  pgid,
  sessionId,
  binding: "starting",
  snapshot: "startup",
};
const attached: VerifiedForegroundJob = {
  ...starting,
  binding: { containerId, endpoint },
  snapshot: "attached",
};
const selectedRow = `session ${sessionId} 74 1770000123`;

async function fixture(
  read: () => readonly VerifiedForegroundJob[],
  getEndpoint = () => endpoint,
) {
  const app = await setupSandboxAppTest({
    platform: "darwin",
    runtime: "podman",
    interactive: false,
    foregroundJobs: async () => ({
      assertIsolated: () => undefined,
      register: () => undefined,
      find: read,
    }),
    runtimeProvider: (provider) => ({
      ...provider,
      async resolve(request) {
        const selection = await provider.resolve(request);
        return {
          ...selection,
          runtime: {
            ...selection.runtime,
            bindLocalLookup: async () => {
              const identity = getEndpoint();
              return {
                identity,
                instances: selection.runtime.instances,
                hostMounts: [],
                verify: async () => {
                  if (getEndpoint() !== identity)
                    throw new Error("Endpoint changed.");
                },
                async [Symbol.asyncDispose]() {},
              };
            },
          },
        };
      },
    }),
  });
  const container = app.runtime.instances.create({
    id: containerId,
    name: "sandbox-elsewhere",
    image: "sandbox-elsewhere:latest",
    labels: {
      "sandbox.project": "elsewhere",
      "sandbox.project-dir": "/elsewhere",
    },
    status: "running",
  });
  const command = buildSelectedSessionStatusCommand(
    "/opt/sandbox-cli",
    sessionId,
  );
  container.givenExecResult(command, `ready 1\n${selectedRow}\n`);
  return Object.assign(app, { container, command });
}

test.each(["0", "+3", "-3", "3.2", "2e3", " 3", "3\n", "2147483648", ""])(
  "rejects invalid PGID %j before runtime resolution",
  async (value) => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run(
      "status",
      `--foreground-job=${value}`,
      "--json",
    );
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("positive decimal");
    expect(app.runtime.events()).toEqual([]);
  },
);

test.each([["--all", "--json"], ["--session", sessionId, "--json"], []])(
  "rejects incompatible options: %j",
  async (...flags) => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run(
      "status",
      "--foreground-job",
      "4100",
      ...flags,
    );
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      "Use --foreground-job with --json and without --all or --session.",
    );
  },
);

test("does not resolve a runtime on unsupported hosts", async () => {
  await using app = await setupSandboxAppTest();
  expect(await app.cli.run(...args)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "Foreground-job status is available only on macOS with local Podman.\n",
  });
  expect(app.runtime.events()).toEqual([]);
});

test.each([
  { records: [], state: "not-found", id: null },
  { records: [starting], state: "starting", id: sessionId },
  {
    records: [starting, { ...starting, sessionId: otherId }],
    state: "ambiguous",
    id: null,
  },
])(
  "returns $state without inspecting any containers",
  async ({ records, state, id }) => {
    await using app = await fixture(() => records);
    const result = await app.cli.run(...args);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      runtime: "podman",
      containers: [],
      attachment: { state, foregroundPgid: pgid, sessionId: id },
    });
    expect(app.runtime.events()).toEqual([]);
  },
);

test("queries only the exact container and session, independent of project and user runtime configuration", async () => {
  await using app = await fixture(() => [attached]);
  app.global.writeConfig('runtime = "docker"');
  app.project.writeConfig('runtime = "apple-container"');
  const result = await app.cli.run(...args);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    runtime: "podman",
    attachment: { state: "attached", foregroundPgid: pgid, sessionId },
    containers: [
      expect.objectContaining({
        containerId,
        sessions: [
          {
            id: sessionId,
            pid: 74,
            startedAt: new Date(1770000123000).toISOString(),
            command: null,
            foregroundJob: { type: "pgid", id: pgid },
          },
        ],
      }),
    ],
  });
  expect(app.runtime.events()).toEqual([
    { type: "container.inspect", containerId },
    expect.objectContaining({ type: "container.exec", containerId }),
  ]);
});

test("returns starting while the exact guest row is absent", async () => {
  await using app = await fixture(() => [attached]);
  app.container.givenExecResult(app.command, "ready 1\n");
  const result = await app.cli.run(...args);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    containers: [],
    attachment: { state: "starting", sessionId },
  });
});

test("rejects invalid probe output before considering a candidate change", async () => {
  let calls = 0;
  const line = `${selectedRow} --private-argv`;
  await using app = await fixture(() => (++calls === 1 ? [attached] : []));
  app.container.givenExecResult(app.command, `ready 1\n${line}\n`);
  const result = await app.cli.run(...args);
  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "Could not verify the foreground job and its local Podman attachment.\n",
  });
});

test("discards the result when another launcher joins during the probe", async () => {
  let calls = 0;
  await using app = await fixture(() =>
    ++calls < 2 ? [attached] : [attached, { ...starting, sessionId: otherId }],
  );
  const result = await app.cli.run(...args);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    containers: [],
    attachment: { state: "ambiguous", sessionId: null },
  });
});

test("discards a valid guest row when the host attachment exits during the probe", async () => {
  let calls = 0;
  await using app = await fixture(() => (++calls === 1 ? [attached] : []));
  const result = await app.cli.run(...args);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    containers: [],
    attachment: { state: "not-found", sessionId: null },
  });
});

test("discards the result when the Podman context changes during the probe", async () => {
  let binds = 0;
  await using app = await fixture(
    () => [attached],
    () => (++binds === 1 ? endpoint : "different"),
  );
  expect(await app.cli.run(...args)).toMatchObject({ exitCode: 1, stdout: "" });
});

test("ordinary JSON adds a verified job without changing the legacy session command", async () => {
  let identity = endpoint;
  await using app = await fixture(
    () => [attached],
    () => identity,
  );
  createSessionStatusFixture(app.container).givenSessions([
    {
      id: sessionId,
      pid: 74,
      startedAt: new Date(1770000123000),
      command: ["sh", "my command"],
    },
  ]);
  const status = () => app.cli.run("status", "--all", "--json");
  const result = await status();
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json).not.toHaveProperty("attachment");
  expect(json.containers).toMatchObject([
    {
      sessions: [
        {
          command: ["sh", "my command"],
          foregroundJob: { type: "pgid", id: pgid },
        },
      ],
    },
  ]);
  identity = "different-endpoint";
  const unverified = await status();
  expect(unverified.exitCode).toBe(0);
  expect(unverified.stdout).not.toContain("foregroundJob");
  const text = await app.cli.run("status", "--all");
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("my command");
  expect(text.stdout).not.toContain(String(pgid));
});

test.each([
  { interactive: true, cliArgs: ["run", "true"], registers: true },
  { interactive: false, cliArgs: ["run", "true"], registers: false },
  { interactive: true, cliArgs: ["container", "start"], registers: false },
])(
  "registers only TTY attachments before runtime selection: $cliArgs ($interactive)",
  async ({ interactive, cliArgs, registers }) => {
    const steps: string[] = [];
    await using app = await setupSandboxAppTest({
      platform: "darwin",
      interactive,
      foregroundJobs: async () => ({
        assertIsolated: () => undefined,
        find: () => [],
        register: () => {
          steps.push("register");
          return undefined;
        },
      }),
      runtimeProvider: (provider) => ({
        ...provider,
        async resolve(request) {
          if (request?.configuredRuntime === "podman") {
            const selection = await provider.resolve();
            return {
              ...selection,
              runtime: {
                ...selection.runtime,
                bindLocalLaunch: async () => ({
                  selection,
                  hostMounts: [],
                  identity: endpoint,
                  verify: async () => undefined,
                  async [Symbol.asyncDispose]() {},
                }),
              },
            };
          }
          steps.push("resolve");
          throw new Error("Stopped at runtime selection");
        },
      }),
    });
    await app.project.givenConfig({ allowNetwork: [] });
    const result = await app.cli.run(...cliArgs);
    expect(result.stderr).toContain("Stopped at runtime selection");
    expect(steps).toEqual(registers ? ["register", "resolve"] : ["resolve"]);
  },
);
