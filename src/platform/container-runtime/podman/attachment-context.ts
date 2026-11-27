import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { getHostEnvironment } from "#platform/environment/index.js";
import type { RuntimeExecutor } from "../executor.js";

const connections = z.array(
  z.object({
    Name: z.string(),
    URI: z.string(),
    Identity: z.string().optional(),
    Default: z.boolean(),
    IsMachine: z.boolean().optional(),
  }),
);
const machineName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const machines = z.array(
  z.object({
    Name: machineName,
    Running: z.boolean(),
    Port: z.number().int(),
  }),
);
const inspections = z.array(
  z.object({
    Name: machineName,
    Created: z.string(),
    LastUp: z.string(),
    State: z.string(),
    Rootful: z.boolean(),
    ConfigDir: z.object({ Path: z.string() }),
    SSHConfig: z.object({
      RemoteUsername: z.string(),
      IdentityPath: z.string(),
      Port: z.number().int(),
    }),
  }),
);
const machineFile = z.object({
  Name: machineName,
  Created: z.string(),
  LastUp: z.string(),
  HostUser: z.object({
    UID: z.number().int().nonnegative(),
    Rootful: z.boolean(),
  }),
  Mounts: z.array(z.object({ Source: z.string() })).nullable(),
});
const timeout = () => AbortSignal.timeout(5_000);

function unavailable(): Error {
  return new Error(
    "Foreground-job status requires a running local Podman machine and its matching connection.",
  );
}

function loopbackSsh(raw: string): URL {
  const uri = new URL(raw);
  if (
    uri.protocol !== "ssh:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname) ||
    uri.password ||
    uri.hash ||
    uri.search ||
    !uri.port
  )
    throw unavailable();
  return uri;
}

async function readMachine(
  config: z.infer<typeof inspections>[number],
  uid: number,
) {
  const folder = config.ConfigDir.Path;
  if (!isAbsolute(folder)) throw unavailable();
  const path = join(folder, `${config.Name}.json`);
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0)
    throw unavailable();
  const state = machineFile.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    state.Name !== config.Name ||
    state.Created !== config.Created ||
    state.LastUp !== config.LastUp ||
    state.HostUser.Rootful !== config.Rootful
  ) {
    throw unavailable();
  }
  const hostMounts = await Promise.all(
    (state.Mounts ?? []).map(({ Source }) => {
      if (!isAbsolute(Source)) throw unavailable();
      return realpath(Source);
    }),
  );
  return { ...config, userId: state.HostUser.UID, hostMounts };
}

async function readConfiguredMachines(
  exec: RuntimeExecutor,
  read: (args: readonly string[]) => Promise<unknown>,
  userId: number,
) {
  const version = await exec("podman", ["--version"], {
    private: true,
    signal: timeout(),
  });
  const major = /^podman version ([0-9]+)\./u.exec(version.trim())?.[1];
  if (major !== "5" && major !== "6") throw unavailable();
  // Podman 6 always lists all providers and no longer accepts the flag.
  const providerFlags = major === "5" ? ["--all-providers"] : [];
  const configured = machines.parse(
    await read(["machine", "list", ...providerFlags, "--format=json"]),
  );
  if (
    configured.length === 0 ||
    new Set(configured.map(({ Name }) => Name)).size !== configured.length
  )
    throw unavailable();
  const inspected = inspections.parse(
    await read([
      "machine",
      "inspect",
      "--",
      ...configured.map(({ Name }) => Name),
    ]),
  );
  if (
    inspected.length !== configured.length ||
    configured.some(
      ({ Name, Port, Running }) =>
        !inspected.some(
          (config) =>
            config.Name === Name &&
            config.SSHConfig.Port === Port &&
            (config.State === "running") === Running,
        ),
    )
  )
    throw unavailable();
  return await Promise.all(
    inspected.map((config) => readMachine(config, userId)),
  );
}

