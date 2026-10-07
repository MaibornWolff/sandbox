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
import {
  createSandboxImageBuilder,
  createSandboxInstanceOperations,
  createSandboxStorageOperations,
  resolveContentAddressedImage,
} from "../sandbox-adapter.js";
import type {
  SandboxImageBuilder,
  SandboxInstanceOperations,
  SandboxRuntime,
  SandboxRuntimeInfo,
  SandboxStorageOperations,
} from "../sandbox-contract.js";
import type { VolumeOperations } from "../volume-contract.js";
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

export class PodmanService implements SandboxRuntime, SandboxImageBuilder {
  readonly runtime = "podman" as const;
  readonly instances: SandboxInstanceOperations;
  readonly storage: SandboxStorageOperations;
  private readonly containers: ContainerOperations;
  private readonly images: ImageOperations;
  private readonly volumes: VolumeOperations;
  private readonly imageBuilder: SandboxImageBuilder;
  private readonly host: ReturnType<typeof createPodmanHostOperations>;

  constructor(exec: RuntimeExecutor) {
    this.containers = createDockerContainerOperations({
      binaryName: "podman",
      runtime: "podman",
      exec,
      listIdentifiers: createPodmanContainerList(exec),
    });
    this.images = createDockerImageOperations("podman", exec, {
      loadResult: false,
      environment: {},
    });
    this.volumes = createDockerVolumeOperations("podman", exec);
    this.instances = createSandboxInstanceOperations(
      this.containers,
      resolveContentAddressedImage,
    );
    this.imageBuilder = createSandboxImageBuilder(
      this.images,
      resolveContentAddressedImage,
    );
    this.storage = createSandboxStorageOperations(this.volumes);
    this.host = createPodmanHostOperations(exec);
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
