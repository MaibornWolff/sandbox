import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  ExecError,
  type ManagedProcess,
  type ProcessResult,
} from "#platform/process/index.js";
import type {
  ContainerDetails,
  ContainerMount,
  ContainerOperations,
  ContainerQuery,
  ContainerSpec,
  TerminalSessionOptions,
} from "../container-contract.js";
import { openContainerExec } from "../exec-stream.js";
import { executeRuntimeCommand } from "../execution.js";
import type { RuntimeExecutor } from "../executor.js";
import {
  runInteractiveContainerRuntimeProcess,
  startInteractiveContainerRuntimeProcess,
} from "../interactive-process.js";
import { followContainerLogs } from "../log-stream.js";
import {
  SandboxInstanceNameConflictError,
  type SandboxInstanceReference,
  type SandboxInstanceSpec,
} from "../sandbox-contract.js";
import {
  buildAppleCreateArgs,
  buildAppleExecArgs,
  buildAppleStartArgs,
} from "./arguments.js";
import type {
  AppleNetworkOperations,
  AppleRunNetworkPlan,
} from "./networking.js";
import {
  isMissingAppleResource,
  parseAppleContainer,
  parseAppleContainerArray,
} from "./parsing.js";
import { initializeAppleVolumeMounts } from "./volumes.js";

const BINARY_NAME = "container";

export interface AppleContainerOperations extends ContainerOperations {
  startSandboxDetached(
    spec: SandboxInstanceSpec,
  ): Promise<SandboxInstanceReference>;
  runSandboxAttached(
    spec: SandboxInstanceSpec,
    session: TerminalSessionOptions,
  ): Promise<ProcessResult>;
}

function toContainerSpec(spec: SandboxInstanceSpec): ContainerSpec {
  return {
    ...spec,
    image: spec.image.reference,
    mounts: spec.mounts.map((mount) =>
      mount.type === "workspace"
        ? {
            type: "bind" as const,
            sourcePath: mount.sourcePath,
            targetPath: mount.targetPath,
            readOnly: mount.readOnly,
          }
        : {
            type: "volume" as const,
            volumeName: mount.storage.id,
            targetPath: mount.targetPath,
            readOnly: mount.readOnly,
          },
    ),
    ports: spec.ports.map((port) => ({
      ...port,
      containerPort: port.instancePort,
    })),
    security: {
      capabilities: spec.security.capabilities,
      dockerInDocker: spec.security.nestedContainerRuntime,
    },
  };
}

function hasStarted(container: ContainerDetails): boolean {
  return container.state === "running" || container.startedAt !== null;
}

async function waitForForegroundAttachment(options: {
  readonly completion: Promise<ProcessResult>;
  readonly inspect: (id: string) => Promise<ContainerDetails | null>;
  readonly name: string;
}): Promise<boolean> {
  const completion = options.completion.then(
    () => "completed" as const,
    () => "completed" as const,
  );
  while (true) {
    const state = await Promise.race([
      completion,
      options
        .inspect(options.name)
        .then((container) =>
          container && hasStarted(container) ? "attached" : "pending",
        ),
    ]);
    if (state !== "pending") return state === "attached";
    await Promise.race([completion, getClock().sleep(50)]);
  }
}

function matchesQuery(
  container: ContainerDetails,
  query: ContainerQuery,
): boolean {
  const matchesLabels = Object.entries(query.labels ?? {}).every(
    ([key, value]) =>
      value === null
        ? Object.hasOwn(container.labels, key)
        : container.labels[key] === value,
  );
  const matchesState =
    !query.states?.length || query.states.includes(container.state);
  return matchesLabels && matchesState;
}

function createInspect(
  exec: RuntimeExecutor,
  getVolumeRoot: () => string,
): (id: string) => Promise<ContainerDetails | null> {
  return async (id) => {
    let output: string;
    try {
      output = await exec(BINARY_NAME, ["inspect", id]);
    } catch (error) {
      if (isMissingAppleResource(error)) return null;
      throw error;
    }
    const values = parseAppleContainerArray(output, "container inspection");
    const value = values.length === 1 ? values[0] : undefined;
    if (!value) {
      throw new Error(
        `Apple container inspection for ${id} returned invalid data.`,
      );
    }
    return parseAppleContainer(value, getVolumeRoot);
  };
}