async function readContext(exec: RuntimeExecutor) {
  const { platform, variables, userId } = getHostEnvironment();
  if (
    platform !== "darwin" ||
    userId === undefined ||
    variables.CONTAINER_HOST ||
    variables.CONTAINER_SSHKEY
  )
    throw unavailable();
  const read = async (args: readonly string[]): Promise<unknown> =>
    JSON.parse(
      await exec("podman", args, { private: true, signal: timeout() }),
    );
  const active = connections
    .parse(await read(["system", "connection", "list", "--format=json"]))
    .filter((item) =>
      variables.CONTAINER_CONNECTION
        ? item.Name === variables.CONTAINER_CONNECTION
        : item.Default,
    );
  const [connection] = active;
  if (
    !connection ||
    active.length !== 1 ||
    !connection.IsMachine ||
    !connection.Identity ||
    !isAbsolute(connection.Identity)
  )
    throw unavailable();
  const uri = loopbackSsh(connection.URI);
  const local = await readConfiguredMachines(exec, read, userId);
  const matching = local.filter(
    (config) =>
      config.State === "running" && config.SSHConfig.Port === Number(uri.port),
  );
  const [machine] = matching;
  if (
    !machine ||
    matching.length !== 1 ||
    connection.Identity !== machine.SSHConfig.IdentityPath ||
    decodeURIComponent(uri.username) !==
      (machine.Rootful ? "root" : machine.SSHConfig.RemoteUsername)
  )
    throw unavailable();
  const servicePath = machine.Rootful
    ? "/run/podman/podman.sock"
    : `/run/user/${machine.userId}/podman/podman.sock`;
  if (uri.pathname !== servicePath) throw unavailable();
  const key = await lstat(connection.Identity, { bigint: true });
  if (!key.isFile() || key.uid !== BigInt(userId) || (key.mode & 0o077n) !== 0n)
    throw unavailable();
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        connection.URI,
        connection.Identity,
        `${key.dev}:${key.ino}:${key.mtimeNs}`,
        machine.Created,
        machine.LastUp,
      ]),
    )
    .digest("hex");
  const hostMounts = [
    ...new Set(local.flatMap((config) => config.hostMounts)),
  ].sort();
  return {
    connection: {
      URI: connection.URI,
      Identity: connection.Identity,
      IsMachine: true,
    },
    identity,
    hostMounts,
    servicePath,
  };
}

export async function resolvePodmanAttachmentContext(exec: RuntimeExecutor) {
  let directory: string | undefined;
  try {
    const initial = await readContext(exec);
    const name = `sandbox-${randomUUID()}`;
    directory = await mkdtemp(join(tmpdir(), "sandbox-podman-"));
    const path = join(directory, "podman-connections.json");
    const contents = JSON.stringify({
      Connection: {
        Default: name,
        Connections: { [name]: initial.connection },
      },
    });
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    const env = {
      PODMAN_CONNECTIONS_CONF: path,
      CONTAINER_CONNECTION: name,
      CONTAINER_HOST: "",
      CONTAINER_SSHKEY: "",
    };
    const result = await exec(
      "podman",
      ["info", "--format", "{{.Host.RemoteSocket.Path}}"],
      { env, private: true, signal: timeout() },
    );
    if (result.trim().replace(/^unix:\/\//u, "") !== initial.servicePath)
      throw unavailable();
    const cleanup = directory;
    async function verifyPin() {
      try {
        if ((await readFile(path, "utf8")) !== contents) throw unavailable();
      } catch {
        throw unavailable();
      }
    }
    return {
      identity: initial.identity,
      env,
      hostMounts: initial.hostMounts,
      verifyPin,
      async verify() {
        try {
          await verifyPin();
          const current = await readContext(exec);
          if (
            current.identity !== initial.identity ||
            JSON.stringify(current.hostMounts) !==
              JSON.stringify(initial.hostMounts)
          )
            throw unavailable();
        } catch {
          throw unavailable();
        }
      },
      async [Symbol.asyncDispose]() {
        await rm(cleanup, { recursive: true, force: true });
      },
    };
  } catch {
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    throw unavailable();
  }
}
