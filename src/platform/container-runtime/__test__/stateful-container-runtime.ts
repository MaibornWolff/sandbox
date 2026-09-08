import type {
  ContainerExecOptions,
  ContainerRuntime,
  ContainerRuntimeProvider,
  CreateContainerOptions,
  ImageBuildOptions,
  ListContainersOptions,
  RuntimeFlagsConfig,
} from "../index.js";
import type { Runtime } from "../runtime-types.js";
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
  | { readonly type: "system.version" }
  | { readonly type: "system.memory" }
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
  | { readonly type: "image.references.list" }
  | { readonly type: "image.exists"; readonly reference: string }
  | {
      readonly type: "image.inspect";
      readonly reference: string;
      readonly labelKeys: readonly string[];
    }
  | {
      readonly type: "image.label";
      readonly reference: string;
      readonly label: string;
    }
  | { readonly type: "image.id"; readonly reference: string }
  | { readonly type: "image.build"; readonly options: ImageBuildOptions }
  | {
      readonly type: "image.pull";
      readonly reference: string;
      readonly interactive: boolean;
    }
  | {
      readonly type: "image.tag";
      readonly source: string;
      readonly target: string;
    }
  | { readonly type: "image.remove"; readonly identifier: string }
  | { readonly type: "image.dangling.list"; readonly referencePattern: string }
  | { readonly type: "image.containers.list"; readonly identifier: string }
  | { readonly type: "volume.exists"; readonly name: string }
  | { readonly type: "volume.create"; readonly name: string }
  | {
      readonly type: "volume.copy";
      readonly source: string;
      readonly target: string;
    }
  | { readonly type: "volume.remove"; readonly name: string }
  | {
      readonly type: "runtime.run-flags";
      readonly config: Readonly<RuntimeFlagsConfig>;
    }
  | { readonly type: "runtime.build-env" }
  | {
      readonly type: "runtime.build-secret-args";
      readonly secretName: string;
      readonly envVar: string;
    }
  | { readonly type: "host.internal-dns" }
  | { readonly type: "host.setup" }
  | { readonly type: "hint.prune" }
  | { readonly type: "hint.install" };

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
  | "image.references.list"
  | "image.exists"
  | "image.inspect"
  | "image.label"
  | "image.id"
  | "image.build"
  | "image.pull"
  | "image.tag"
  | "image.remove"
  | "image.dangling.list"
  | "image.containers.list"
  | "volume.exists"
  | "volume.create"
  | "volume.copy"
  | "volume.remove"
  | "host.setup";

