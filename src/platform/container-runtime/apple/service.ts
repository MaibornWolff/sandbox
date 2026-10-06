import * as path from "node:path";
import chalk from "chalk";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import type { ContainerOperations } from "../container-contract.js";
import type { RuntimeExecutor } from "../executor.js";
import type { ImageOperations } from "../image-contract.js";
import type { AppleContainerOptions } from "../runtime-options.js";
import {
  createSandboxImageBuilder,
  createSandboxInstanceOperations,
  createSandboxStorageOperations,
} from "../sandbox-adapter.js";
import type {
  SandboxImageBuilder,
  SandboxInstanceOperations,
  SandboxRuntime,
  SandboxRuntimeInfo,
  SandboxStorageOperations,
} from "../sandbox-contract.js";
import type { VolumeOperations } from "../volume-contract.js";
import {
  type AppleContainerOperations,
  createAppleContainerOperations,
} from "./containers.js";
import { APPLE_HOST_ACCESS_NAMES } from "./host-metadata.js";
import { createAppleImageOperations } from "./images.js";
import { AppleNetworking } from "./networking.js";
import {
  createAppleVolumeOperations,
  resolveAppleMountSource,
} from "./volumes.js";

const MINIMUM_VERSION = [1, 4, 1] as const;
const APPLE_CONTAINER_MEMORY_BYTES = 2 * 1024 ** 3;

function compareVersion(
  actual: readonly number[],
  required: readonly number[],
): number {
  for (
    let index = 0;
    index < Math.max(actual.length, required.length);
    index++
  ) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(value: string): number[] {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match)
    throw new Error(`Could not parse Apple container version: ${value}`);
  return match.slice(1).map(Number);
}

function resolveAppleImage(image: {
  readonly id: string;
  readonly reference: string;
}) {
  return { reference: image.reference, digest: image.id };
}

function createAppleInstanceOperations(
  operations: SandboxInstanceOperations,
  appleContainers: AppleContainerOperations,
): SandboxInstanceOperations {
  return {
    ...operations,
    startDetached: (spec) => appleContainers.startSandboxDetached(spec),
    runAttached: (spec, session) =>
      appleContainers.runSandboxAttached(spec, session),
  };
}

function probeValue(result: PromiseSettledResult<string>): string {
  if (result.status === "rejected") throw result.reason;
  return result.value.trim();
}

function parseServiceStatus(output: string): string {
  const parsed = JSON.parse(output) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("status" in parsed) ||
    typeof parsed.status !== "string"
  ) {
    throw new Error("Apple container returned invalid service status data.");
  }
  return parsed.status;
}

