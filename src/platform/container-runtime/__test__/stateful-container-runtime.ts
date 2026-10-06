import { getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import type {
  ContainerOperations as ContainerOperationGroup,
  ContainerSpec,
  ExecSpec,
  TerminalSessionOptions,
} from "../container-contract.js";
import type {
  ImageBuildSpec,
  ImageCleanupRequest,
  ImageOperations,
} from "../image-contract.js";
import type { SandboxRuntimeProvider } from "../index.js";
import type { Runtime } from "../runtime-types.js";
import {
  createSandboxImageBuilder,
  createSandboxInstanceOperations,
  createSandboxStorageOperations,
  resolveContentAddressedImage,
} from "../sandbox-adapter.js";
import type {
  SandboxRuntime,
  SandboxRuntimeSelection,
} from "../sandbox-contract.js";
import type { VolumeOperations } from "../volume-contract.js";

interface ListContainersOptions {
  readonly all?: boolean;
  readonly labelFilter?: string;
  readonly statusFilter?: string[];
  readonly labelKeys?: string[];
}

interface CreateContainerOptions {
  readonly name: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly labels?: Record<string, string>;
  readonly extraArgs?: string[];
  readonly image: string;
  readonly autoRemove?: boolean;
  readonly mounts?: ContainerSpec["mounts"];
}

interface ContainerExecOptions {
  readonly user?: string;
  readonly workdir?: string;
  readonly env?: Record<string, string>;
}

import {
  createManagedContainer,
  type ManagedContainer,
  type ManagedContainerSnapshot,
  type ManagedContainerState,
  type ManagedContainerValues,
} from "./managed-container.js";
import {
  createManagedImage,
  type ManagedBuildRecord,
  type ManagedBuildResult,
  type ManagedImage,
  type ManagedImageSnapshot,
  type ManagedImageState,
  type ManagedImageValues,
} from "./managed-image.js";
import {
  createManagedVolume,
  type ManagedVolume,
  type ManagedVolumeSnapshot,
  type ManagedVolumeState,
  type ManagedVolumeValues,
} from "./managed-volume.js";

export type ContainerRuntimeEvent =
  | { readonly type: "container.list"; readonly options: ListContainersOptions }
  | {
      readonly type: "container.create";
      readonly options: CreateContainerOptions;
    }
  | {
      readonly type: "container.wait-ready";
      readonly containerId: string;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "container.exec";
      readonly containerId: string;
      readonly command: readonly string[];
      readonly options: ContainerExecOptions;
    }
  | {
      readonly type: "container.exec-attached";
      readonly containerId: string;
      readonly spec: ExecSpec;
      readonly session: TerminalSessionOptions;
    }
  | {
      readonly type: "container.state";
      readonly containerId: string;
    }
  | {
      readonly type: "container.label";
      readonly containerId: string;
      readonly label: string;
    }
  | {
      readonly type: "container.logs";
      readonly containerId: string;
      readonly tail: number;
    }
  | {
      readonly type: "container.uptime";
      readonly containerId: string;
    }
  | {
      readonly type: "container.signal";
      readonly containerId: string;
      readonly signal: NodeJS.Signals;
    }
  | {
      readonly type: "container.stop";
      readonly containerId: string;
    }
  | {
      readonly type: "container.remove";
      readonly containerId: string;
      readonly force: boolean;
    }
  | { readonly type: "image.inspect"; readonly reference: string }
  | { readonly type: "image.build"; readonly options: ImageBuildSpec }
  | { readonly type: "image.cleanup"; readonly request: ImageCleanupRequest }
  | { readonly type: "volume.exists"; readonly name: string }
  | { readonly type: "volume.create"; readonly name: string }
  | { readonly type: "volume.remove"; readonly name: string }
  | { readonly type: "host.ready" }
  | { readonly type: "hint.prune" };

export type RuntimeFailurePoint =
  | "resolve"
  | "version"
  | "memory"
  | "container.list"
  | "container.create"
  | "container.exec"
  | "container.wait-ready"
  | "container.state"
  | "container.label"
  | "container.logs"
  | "container.uptime"
  | "container.signal"
  | "container.stop"
  | "container.remove"
  | "image.inspect"
  | "image.build"
  | "image.remove"
  | "volume.exists"
  | "volume.create"
  | "volume.remove"
  | "host.ready";

export interface StatefulContainerRuntimeHarness {
  readonly provider: SandboxRuntimeProvider;
  readonly instances: {
    create(values: ManagedContainerValues): ManagedContainer;
    find(identifier: string): ManagedContainerSnapshot | undefined;
    all(): readonly ManagedContainerSnapshot[];
  };
  readonly images: {
    create(values: ManagedImageValues): ManagedImage;
    find(identifier: string): ManagedImageSnapshot | undefined;
    all(): readonly ManagedImageSnapshot[];
    givenNextBuild(result: ManagedBuildResult): void;
    builds(): readonly ManagedBuildRecord[];
  };
  readonly storage: {
    create(values: ManagedVolumeValues): ManagedVolume;
    find(name: string): ManagedVolumeSnapshot | undefined;
    all(): readonly ManagedVolumeSnapshot[];
  };
  readonly system: {
    givenVersion(version: string): void;
    givenMemoryBytes(memory: number | null): void;
    givenCompatibilityIdentity(identity: string): void;
    fail(point: RuntimeFailurePoint, error: Error): void;
  };
  events(): readonly ContainerRuntimeEvent[];
  resolvedConfigurations(): readonly (string | undefined)[];
}

interface StatefulContainerRuntimeOptions {
  readonly runtime?: Runtime;
}

interface LegacyContainerOperations {
  listContainers(options?: ListContainersOptions): Promise<
    Array<{
      id: string;
      name: string;
      image: string;
      labels?: Record<string, string>;
    }>
  >;
  createContainer(options: CreateContainerOptions): Promise<void>;
  signalContainer(id: string, signal: NodeJS.Signals): Promise<void>;
  stopContainer(id: string): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  waitUntilContainerReady(identifier: string, timeoutMs: number): Promise<void>;
  execInContainer(
    identifier: string,
    command: string[],
    options?: ContainerExecOptions,
  ): Promise<string>;
  getContainerState(id: string): Promise<string>;
  getContainerLabel(id: string, label: string): Promise<string | null>;
  getContainerLogs(id: string, tail?: number): Promise<string>;
  getContainerUptime(id: string): Promise<string>;
}

function matchesLabel(
  container: ManagedContainerState,
  labelFilter: string | undefined,
): boolean {
  if (!labelFilter) return true;
  const separator = labelFilter.indexOf("=");
  if (separator === -1) return labelFilter in container.labels;
  return (
    container.labels[labelFilter.slice(0, separator)] ===
    labelFilter.slice(separator + 1)
  );
}

function labelsFromArgs(args: readonly string[] = []): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "--label") continue;
    const value = args[index + 1];
    if (!value) continue;
    const separator = value.indexOf("=");
    if (separator === -1) labels[value] = "";
    else labels[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return labels;
}