export interface StatefulContainerRuntimeHarness {
  readonly provider: ContainerRuntimeProvider;
  readonly containers: {
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
  readonly volumes: {
    create(values: ManagedVolumeValues): ManagedVolume;
    find(name: string): ManagedVolumeSnapshot | undefined;
    all(): readonly ManagedVolumeSnapshot[];
  };
  readonly system: {
    givenVersion(version: string): void;
    givenMemoryBytes(memory: number | null): void;
    givenHostSetupReady(): void;
    givenHostSetupFailure(error: Error): void;
    fail(point: RuntimeFailurePoint, error: Error): void;
  };
  events(): readonly ContainerRuntimeEvent[];
  resolvedConfigurations(): readonly (string | undefined)[];
}

interface StatefulContainerRuntimeOptions {
  readonly runtime?: Runtime;
}

type ContainerOperations = Pick<
  ContainerRuntime,
  | "listContainers"
  | "createContainer"
  | "signalContainer"
  | "stopContainer"
  | "removeContainer"
  | "waitUntilContainerReady"
  | "execInContainer"
  | "getContainerState"
  | "getContainerLabel"
  | "getContainerLogs"
  | "getContainerUptime"
>;

type ImageOperations = Pick<
  ContainerRuntime,
  | "listImageReferences"
  | "imageExists"
  | "inspectImage"
  | "getImageLabel"
  | "getImageId"
  | "buildImage"
  | "pullImage"
  | "tagImage"
  | "removeImage"
  | "listDanglingImages"
  | "getContainersUsingImage"
>;

type VolumeOperations = Pick<
  ContainerRuntime,
  "volumeExists" | "createVolume" | "copyVolume" | "removeVolume"
>;

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

function cloneBuildOptions(options: ImageBuildOptions): ImageBuildOptions {
  return {
    ...options,
    ...(options.buildArgs ? { buildArgs: { ...options.buildArgs } } : {}),
    ...(options.labels ? { labels: { ...options.labels } } : {}),
    ...(options.secrets
      ? { secrets: options.secrets.map((secret) => ({ ...secret })) }
      : {}),
    ...(options.extraArgs ? { extraArgs: [...options.extraArgs] } : {}),
  };
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
  private memoryBytes: number | null = 8 * 1024 * 1024 * 1024;
  private hostSetupError: Error | undefined;
  private nextContainerId = 1;
  private nextImageId = 1;

  constructor(options: StatefulContainerRuntimeOptions) {
    this.runtimeName = options.runtime ?? "docker";
    this.version = `${this.runtimeName === "docker" ? "Docker" : "Podman"} version 24.0.0, build fixture`;
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
        (candidate) => candidate.name === identifier,
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

  private removeImageReference(identifier: string): void {
    const image = this.findImage(identifier);
    if (!image) throw new Error(`No such image: ${identifier}`);
    if (image.references.has(identifier)) {
      image.references.delete(identifier);
      image.dangling = image.references.size === 0;
      return;
    }
    this.images.delete(image.id);
  }

  private async buildImage(options: ImageBuildOptions): Promise<void> {
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

  private containerOperations(): ContainerOperations {
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
        return container.resolveExecResult(command, options);
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

  private imageOperations(): ImageOperations {
    return {
      listImageReferences: async () => {
        this.takeFailure("image.references.list");
        this.recordedEvents.push({ type: "image.references.list" });
        return [...this.images.values()].flatMap((image) => [
          ...image.references,
        ]);
      },
      imageExists: async (reference) => {
        this.takeFailure("image.exists");
        this.recordedEvents.push({ type: "image.exists", reference });
        return this.findImage(reference) !== undefined;
      },
      inspectImage: async (reference, labelKeys = []) => {
        this.takeFailure("image.inspect");
        this.recordedEvents.push({
          type: "image.inspect",
          reference,
          labelKeys: [...labelKeys],
        });
        const image = this.findImage(reference);
        if (!image) return null;
        return {
          id: image.id,
          labels: Object.fromEntries(
            labelKeys.map((key) => [key, image.labels[key] ?? null]),
          ),
        };
      },
      getImageLabel: async (reference, label) => {
        this.takeFailure("image.label");
        this.recordedEvents.push({ type: "image.label", reference, label });
        return this.findImage(reference)?.labels[label] ?? null;
      },
      getImageId: async (reference) => {
        this.takeFailure("image.id");
        this.recordedEvents.push({ type: "image.id", reference });
        const image = this.findImage(reference);
        if (!image) throw new Error(`No such image: ${reference}`);
        return image.id;
      },
      buildImage: (options) => this.buildImage(options),
      pullImage: async (reference, interactive = false) => {
        this.takeFailure("image.pull");
        this.recordedEvents.push({
          type: "image.pull",
          reference,
          interactive,
        });
        if (!this.findImage(reference)) {
          this.addImage({ references: [reference] });
        }
      },
      tagImage: async (source, target) => {
        this.takeFailure("image.tag");
        this.recordedEvents.push({ type: "image.tag", source, target });
        const image = this.findImage(source);
        if (!image) throw new Error(`No such image: ${source}`);
        const existing = this.findImage(target);
        if (existing && existing.id !== image.id)
          throw new Error(`Image reference "${target}" already exists.`);
        image.references.add(target);
        image.dangling = false;
      },
      removeImage: async (identifier) => {
        this.takeFailure("image.remove");
        this.recordedEvents.push({ type: "image.remove", identifier });
        this.removeImageReference(identifier);
      },
      listDanglingImages: async (referencePattern) => {
        this.takeFailure("image.dangling.list");
        this.recordedEvents.push({
          type: "image.dangling.list",
          referencePattern,
        });
        return [...this.images.values()]
          .filter((image) => image.dangling)
          .map(({ id, size, created }) => ({ id, size, created }));
      },
      getContainersUsingImage: async (identifier) => {
        this.takeFailure("image.containers.list");
        this.recordedEvents.push({
          type: "image.containers.list",
          identifier,
        });
        const image = this.findImage(identifier);
        const references = image
          ? new Set([image.id, ...image.references])
          : new Set([identifier]);
        return [...this.containers.values()]
          .filter(
            (container) =>
              container.status !== "removed" && references.has(container.image),
          )
          .map((container) => container.id);
      },
    };
  }

  private volumeOperations(): VolumeOperations {
    return {
      volumeExists: async (name) => {
        this.takeFailure("volume.exists");
        this.recordedEvents.push({ type: "volume.exists", name });
        return this.volumes.has(name);
      },
      createVolume: async (name) => {
        this.takeFailure("volume.create");
        this.recordedEvents.push({ type: "volume.create", name });
        this.addVolume({ name });
      },
      copyVolume: async (source, target) => {
        this.takeFailure("volume.copy");
        this.recordedEvents.push({ type: "volume.copy", source, target });
        const sourceVolume = this.volumes.get(source);
        const targetVolume = this.volumes.get(target);
        if (!sourceVolume || !targetVolume)
          throw new Error("Source or target volume does not exist.");
        targetVolume.files = { ...sourceVolume.files };
      },
      removeVolume: async (name) => {
        this.takeFailure("volume.remove");
        this.recordedEvents.push({ type: "volume.remove", name });
        if (!this.volumes.delete(name))
          throw new Error(`No such volume: ${name}`);
      },
    };
  }

  private createRuntime(): ContainerRuntime {
    return {
      runtime: this.runtimeName,
      binaryName: this.runtimeName,
      getVersion: async () => {
        this.takeFailure("version");
        this.recordedEvents.push({ type: "system.version" });
        return this.version;
      },
      getMemoryBytes: async () => {
        this.takeFailure("memory");
        this.recordedEvents.push({ type: "system.memory" });
        return this.memoryBytes;
      },
      ...this.containerOperations(),
      ...this.imageOperations(),
      ...this.volumeOperations(),
      getRuntimeRunFlags: (config = {}) => {
        this.recordedEvents.push({
          type: "runtime.run-flags",
          config: Object.freeze({ ...config }),
        });
        const flags = [
          ...(this.runtimeName === "podman"
            ? ["--network=private", "--cgroups=disabled"]
            : []),
          "--cap-add=NET_ADMIN",
          "--sysctl=net.ipv4.tcp_tw_reuse=1",
          "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
          "--sysctl=net.ipv4.tcp_fin_timeout=10",
          "--ulimit",
          this.runtimeName === "podman"
            ? "nofile=65535:65535"
            : "nofile=65536:65536",
        ];
        if (config.shmSize) flags.push("--shm-size", config.shmSize);
        return flags;
      },
      getBuildEnv: () => {
        this.recordedEvents.push({ type: "runtime.build-env" });
        const environment: Record<string, string> =
          this.runtimeName === "docker" ? { DOCKER_BUILDKIT: "1" } : {};
        return environment;
      },
      getBuildSecretArgs: (secretName, envVar) => {
        this.recordedEvents.push({
          type: "runtime.build-secret-args",
          secretName,
          envVar,
        });
        return this.runtimeName === "docker"
          ? ["--secret", `id=${secretName},env=${envVar}`]
          : ["--build-arg", `${secretName}=$${secretName}`];
      },
      getHostInternalDns: () => {
        this.recordedEvents.push({ type: "host.internal-dns" });
        return this.runtimeName === "docker"
          ? "host.docker.internal"
          : "host.containers.internal";
      },
      ensureHostSetup: async () => {
        this.takeFailure("host.setup");
        this.recordedEvents.push({ type: "host.setup" });
        if (this.hostSetupError) throw this.hostSetupError;
        return { memoryBytes: this.memoryBytes };
      },
      getPruneHint: () => {
        this.recordedEvents.push({ type: "hint.prune" });
        return `${this.runtimeName} system prune`;
      },
      getInstallHint: () => {
        this.recordedEvents.push({ type: "hint.install" });
        return this.runtimeName === "docker"
          ? "Install Docker: https://docs.docker.com/get-docker/"
          : "Install Podman: https://podman.io/getting-started/installation";
      },
    };
  }

  private cloneEvents(): readonly ContainerRuntimeEvent[] {
    return this.recordedEvents.map((event) => {
      if (event.type === "container.list")
        return { ...event, options: { ...event.options } };
      if (event.type === "container.create")
        return {
          ...event,
          options: {
            ...event.options,
            ...(event.options.labels
              ? { labels: { ...event.options.labels } }
              : {}),
            ...(event.options.extraArgs
              ? { extraArgs: [...event.options.extraArgs] }
              : {}),
          },
        };
      if (event.type === "container.exec")
        return {
          ...event,
          command: [...event.command],
          options: { ...event.options },
        };
      if (event.type === "image.build")
        return { ...event, options: cloneBuildOptions(event.options) };
      return { ...event };
    });
  }

  createHarness(): StatefulContainerRuntimeHarness {
    const runtime = this.createRuntime();
    return {
      provider: {
        resolve: async (configuredRuntime) => {
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
      containers: {
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
      volumes: {
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
        givenHostSetupReady: () => {
          this.hostSetupError = undefined;
        },
        givenHostSetupFailure: (error) => {
          this.hostSetupError = error;
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
