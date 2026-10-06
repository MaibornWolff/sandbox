import type { ContainerOperations } from "../container-contract.js";
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
import { createDockerContainerOperations } from "./containers.js";
import { createDockerHostOperations } from "./host.js";
import { createDockerImageOperations } from "./images.js";
import { createDockerVolumeOperations } from "./volumes.js";

export class DockerService implements SandboxRuntime, SandboxImageBuilder {
  readonly runtime = "docker" as const;
  readonly instances: SandboxInstanceOperations;
  readonly storage: SandboxStorageOperations;
  private readonly containers: ContainerOperations;
  private readonly images: ImageOperations;
  private readonly volumes: VolumeOperations;
  private readonly imageBuilder: SandboxImageBuilder;
  private readonly host: ReturnType<typeof createDockerHostOperations>;

  constructor(exec: RuntimeExecutor) {
    this.containers = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec,
    });
    this.images = createDockerImageOperations("docker", exec, {
      loadResult: true,
      environment: { DOCKER_BUILDKIT: "1" },
    });
    this.volumes = createDockerVolumeOperations("docker", exec);
    this.instances = createSandboxInstanceOperations(
      this.containers,
      resolveContentAddressedImage,
    );
    this.imageBuilder = createSandboxImageBuilder(
      this.images,
      resolveContentAddressedImage,
    );
    this.storage = createSandboxStorageOperations(this.volumes);
    this.host = createDockerHostOperations(exec);
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
    return "docker";
  }

  getDiskSpaceAdvice(): string {
    return this.host.diskSpaceAdvice();
  }
}
