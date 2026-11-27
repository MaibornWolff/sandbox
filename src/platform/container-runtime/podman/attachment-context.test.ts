import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";
import type { RuntimeExecutor } from "../executor.js";
import { resolvePodmanAttachmentContext } from "./attachment-context.js";
import { PodmanService } from "./service.js";

const guestSocket = "/run/user/501/podman/podman.sock";
const id = "c".repeat(64);
const localUri = `ssh://dev@127.0.0.1:60231${guestSocket}`;
const dates = {
  Created: "2026-01-01T01:01:01Z",
  LastUp: "2026-01-01T02:02:02Z",
};
function withHost<T>(operation: () => T, variables = {}) {
  return runWithDependencies(
    [
      provideHostEnvironment(
        createHostEnvironment({
          platform: "darwin",
          interactive: false,
          userId: process.getuid?.() ?? 0,
          currentWorkingDirectory: "/anywhere",
          homeDirectory: "/host",
          variables,
        }),
      ),
    ],
    operation,
  );
}

async function machine(major = 6) {
  const configDir = await mkdtemp(join(tmpdir(), "sandbox-machine-"));
  const key = join(configDir, "identity");
  const invocations: string[] = [];
  let selectedUri = localUri;
  const machineName = "dev-machine";
  const remoteUser = { RemoteUsername: "dev", IdentityPath: key, Port: 60231 };
  await writeFile(key, "fixture-identity", { mode: 0o600 });
  await writeFile(
    join(configDir, `${machineName}.json`),
    JSON.stringify({
      Name: machineName,
      ...dates,
      HostUser: { UID: 501, Rootful: false },
      Mounts: [{ Source: configDir }],
    }),
  );
  async function expectPin(env: Readonly<Record<string, string>> | undefined) {
    const pin = env?.PODMAN_CONNECTIONS_CONF;
    const name = env?.CONTAINER_CONNECTION;
    expect(env).toMatchObject({ CONTAINER_HOST: "", CONTAINER_SSHKEY: "" });
    if (!pin || !name) throw new Error("The Podman connection was not pinned.");
    expect(JSON.parse(await readFile(pin, "utf8"))).toEqual({
      Connection: {
        Default: name,
        Connections: {
          [name]: { URI: localUri, Identity: key, IsMachine: true },
        },
      },
    });
  }
  const exec: RuntimeExecutor = async (_command, args, options) => {
    const argv = (args ?? []).join(" ");
    invocations.push(argv);
    switch (argv) {
      case "system connection list --format=json":
        return JSON.stringify([
          {
            Name: "chosen",
            URI: selectedUri,
            Identity: key,
            IsMachine: true,
            Default: true,
          },
        ]);
      case "--version":
        return `podman version ${major}.2.1\n`;
      case "machine list --format=json":
      case "machine list --all-providers --format=json":
        if (argv.includes("--all-providers") !== (major === 5)) {
          throw new Error(
            "Wrong all-provider listing command for this client.",
          );
        }
        return JSON.stringify([
          { Name: machineName, Running: true, Port: 60231 },
        ]);
      case `machine inspect -- ${machineName}`:
        return JSON.stringify([
          {
            Name: machineName,
            State: "running",
            ...dates,
            Rootful: false,
            ConfigDir: { Path: configDir },
            SSHConfig: remoteUser,
          },
        ]);
      case "info --format {{.Host.RemoteSocket.Path}}":
        await expectPin(options?.env);
        return `unix://${guestSocket}\n`;
      case `inspect ${id}`:
        await expectPin(options?.env);
        return JSON.stringify([
          {
            Id: id,
            Name: "sandbox-project",
            Image: "image-id",
            Config: { Image: "sandbox" },
          },
        ]);
      case `exec -u root ${id} probe`:
        await expectPin(options?.env);
        return "ready 1\n";
      default:
        throw new Error(`Unexpected runtime command: ${argv}`);
    }
  };
  return {
    exec,
    expectPin,
    invocations,
    changeDefault() {
      selectedUri = "ssh://elsewhere.invalid/run/podman/podman.sock";
    },
    async [Symbol.asyncDispose]() {
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "uses the frozen connection for selection, interactive exec and the selected probe",
  async () => {
    await using fixture = await machine();
    const service = new PodmanService(fixture.exec);
    await using launch = await withHost(() => service.bindLocalLaunch());
    await using lookup = await withHost(() => service.bindLocalLookup());
    expect(launch.identity).toBe(lookup.identity);
    fixture.changeDefault();
    expect((await launch.selection.runtime.instances.inspect(id))?.id).toBe(id);
    const harness = createProcessTestHarness();
    const terminal = createProcessTerminal({
      signal: new AbortController().signal,
      streams: {
        input: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      },
    });
    const child = harness.expectStart();
    const started: number[] = [];
    let exited = false;
    const execution = runWithDependencies(
      [provideProcessManager(harness.manager), provideTerminal(terminal)],
      () =>
        launch.selection.runtime.instances.execAttached(
          id,
          { command: ["agent"] },
          {
            attachStdin: true,
            allocateTerminal: true,
            attachmentStarted: (pid) => {
              started.push(pid);
            },
            attachmentExited: () => {
              exited = true;
            },
          },
        ),
    );
    const request = await child.waitForStart();
    expect(request.args).toEqual(["exec", "-i", "-t", id, "agent"]);
    await fixture.expectPin(request.env);
    expect(started).toEqual([child.pid ?? -1]);
    child.resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    await execution;
    expect(exited).toBe(true);
    expect(
      (await lookup.instances.exec(id, { user: "root", command: ["probe"] }))
        .stdout,
    ).toBe("ready 1\n");
    await expect(withHost(() => lookup.verify())).rejects.toThrow(
      "matching connection",
    );
  },
);

test.skipIf(process.platform === "win32").each([5, 6])(
  "verifies the local context with Podman %i",
  async (major) => {
    await using fixture = await machine(major);
    await using context = await withHost(() =>
      resolvePodmanAttachmentContext(fixture.exec),
    );
    expect(context.hostMounts).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "rejects custom URLs without querying Podman",
  async () => {
    await using fixture = await machine();
    await expect(
      withHost(() => resolvePodmanAttachmentContext(fixture.exec), {
        CONTAINER_HOST: "tcp://private-host:4242",
      }),
    ).rejects.toThrow("matching connection");
    expect(fixture.invocations).toEqual([]);
  },
);