function cloneBuildOptions(options: ImageBuildSpec): ImageBuildSpec {
  return {
    ...options,
    buildArguments: { ...options.buildArguments },
    labels: { ...options.labels },
    secrets: options.secrets.map((secret) => ({ ...secret })),
  };
}

function cloneRuntimeEvent(
  event: ContainerRuntimeEvent,
): ContainerRuntimeEvent {
  switch (event.type) {
    case "container.list":
      return { ...event, options: { ...event.options } };
    case "container.create":
      return {
        ...event,
        options: {
          ...event.options,
          environment: { ...event.options.environment },
        },
      };
    case "container.exec":
      return {
        ...event,
        command: [...event.command],
        options: { ...event.options },
      };
    case "container.exec-attached":
      return {
        ...event,
        spec: {
          ...event.spec,
          command: [...event.spec.command],
          ...(event.spec.environment
            ? { environment: { ...event.spec.environment } }
            : {}),
        },
        session: { ...event.session },
      };
    case "image.build":
      return { ...event, options: cloneBuildOptions(event.options) };
    default:
      return { ...event };
  }
}

class StatefulRuntimeWorld {
  private readonly runtimeName: Runtime;
  private readonly recordedEvents: ContainerRuntimeEvent[] = [];
  private readonly configurations: Array<string | undefined> = [];
  private readonly containers = new Map<string, ManagedContainerState>();
  private readonly images = new Map<string, ManagedImageState>();
  private readonly volumes = new Map<string, ManagedVolumeState>();
  private readonly failures = new Map<RuntimeFailurePoint, Error>();
  private readonly buildResults: ManagedBuildResult[] = [];
  private readonly buildRecords: ManagedBuildRecord[] = [];
  private version: string;
  private compatibilityIdentity: string;
  private memoryBytes: number | null = 8 * 1024 * 1024 * 1024;
  private nextContainerId = 1;
  private nextImageId = 1;

