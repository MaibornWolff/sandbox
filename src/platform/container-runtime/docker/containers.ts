import { ExecError } from "#platform/process/index.js";
import {
  buildContainerExecArgs,
  buildContainerRunArgs,
} from "../command-args.js";
import type {
  ContainerDetails,
  ContainerMount,
  ContainerOperations,
  ContainerQuery,
  ContainerSpec,
  ContainerState,
  TerminalSessionOptions,
} from "../container-contract.js";
import { openContainerExec } from "../exec-stream.js";
import { executeRuntimeCommand } from "../execution.js";
import type { RuntimeExecutor } from "../executor.js";
import { runInteractiveContainerRuntimeProcess } from "../interactive-process.js";
import { followContainerLogs } from "../log-stream.js";
import { SandboxInstanceNameConflictError } from "../sandbox-contract.js";

interface DockerInspection {
  readonly Id?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>> | null;
  };
  readonly State?: { readonly Status?: string; readonly StartedAt?: string };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Source?: string;
    readonly Name?: string;
    readonly Destination?: string;
    readonly RW?: boolean;
  }[];
}

function isMissingContainer(error: unknown): boolean {
  return (
    error instanceof ExecError &&
    /no such container|no container with name or id|container not found/iu.test(
      `${error.stderr}\n${error.stdout}\n${error.message}`,
    )
  );
}

function normalizeState(value: string | undefined): ContainerState {
  switch (value) {
    case "created":
    case "running":
    case "paused":
    case "restarting":
    case "stopping":
    case "exited":
    case "dead":
      return value;
    case "stopped":
      return "exited";
    default:
      return "unknown";
  }
}

function parseMount(
  mount: NonNullable<DockerInspection["Mounts"]>[number],
): ContainerMount | null {
  if (!mount.Destination) return null;
  if (mount.Type === "volume" && mount.Name) {
    return {
      type: "volume",
      volumeName: mount.Name,
      targetPath: mount.Destination,
      readOnly: mount.RW === false,
    };
  }
  if (mount.Type === "bind" && mount.Source) {
    return {
      type: "bind",
      sourcePath: mount.Source,
      targetPath: mount.Destination,
      readOnly: mount.RW === false,
    };
  }
  return null;
}

function parseInspection(output: string, id: string): ContainerDetails {
  let values: unknown;
  try {
    values = JSON.parse(output);
  } catch (error) {
    throw new Error(`Container inspection for ${id} returned invalid JSON.`, {
      cause: error,
    });
  }
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error(`Container inspection for ${id} returned invalid data.`);
  }
  const value = values[0] as DockerInspection;
  if (!value.Id || !value.Config?.Image || !value.Image) {
    throw new Error(`Container inspection for ${id} is missing identity data.`);
  }
  const startedAt = value.State?.StartedAt;
  return {
    id: value.Id,
    name: value.Name?.replace(/^\//u, "") ?? value.Id,
    image: value.Config.Image.replace(/^localhost\//u, ""),
    imageIdentity: value.Image,
    labels: value.Config.Labels ?? {},
    state: normalizeState(value.State?.Status),
    startedAt:
      startedAt && !startedAt.startsWith("0001-") ? new Date(startedAt) : null,
    mounts: (value.Mounts ?? [])
      .map(parseMount)
      .filter((mount): mount is ContainerMount => mount !== null),
  };
}

function queryArguments(query: ContainerQuery): string[] {
  const args = ["ps"];
  if (query.all) args.push("-a");
  for (const [key, value] of Object.entries(query.labels ?? {})) {
    args.push("--filter", `label=${key}${value === null ? "" : `=${value}`}`);
  }
  for (const state of query.states ?? []) {
    args.push("--filter", `status=${state}`);
  }
  args.push("--format", "{{.ID}}");
  return args;
}

export function createDockerContainerOperations(options: {
  readonly binaryName: "docker" | "podman";
  readonly runtime: "docker" | "podman";
  readonly exec: RuntimeExecutor;
  readonly listIdentifiers?: (query: ContainerQuery) => Promise<string[]>;
}): ContainerOperations {
  const { binaryName, runtime, exec } = options;
  const listIdentifiers =
    options.listIdentifiers ??
    (async (query: ContainerQuery): Promise<string[]> => {
      const output = await exec(binaryName, queryArguments(query));
      return output.trim() ? output.trim().split("\n") : [];
    });

  const inspect = async (id: string): Promise<ContainerDetails | null> => {
    try {
      return parseInspection(await exec(binaryName, ["inspect", id]), id);
    } catch (error) {
      if (isMissingContainer(error)) return null;
      throw error;
    }
  };

  const signal = async (id: string, value: NodeJS.Signals): Promise<void> => {
    await exec(binaryName, ["kill", "--signal", value, id]);
  };

  const runAttached = (spec: ContainerSpec, session: TerminalSessionOptions) =>
    runInteractiveContainerRuntimeProcess(
      { binaryName, signalContainer: signal },
      {
        args: buildContainerRunArgs(spec, "attached", runtime),
        signalContainer: spec.name,
        ...(session.title ? { title: session.title } : {}),
        ...(session.forwardSignal
          ? { forwardSignal: session.forwardSignal }
          : {}),
      },
    );

  return {
    async list(query = {}) {
      const details = await Promise.all(
        (await listIdentifiers(query)).map(inspect),
      );
      return details.filter(
        (entry): entry is ContainerDetails => entry !== null,
      );
    },
    inspect,
    async startDetached(spec) {
      const output = await exec(
        binaryName,
        buildContainerRunArgs(spec, "detached", runtime),
      ).catch((error: unknown) => {
        if (
          error instanceof ExecError &&
          /already in use|name is taken/iu.test(
            `${error.stderr}\n${error.stdout}\n${error.message}`,
          )
        ) {
          throw new SandboxInstanceNameConflictError(spec.name, {
            cause: error,
          });
        }
        throw error;
      });
      return output.trim() || spec.name;
    },
    runAttached,
    signal,
    async stopAndRemove(id) {
      await exec(binaryName, ["stop", id]);
      try {
        await exec(binaryName, ["rm", id]);
      } catch (error) {
        if (!isMissingContainer(error)) throw error;
      }
    },
    async remove(id, removeOptions) {
      await exec(binaryName, [
        "rm",
        ...(removeOptions?.force ? ["-f"] : []),
        id,
      ]);
    },
    exec(id, spec) {
      return executeRuntimeCommand(
        exec,
        binaryName,
        buildContainerExecArgs(id, spec),
      );
    },
    async openExec(id, spec) {
      return openContainerExec(
        binaryName,
        buildContainerExecArgs(id, spec, {
          attachStdin: true,
          allocateTerminal: false,
        }),
      );
    },
    execAttached(id, spec, session) {
      return runInteractiveContainerRuntimeProcess(
        { binaryName, signalContainer: signal },
        {
          args: buildContainerExecArgs(id, spec, session),
          ...(session.title ? { title: session.title } : {}),
          ...(session.forwardSignal
            ? { forwardSignal: session.forwardSignal }
            : {}),
        },
      );
    },
    readLogs(id, query) {
      return exec(binaryName, [
        "logs",
        "--tail",
        String(query?.tail ?? 50),
        id,
      ]);
    },
    followLogs(id, request) {
      return followContainerLogs(
        binaryName,
        ["logs", "--follow", "--tail", String(request.tail ?? 200), id],
        request,
      );
    },
  };
}