export class AppleContainerService
  implements SandboxRuntime, SandboxImageBuilder
{
  readonly runtime = "apple-container" as const;
  private readonly binaryName = "container";
  readonly instances: SandboxInstanceOperations;
  readonly storage: SandboxStorageOperations;
  private readonly containers: ContainerOperations;
  private readonly images: ImageOperations;
  private readonly volumes: VolumeOperations;
  private readonly imageBuilder: SandboxImageBuilder;
  private readonly networking: AppleNetworking;
  private hostReadiness: Promise<SandboxRuntimeInfo> | undefined;

  constructor(
    private readonly exec: RuntimeExecutor,
    private readonly options: AppleContainerOptions = { dns: "default" },
  ) {
    this.networking = new AppleNetworking(exec, options);
    const appleContainers = createAppleContainerOperations({
      exec,
      networking: this.networking,
      getVolumeRoot: () => this.volumeRoot(),
      resolveMountSource: (mount) =>
        resolveAppleMountSource(this.volumeRoot(), mount),
    });
    this.containers = appleContainers;
    this.images = createAppleImageOperations(exec, this.networking);
    this.volumes = createAppleVolumeOperations({
      getRoot: () => this.volumeRoot(),
      containers: this.containers,
    });
    this.instances = createAppleInstanceOperations(
      createSandboxInstanceOperations(this.containers, resolveAppleImage),
      appleContainers,
    );
    this.imageBuilder = createSandboxImageBuilder(
      this.images,
      resolveAppleImage,
    );
    this.storage = createSandboxStorageOperations(this.volumes);
  }

  private async getVersion(): Promise<string> {
    return (await this.exec(this.binaryName, ["--version"])).trim();
  }

  private volumeRoot(): string {
    return path.join(
      getHostEnvironment().dataHomeDirectory,
      "sandbox",
      "apple-container-volumes",
    );
  }

  build: SandboxImageBuilder["build"] = (request) =>
    this.imageBuilder.build(request);

  removeUnused: SandboxImageBuilder["removeUnused"] = (request) =>
    this.imageBuilder.removeUnused(request);

  ensureHostReady(): Promise<SandboxRuntimeInfo> {
    this.hostReadiness ??= this.checkHostReadiness();
    return this.hostReadiness;
  }

  withInstanceStartup<T>(operation: () => Promise<T>): Promise<T> {
    getLogger().debug("Preparing Apple instance startup network scope");
    return this.networking.withInstanceStartup(operation);
  }

  getCompatibilityIdentity(): Promise<string> {
    return this.networking.compatibilityIdentity();
  }

  private async validateHostAndService(): Promise<string> {
    if (getHostEnvironment().platform !== "darwin") {
      throw new Error("Apple container requires macOS 26 or newer.");
    }
    const [architectureProbe, macOsProbe, versionProbe, serviceProbe] =
      await Promise.allSettled([
        this.exec("uname", ["-m"]),
        this.exec("sw_vers", ["-productVersion"]),
        this.getVersion(),
        this.exec(this.binaryName, ["system", "status", "--format", "json"]),
      ]);
    const architecture = probeValue(architectureProbe);
    if (architecture !== "arm64") {
      throw new Error(
        `Apple container requires Apple silicon. Found ${architecture || "unknown architecture"}.`,
      );
    }
    const macOsVersion = probeValue(macOsProbe);
    const majorVersion = Number.parseInt(macOsVersion.split(".")[0] ?? "", 10);
    if (!Number.isFinite(majorVersion) || majorVersion < 26) {
      throw new Error(
        `Apple container requires macOS 26 or newer. Found ${macOsVersion || "unknown version"}.`,
      );
    }
    const versionText = probeValue(versionProbe);
    if (compareVersion(parseVersion(versionText), MINIMUM_VERSION) < 0) {
      throw new Error(
        `Apple container 1.4.1 or newer is required. Found ${versionText}. Install the current signed Apple container package.`,
      );
    }
    let status: string;
    try {
      status = parseServiceStatus(probeValue(serviceProbe));
    } catch (error) {
      throw new Error(
        `${chalk.red("Could not read the Apple container service state.")}\nStart or recover it with: ${chalk.cyan("container system start")}`,
        { cause: error },
      );
    }
    if (status !== "running") {
      throw new Error(
        `${chalk.red(`Apple container service is ${status}.`)}\nStart it with: ${chalk.cyan("container system start")}`,
      );
    }
    return versionText;
  }

  private async checkHostReadiness(): Promise<SandboxRuntimeInfo> {
    getLogger().debug(`Apple container DNS mode: ${this.options.dns}`);
    const versionText = await this.validateHostAndService();
    return {
      version: versionText,
      hostAccessName: APPLE_HOST_ACCESS_NAMES[0],
      memory: {
        bytes: APPLE_CONTAINER_MEMORY_BYTES,
        scope: "per-instance-default",
      },
    };
  }

  getDiskSpaceAdvice(): string {
    return [
      chalk.cyan.bold("container image prune"),
      "  Removes unused images from the Apple container image store.",
      "  Sandbox does not run this command automatically.",
    ].join("\n");
  }
}