  constructor(options: StatefulContainerRuntimeOptions) {
    this.runtimeName = options.runtime ?? "docker";
    this.compatibilityIdentity = this.runtimeName;
    this.version = `${
      {
        docker: "Docker",
        podman: "Podman",
        "apple-container": "Apple container",
      }[this.runtimeName]
    } version 24.0.0, build fixture`;
  }

  private takeFailure(point: RuntimeFailurePoint): void {
    const error = this.failures.get(point);
    if (!error) return;
    this.failures.delete(point);
    throw error;
  }

  private findContainer(identifier: string): ManagedContainerState {
    const container =
      this.containers.get(identifier) ??
      [...this.containers.values()].find(
        (candidate) =>
          candidate.name === identifier && candidate.status !== "removed",
      );
    if (!container || container.status === "removed")
      throw new Error(`Container "${identifier}" does not exist.`);
    return container;
  }

  private findImage(identifier: string): ManagedImageState | undefined {
    return (
      this.images.get(identifier) ??
      [...this.images.values()].find((image) =>
        image.references.has(identifier),
      )
    );
  }

  private addContainer(values: ManagedContainerValues): ManagedContainerState {
    const id = values.id ?? `container-${this.nextContainerId++}`;
    const duplicateName = [...this.containers.values()].some(
      (container) =>
        container.name === values.name && container.status !== "removed",
    );
    if (this.containers.has(id) || duplicateName) {
      throw new Error(
        `Container id "${id}" or name "${values.name}" already exists.`,
      );
    }
    const container = createManagedContainer({ ...values, id });
    this.containers.set(id, container);
    return container;
  }

  private addImage(values: ManagedImageValues): ManagedImageState {
    const id = values.id ?? `sha256:image-${this.nextImageId++}`;
    if (this.images.has(id))
      throw new Error(`Image id "${id}" already exists.`);
    for (const reference of values.references ?? []) {
      if (this.findImage(reference))
        throw new Error(`Image reference "${reference}" already exists.`);
    }
    const image = createManagedImage({ ...values, id });
    this.images.set(id, image);
    return image;
  }

  private addVolume(values: ManagedVolumeValues): ManagedVolumeState {
    if (this.volumes.has(values.name))
      throw new Error(`Volume "${values.name}" already exists.`);
    const volume = createManagedVolume(values);
    this.volumes.set(values.name, volume);
    return volume;
  }