function createAttachedRunner(options: {
  readonly start: (
    id: string,
    session: TerminalSessionOptions,
  ) => ManagedProcess<ProcessResult>;
  readonly inspect: (id: string) => Promise<ContainerDetails | null>;
  readonly remove: (id: string, force: boolean) => Promise<void>;
}) {
  const cleanupFailure = async (id: string): Promise<void> => {
    getLogger().debug(`Removing failed Apple instance ${chalk.cyan(id)}`);
    try {
      await options.remove(id, true);
    } catch (error) {
      if (!isMissingAppleResource(error)) {
        getLogger().warn(
          `Could not remove failed Apple instance ${chalk.cyan(id)}: ${error}`,
        );
      }
    }
  };

  const cleanupUnstarted = async (id: string): Promise<void> => {
    try {
      const container = await options.inspect(id);
      if (container && !hasStarted(container)) await cleanupFailure(id);
    } catch (error) {
      getLogger().warn(
        `Could not check startup of Apple instance ${chalk.cyan(id)}. The instance was retained: ${error}`,
      );
    }
  };

  return async (
    id: string,
    session: TerminalSessionOptions,
    resources: AsyncDisposableStack,
  ): Promise<ProcessResult> => {
    let attached = false;
    try {
      await using child = options.start(id, session);
      attached = await waitForForegroundAttachment({
        completion: child.result,
        inspect: options.inspect,
        name: id,
      });
      await resources.disposeAsync().catch((error: unknown) => {
        getLogger().warn(
          `Could not release Apple network discovery resources: ${error}`,
        );
      });
      const result = await child.result;
      if (!attached && result.exitCode !== 0) await cleanupUnstarted(id);
      return result;
    } catch (error) {
      if (!attached) await cleanupFailure(id);
      throw error;
    }
  };
}

