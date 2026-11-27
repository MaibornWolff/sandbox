import type {
  ContainerOperations,
  ContainerQuery,
  ContainerState,
} from "../container-contract.js";
import { createDockerContainerOperations } from "../docker/containers.js";
import { createDockerImageOperations } from "../docker/images.js";
import { createDockerVolumeOperations } from "../docker/volumes.js";
import type { RuntimeExecutor } from "../executor.js";
import type { ImageOperations } from "../image-contract.js";
import type { RuntimeDefinition } from "../runtime-definition.js";
import {
  createSandboxImageBuilder,
  createSandboxInstanceOperations,
  createSandboxStorageOperations,
  resolveContentAddressedImage,
} from "../sandbox-adapter.js";
import type {
  SandboxAttachmentLaunch,
  SandboxAttachmentLookup,
  SandboxImageBuilder,
  SandboxInstanceOperations,
  SandboxRuntime,
  SandboxRuntimeInfo,
  SandboxStorageOperations,
} from "../sandbox-contract.js";
import type { VolumeOperations } from "../volume-contract.js";
import { resolvePodmanAttachmentContext } from "./attachment-context.js";
import { createPodmanHostOperations } from "./host.js";

function podmanStates(state: ContainerState): string[] {
  if (state === "exited") return ["exited", "stopped"];
  if (state === "dead") return ["unknown"];
  return [state];
}

function createPodmanContainerList(
  exec: RuntimeExecutor,
): (query: ContainerQuery) => Promise<string[]> {
  const list = async (
    query: ContainerQuery,
    state?: string,
  ): Promise<string[]> => {
    const args = ["ps"];
    if (query.all) args.push("-a");
    for (const [key, value] of Object.entries(query.labels ?? {})) {
      args.push("--filter", `label=${key}${value === null ? "" : `=${value}`}`);
    }
    if (state) args.push("--filter", `status=${state}`);
    args.push("--format", "{{.ID}}");
    const output = await exec("podman", args);
    return output.trim() ? output.trim().split("\n") : [];
  };
  return async (query) => {
    if (!query.states?.length) return list(query);
    const states = new Set(query.states.flatMap(podmanStates));
    const identifiers = await Promise.all(
      [...states].map((state) => list(query, state)),
    );
    return [...new Set(identifiers.flat())];
  };
}

// Leave room for other clients when the Podman VM limits SSH handshakes.
const MAX_CONCURRENT_CONTAINER_COMMANDS = 4;

function limitPodmanContainerCommands(exec: RuntimeExecutor): RuntimeExecutor {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (command, args, options) => {
    if (active < MAX_CONCURRENT_CONTAINER_COMMANDS) {
      active++;
    } else {
      const slot = Promise.withResolvers<void>();
      waiting.push(slot.resolve);
      await slot.promise;
    }
    try {
      return await exec(command, args, options);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export class PodmanService implements SandboxRuntime, SandboxImageBuilder {
  readonly runtime = "podman" as const;
  readonly instances: SandboxInstanceOperations;
  readonly storage: SandboxStorageOperations;
  private readonly containers: ContainerOperations;
  private readonly images: ImageOperations;
  private readonly volumes: VolumeOperations;
  private readonly imageBuilder: SandboxImageBuilder;
  private readonly host: ReturnType<typeof createPodmanHostOperations>;

  constructor(
    private readonly exec: RuntimeExecutor,
    context?: Awaited<ReturnType<typeof resolvePodmanAttachmentContext>>,
    lookup = false,
  ) {
    const invoke: RuntimeExecutor = context
      ? async (command, args, options) => {
          await context.verifyPin();
          return exec(command, args, {
            ...options,
            env: { ...options?.env, ...context.env },
            private: true,
            ...(lookup ? { signal: AbortSignal.timeout(5_000) } : {}),
          });
        }
      : exec;
    this.containers = createDockerContainerOperations({
      binaryName: "podman",
      runtime: "podman",
      exec: limitPodmanContainerCommands(invoke),
      listIdentifiers: createPodmanContainerList(invoke),
      ...(context
        ? {
            childEnvironment: context.env,
            verifyEndpoint: context.verifyPin,
          }
        : {}),
    });
    this.images = createDockerImageOperations("podman", invoke, {
      loadResult: false,
      environment: {},
    });
    this.volumes = createDockerVolumeOperations("podman", invoke);
    this.instances = createSandboxInstanceOperations(
      this.containers,
      resolveContentAddressedImage,
    );
    this.imageBuilder = createSandboxImageBuilder(
      this.images,
      resolveContentAddressedImage,
    );
    this.storage = createSandboxStorageOperations(this.volumes);
    this.host = createPodmanHostOperations(invoke);
  }

  async bindLocalLaunch(): Promise<SandboxAttachmentLaunch> {
    const context = await resolvePodmanAttachmentContext(this.exec);
    const service = new PodmanService(this.exec, context);
    return {
      ...context,
      selection: {
        runtime: service,
        imageBuilder: service,
        imageOwnershipKey: this.runtime,
      },
    };
  }

  async bindLocalLookup(): Promise<SandboxAttachmentLookup> {
    const context = await resolvePodmanAttachmentContext(this.exec);
    const { instances } = new PodmanService(this.exec, context, true);
    return { ...context, instances };
  }

  isAvailable: SandboxImageBuilder["isAvailable"] = (image) =>
    this.imageBuilder.isAvailable(image);

  build: SandboxImageBuilder["build"] = (request) =>
    this.imageBuilder.build(request);

  removeUnused: SandboxImageBuilder["removeUnused"] = (request) =>
    this.imageBuilder.removeUnused(request);

  ensureHostReady(): Promise<SandboxRuntimeInfo> {
    return this.host.ensureReady();
  }

  withInstanceStartup<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async getCompatibilityIdentity(): Promise<string> {
    return "podman";
  }

  getDiskSpaceAdvice(): string {
    return this.host.diskSpaceAdvice();
  }
}

export const PODMAN_RUNTIME_DEFINITION: RuntimeDefinition = {
  runtime: "podman",
  binaryName: "podman",
  isSupportedOnHost: () => true,
  create: (exec) => new PodmanService(exec),
};