  private async buildImage(options: ImageBuildSpec): Promise<void> {
    this.takeFailure("image.build");
    const recordedOptions = cloneBuildOptions(options);
    this.recordedEvents.push({ type: "image.build", options: recordedOptions });
    const result = this.buildResults.shift() ?? {};
    this.buildRecords.push({
      options: recordedOptions,
      ...(result.id ? { imageId: result.id } : {}),
      stdout: [...(result.stdout ?? [])],
      stderr: [...(result.stderr ?? [])],
    });
    if (result.error) throw result.error;
    const previous = this.findImage(options.tag);
    if (previous) {
      previous.references.delete(options.tag);
      previous.dangling = previous.references.size === 0;
    }
    this.addImage({
      ...(result.id ? { id: result.id } : {}),
      references: [options.tag],
      labels: options.labels,
      ...(result.parentId ? { parentId: result.parentId } : {}),
    });
  }

  private containerOperations(): LegacyContainerOperations {
    return {
      listContainers: async (options = {}) => {
        this.takeFailure("container.list");
        this.recordedEvents.push({
          type: "container.list",
          options: { ...options },
        });
        return [...this.containers.values()]
          .filter((container) => container.status !== "removed")
          .filter((container) =>
            options.statusFilter?.length
              ? options.statusFilter.includes(container.status)
              : options.all === true || container.status === "running",
          )
          .filter((container) => matchesLabel(container, options.labelFilter))
          .map(({ id, name, image, labels }) => ({
            id,
            name,
            image,
            ...(options.labelKeys
              ? {
                  labels: Object.fromEntries(
                    options.labelKeys.map((key) => [key, labels[key] ?? ""]),
                  ),
                }
              : {}),
          }));
      },
      createContainer: async (options: CreateContainerOptions) => {
        this.takeFailure("container.create");
        this.recordedEvents.push({
          type: "container.create",
          options: {
            ...options,
            environment: { ...options.environment },
            ...(options.labels ? { labels: { ...options.labels } } : {}),
            ...(options.extraArgs ? { extraArgs: [...options.extraArgs] } : {}),
          },
        });
        this.addContainer({
          name: options.name,
          image: options.image,
          labels: {
            ...labelsFromArgs(options.extraArgs),
            ...options.labels,
          },
          status: "running",
          mounts: options.mounts,
        });
      },
      signalContainer: async (id, signal) => {
        this.takeFailure("container.signal");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.signal",
          containerId: container.id,
          signal,
        });
        container.status = "exited";
      },
      stopContainer: async (id) => {
        this.takeFailure("container.stop");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.stop",
          containerId: container.id,
        });
        container.status = "removed";
      },
      removeContainer: async (id, force = false) => {
        this.takeFailure("container.remove");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.remove",
          containerId: container.id,
          force,
        });
        container.status = "removed";
      },
      waitUntilContainerReady: async (identifier, timeoutMs) => {
        this.takeFailure("container.wait-ready");
        const container = this.findContainer(identifier);
        if (container.status !== "running") {
          throw new Error(`Container "${container.id}" is not running.`);
        }
        this.recordedEvents.push({
          type: "container.wait-ready",
          containerId: container.id,
          timeoutMs,
        });
        container.waitUntilReady(Math.max(1, Math.ceil(timeoutMs / 50)));
      },
      execInContainer: async (identifier, command, options = {}) => {
        this.takeFailure("container.exec");
        const container = this.findContainer(identifier);
        if (container.status !== "running")
          throw new Error(`Container "${container.id}" is not running.`);
        this.recordedEvents.push({
          type: "container.exec",
          containerId: container.id,
          command: [...command],
          options: { ...options },
        });
        return container.resolveExecResult(command);
      },
      getContainerState: async (id) => {
        this.takeFailure("container.state");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.state",
          containerId: container.id,
        });
        return container.status;
      },
      getContainerLabel: async (id, label) => {
        this.takeFailure("container.label");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.label",
          containerId: container.id,
          label,
        });
        return container.labels[label] ?? null;
      },
      getContainerLogs: async (id, tail = 200) => {
        this.takeFailure("container.logs");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.logs",
          containerId: container.id,
          tail,
        });
        if (container.logs instanceof Error) throw container.logs;
        return container.logs;
      },
      getContainerUptime: async (id) => {
        this.takeFailure("container.uptime");
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.uptime",
          containerId: container.id,
        });
        return container.uptime;
      },
    };
  }

  private groupedContainerOperations(
    legacy: LegacyContainerOperations,
  ): ContainerOperationGroup {
    const inspect = async (identifier: string) => {
      try {
        const container = this.findContainer(identifier);
        return {
          id: container.id,
          name: container.name,
          image: container.image,
          imageIdentity: this.findImage(container.image)?.id ?? container.image,
          labels: container.labels,
          state: container.status === "removed" ? "unknown" : container.status,
          startedAt: container.startedAt,
          mounts: container.snapshot().mounts,
        } as const;
      } catch {
        return null;
      }
    };
    const create = async (spec: ContainerSpec): Promise<string> => {
      await legacy.createContainer({
        name: spec.name,
        image: spec.image,
        environment: spec.environment,
        labels: { ...spec.labels },
        autoRemove: spec.removeOnExit,
        mounts: spec.mounts,
      });
      const started = [...this.containers.values()]
        .reverse()
        .find(
          (container) =>
            container.name === spec.name && container.status !== "removed",
        );
      if (!started) throw new Error(`Container "${spec.name}" did not start.`);
      return started.id;
    };
    return {
      async list(query = {}) {
        const entries = await legacy.listContainers({
          all: query.all,
          statusFilter: query.states ? [...query.states] : undefined,
        });
        const inspected = await Promise.all(
          entries.map((entry) => inspect(entry.id)),
        );
        return inspected
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) =>
            Object.entries(query.labels ?? {}).every(([key, value]) =>
              value === null
                ? Object.hasOwn(entry.labels, key)
                : entry.labels[key] === value,
            ),
          );
      },
      inspect,
      startDetached: create,
      async runAttached(spec) {
        await create(spec);
        return getProcessManager().start({
          name: "stateful attached container",
          command: "stateful-container-runtime",
          args: ["run", spec.name],
          lifetime: "application",
          interaction: { mode: "interactive" },
          stdio: "inherit",
        }).result;
      },
      signal: legacy.signalContainer,
      stopAndRemove: legacy.stopContainer,
      remove: (id, options) => legacy.removeContainer(id, options?.force),
      async exec(id, spec) {
        try {
          return {
            exitCode: 0,
            stdout: await legacy.execInContainer(id, [...spec.command], {
              user: spec.user,
              workdir: spec.workingDirectory,
              env: spec.environment ? { ...spec.environment } : undefined,
            }),
            stderr: "",
          };
        } catch (error) {
          if (error instanceof Error && error.message === "exit code 1") {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          throw error;
        }
      },
      execAttached: async (id, spec, session) => {
        const container = this.findContainer(id);
        this.recordedEvents.push({
          type: "container.exec-attached",
          containerId: container.id,
          spec: {
            ...spec,
            command: [...spec.command],
            ...(spec.environment
              ? { environment: { ...spec.environment } }
              : {}),
          },
          session: { ...session },
        });
        return getProcessManager().start({
          name: "stateful attached container execution",
          command: "stateful-container-runtime",
          args: [...spec.command],
          lifetime: "application",
          interaction: {
            mode: "interactive",
            ...(session.title ? { title: session.title } : {}),
            ...(session.forwardSignal
              ? { forwardSignal: session.forwardSignal }
              : {}),
          },
          stdio: "inherit",
          signal: getTerminal().signal,
        }).result;
      },
      readLogs: (id, query) => legacy.getContainerLogs(id, query?.tail),
      followLogs: (id, request) => {
        this.findContainer(id);
        const child = getProcessManager().start({
          name: "container log stream",
          command: "stateful-container-runtime",
          args: ["logs", id],
          lifetime: "application",
          interaction: { mode: "non-interactive" },
          stdio: "ignore",
          stdin: "ignore",
          onStdout: request.onOutput,
          onStderr: request.onError,
        });
        const stop = async (): Promise<void> => {
          await child.stop();
        };
        return {
          completion: child.result,
          stop,
          async [Symbol.asyncDispose]() {
            await stop();
          },
        };
      },
    };
  }

  private imageOperations(): ImageOperations {
    const inspect = async (reference: string) => {
      this.takeFailure("image.inspect");
      this.recordedEvents.push({ type: "image.inspect", reference });
      const image = this.findImage(reference);
      if (!image) return null;
      return {
        id: image.id,
        references: [...image.references],
        labels: { ...image.labels },
        sizeBytes: image.size,
      };
    };
    const isUsed = (identifier: string): boolean => {
      const image = this.findImage(identifier);
      const references = image
        ? new Set([image.id, ...image.references])
        : new Set([identifier]);
      return [...this.containers.values()].some(
        (container) =>
          container.status !== "removed" && references.has(container.image),
      );
    };
    return {
      inspect,
      build: async (options) => {
        await this.buildImage(options);
        const image = this.findImage(options.tag);
        if (!image) throw new Error(`No such image: ${options.tag}`);
        return {
          id: image.id,
          references: [...image.references],
          labels: { ...image.labels },
          sizeBytes: image.size,
        };
      },
      removeUnused: async (request) => {
        this.recordedEvents.push({
          type: "image.cleanup",
          request: {
            candidates: [...request.candidates],
            managedLabel: { ...request.managedLabel },
          },
        });
        const removed: Array<{
          id: string;
          estimatedReclaimedBytes: number;
        }> = [];
        const skipped: Array<{
          id: string;
          reason: "missing" | "unmanaged" | "tagged" | "in-use";
        }> = [];
        for (const id of new Set(request.candidates)) {
          const image = this.findImage(id);
          if (!image) {
            skipped.push({ id, reason: "missing" });
          } else if (
            image.labels[request.managedLabel.key] !==
            request.managedLabel.value
          ) {
            skipped.push({ id, reason: "unmanaged" });
          } else if (image.references.size > 0) {
            skipped.push({ id, reason: "tagged" });
          } else if (isUsed(id)) {
            skipped.push({ id, reason: "in-use" });
          } else {
            this.takeFailure("image.remove");
            this.images.delete(image.id);
            removed.push({ id, estimatedReclaimedBytes: image.size });
          }
        }
        return {
          removed,
          skipped,
          estimatedReclaimedBytes: removed.reduce(
            (total, image) => total + image.estimatedReclaimedBytes,
            0,
          ),
        };
      },
    };
  }

  private volumeOperations(): VolumeOperations {
    return {
      exists: async (name) => {
        this.takeFailure("volume.exists");
        this.recordedEvents.push({ type: "volume.exists", name });
        return this.volumes.has(name);
      },
      create: async (name) => {
        this.takeFailure("volume.create");
        this.recordedEvents.push({ type: "volume.create", name });
        this.addVolume({ name });
      },
      remove: async (request) => {
        this.takeFailure("volume.remove");
        const volume = this.volumes.get(request.name);
        if (!volume) throw new Error(`No such volume: ${request.name}`);
        const reference = [...this.containers.values()].find(
          (container) =>
            container.status !== "removed" &&
            container
              .snapshot()
              .mounts?.some(
                (mount) =>
                  mount.type === "volume" && mount.volumeName === request.name,
              ),
        );
        if (reference) {
          throw new Error(
            `Volume ${request.name} is referenced by container ${reference.id}.`,
          );
        }
        this.recordedEvents.push({ type: "volume.remove", name: request.name });
        this.volumes.delete(request.name);
      },
    };
  }

  private createRuntime(): SandboxRuntimeSelection {
    const legacyContainers = this.containerOperations();
    const containers = this.groupedContainerOperations(legacyContainers);
    const images = this.imageOperations();
    const volumes = this.volumeOperations();
    const runtime: SandboxRuntime = {
      runtime: this.runtimeName,
      instances: createSandboxInstanceOperations(
        containers,
        resolveContentAddressedImage,
      ),
      storage: createSandboxStorageOperations(volumes),
      ensureHostReady: async () => {
        this.takeFailure("host.ready");
        this.takeFailure("version");
        this.takeFailure("memory");
        this.recordedEvents.push({ type: "host.ready" });
        return {
          version: this.version,
          hostAccessName: {
            docker: "host.docker.internal",
            podman: "host.containers.internal",
            "apple-container": "host.container.internal",
          }[this.runtimeName],
          memory:
            this.memoryBytes === null
              ? { bytes: null, scope: "unknown" }
              : {
                  bytes: this.memoryBytes,
                  scope:
                    this.runtimeName === "apple-container"
                      ? "per-instance-default"
                      : "shared-runtime-vm",
                },
        } as const;
      },
      getCompatibilityIdentity: async () => this.compatibilityIdentity,
      getDiskSpaceAdvice: () => {
        this.recordedEvents.push({ type: "hint.prune" });
        return `${this.runtimeName} system prune`;
      },
    };
    return {
      runtime,
      imageBuilder: createSandboxImageBuilder(
        images,
        resolveContentAddressedImage,
      ),
      imageOwnershipKey: this.runtimeName,
    };
  }

  private cloneEvents(): readonly ContainerRuntimeEvent[] {
    return this.recordedEvents.map(cloneRuntimeEvent);
  }

  createHarness(): StatefulContainerRuntimeHarness {
    const runtime = this.createRuntime();
    return {
      provider: {
        resolve: async (request) => {
          const configuredRuntime = request?.configuredRuntime;
          this.configurations.push(configuredRuntime);
          this.takeFailure("resolve");
          if (configuredRuntime && configuredRuntime !== this.runtimeName) {
            throw new Error(
              `Configured runtime "${configuredRuntime}" is not available in this fixture.`,
            );
          }
          return runtime;
        },
      },
      instances: {
        create: (values) => this.addContainer(values),
        find: (identifier) => {
          try {
            return this.findContainer(identifier).snapshot();
          } catch {
            return undefined;
          }
        },
        all: () =>
          [...this.containers.values()].map((container) =>
            container.snapshot(),
          ),
      },
      images: {
        create: (values) => this.addImage(values),
        find: (identifier) => this.findImage(identifier)?.snapshot(),
        all: () => [...this.images.values()].map((image) => image.snapshot()),
        givenNextBuild: (result) => this.buildResults.push(result),
        builds: () =>
          this.buildRecords.map((build) => ({
            ...build,
            options: cloneBuildOptions(build.options),
            stdout: [...build.stdout],
            stderr: [...build.stderr],
          })),
      },
      storage: {
        create: (values) => this.addVolume(values),
        find: (name) => this.volumes.get(name)?.snapshot(),
        all: () =>
          [...this.volumes.values()].map((volume) => volume.snapshot()),
      },
      system: {
        givenVersion: (value) => {
          this.version = value;
        },
        givenMemoryBytes: (value) => {
          this.memoryBytes = value;
        },
        givenCompatibilityIdentity: (value) => {
          this.compatibilityIdentity = value;
        },
        fail: (point, error) => this.failures.set(point, error),
      },
      events: () => this.cloneEvents(),
      resolvedConfigurations: () => [...this.configurations],
    };
  }
}

export function createStatefulContainerRuntimeHarness(
  options: StatefulContainerRuntimeOptions = {},
): StatefulContainerRuntimeHarness {
  return new StatefulRuntimeWorld(options).createHarness();
}