function createNativeContainerCreator(options: {
  readonly exec: RuntimeExecutor;
  readonly getVolumeRoot: () => string;
  readonly resolveMountSource: (mount: ContainerMount) => string;
}) {
  return async (
    spec: ContainerSpec,
    network: AppleRunNetworkPlan,
    allocateTerminal: boolean,
  ): Promise<string> => {
    if (spec.mounts.some((mount) => mount.type === "volume")) {
      await initializeAppleVolumeMounts({
        volumeRoot: options.getVolumeRoot(),
        spec,
        exec: options.exec,
      });
    }
    const args = buildAppleCreateArgs(spec, {
      allocateTerminal,
      resolveMountSource: options.resolveMountSource,
      ...(network.dns ? { dns: network.dns } : {}),
      networkName: network.networkName,
      environment: network.environment,
    });
    const output = await options
      .exec(BINARY_NAME, args)
      .catch((error: unknown) => {
        if (
          error instanceof ExecError &&
          /container already exists:/iu.test(
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
  };
}

export function createAppleContainerOperations(options: {
  readonly exec: RuntimeExecutor;
  readonly getVolumeRoot: () => string;
  readonly resolveMountSource: (mount: ContainerMount) => string;
  readonly networking: AppleNetworkOperations;
}): AppleContainerOperations {
  const { exec, getVolumeRoot, resolveMountSource, networking } = options;
  const inspect = createInspect(exec, getVolumeRoot);

  const signal = async (id: string, value: NodeJS.Signals): Promise<void> => {
    await exec(BINARY_NAME, ["kill", "--signal", value, id]);
  };

  const create = createNativeContainerCreator({
    exec,
    getVolumeRoot,
    resolveMountSource,
  });

  const deleteCreated = async (id: string, force: boolean): Promise<void> => {
    await exec(BINARY_NAME, ["delete", ...(force ? ["-f"] : []), id]);
  };

  const createValidated = async (
    spec: SandboxInstanceSpec,
    network: AppleRunNetworkPlan,
    allocateTerminal: boolean,
  ): Promise<string> => {
    const id = await create(toContainerSpec(spec), network, allocateTerminal);
    let created: ContainerDetails | null;
    try {
      created = await inspect(id);
    } catch (error) {
      await deleteCreated(id, false);
      throw error;
    }
    if (created?.imageIdentity !== spec.image.digest) {
      await deleteCreated(id, false);
      throw new Error(
        `Apple created instance ${id} from ${created?.imageIdentity ?? "an unknown image"}, expected ${spec.image.digest}. The image reference changed before startup.`,
      );
    }
    return id;
  };

  const startAttached = (
    id: string,
    session: TerminalSessionOptions,
  ): ManagedProcess<ProcessResult> =>
    startInteractiveContainerRuntimeProcess(
      { binaryName: BINARY_NAME, signalContainer: signal },
      {
        args: buildAppleStartArgs(id, session),
        signalContainer: id,
        ...(session.title ? { title: session.title } : {}),
        ...(session.forwardSignal
          ? { forwardSignal: session.forwardSignal }
          : {}),
      },
    );

  const runCreatedAttached = createAttachedRunner({
    start: startAttached,
    inspect,
    remove: deleteCreated,
  });

  return {
    async list(query = {}) {
      const output = await exec(BINARY_NAME, [
        "list",
        ...(query.all ? ["-a"] : []),
        "--format",
        "json",
      ]);
      return parseAppleContainerArray(output, "container list")
        .map((value) => parseAppleContainer(value, getVolumeRoot))
        .filter((container) => matchesQuery(container, query));
    },
    inspect,
    async startDetached(spec) {
      await using network = await networking.prepareRun();
      const id = await create(spec, network, false);
      try {
        await exec(BINARY_NAME, buildAppleStartArgs(id));
      } catch (error) {
        await deleteCreated(id, true);
        throw error;
      }
      return id;
    },
    async runAttached(spec, session) {
      await using resources = new AsyncDisposableStack();
      const network = resources.use(await networking.prepareRun());
      const id = await create(spec, network, session.allocateTerminal);
      return await runCreatedAttached(id, session, resources);
    },
    async startSandboxDetached(spec) {
      await using network = await networking.prepareRun();
      const id = await createValidated(spec, network, false);
      try {
        await exec(BINARY_NAME, buildAppleStartArgs(id));
      } catch (error) {
        await deleteCreated(id, true);
        throw error;
      }
      return { id };
    },
    async runSandboxAttached(spec, session) {
      await using resources = new AsyncDisposableStack();
      const network = resources.use(await networking.prepareRun());
      const id = await createValidated(spec, network, session.allocateTerminal);
      return await runCreatedAttached(id, session, resources);
    },
    signal,
    async stopAndRemove(id) {
      await exec(BINARY_NAME, ["stop", id]);
      try {
        await exec(BINARY_NAME, ["delete", id]);
      } catch (error) {
        if (!isMissingAppleResource(error)) throw error;
      }
    },
    async remove(id, removeOptions) {
      await exec(BINARY_NAME, [
        "delete",
        ...(removeOptions?.force ? ["-f"] : []),
        id,
      ]);
    },
    exec(id, spec) {
      return executeRuntimeCommand(
        exec,
        BINARY_NAME,
        buildAppleExecArgs(id, spec),
      );
    },
    async openExec(id, spec) {
      return openContainerExec(
        BINARY_NAME,
        buildAppleExecArgs(id, spec, {
          attachStdin: true,
          allocateTerminal: false,
        }),
      );
    },
    execAttached(id, spec, session) {
      return runInteractiveContainerRuntimeProcess(
        { binaryName: BINARY_NAME, signalContainer: signal },
        {
          args: buildAppleExecArgs(id, spec, session),
          ...(session.title ? { title: session.title } : {}),
          ...(session.forwardSignal
            ? { forwardSignal: session.forwardSignal }
            : {}),
        },
      );
    },
    readLogs(id, query) {
      return exec(BINARY_NAME, ["logs", "-n", String(query?.tail ?? 50), id]);
    },
    followLogs(id, request) {
      return followContainerLogs(
        BINARY_NAME,
        ["logs", "--follow", "-n", String(request.tail ?? 200), id],
        request,
      );
    },
  };
}
