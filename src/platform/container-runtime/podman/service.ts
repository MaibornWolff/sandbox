import chalk from "chalk";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { redactCommandForDisplay } from "#shared/text/index.js";
import { buildImageBuildArgs } from "../command-args.js";
import { DockerService } from "../docker/service.js";
import type {
  ContainerEntry,
  ImageBuildOptions,
  ListContainersOptions,
  RuntimeFlagsConfig,
} from "../types.js";

/**
 * Podman implementation of ContainerRuntime.
 *
 * Extends DockerService since the CLI syntax is nearly identical.
 * Overrides only the binary name and minor flag differences.
 */
export class PodmanService extends DockerService {
  override readonly runtime = "podman" as const;
  override readonly binaryName = "podman";

  /**
   * Podman does not need DOCKER_BUILDKIT.
   */
  override getBuildEnv(): Record<string, string> {
    return {};
  }

  override async listContainers(
    options: ListContainersOptions = {},
  ): Promise<ContainerEntry[]> {
    if (!options.statusFilter || options.statusFilter.length === 0) {
      return super.listContainers(options);
    }

    const podmanStatuses = options.statusFilter.flatMap((status) => {
      if (status === "exited") return ["exited", "stopped"];
      if (status === "dead") return ["unknown"];
      return [status];
    });
    const containers = new Map<string, ContainerEntry>();
    for (const status of new Set(podmanStatuses)) {
      const matches = await super.listContainers({
        ...options,
        statusFilter: [status],
      });
      for (const container of matches) containers.set(container.id, container);
    }
    return [...containers.values()];
  }

  /**
   * Podman does not need --load (images are automatically in local store).
   * Podman also does not support the BuildKit `env=` option in `--secret`,
   * so secrets are converted to `--build-arg`.
   */
  override async buildImage(options: ImageBuildOptions): Promise<void> {
    const secretArgs: string[] = [];
    if (options.secrets) {
      for (const secret of options.secrets) {
        const value = getHostEnvironment().variables[secret.env] ?? "";
        if (value) {
          secretArgs.push("--build-arg", `${secret.id}=${value}`);
        }
      }
    }

    const args = buildImageBuildArgs({
      ...options,
      secrets: undefined,
      extraArgs: [...secretArgs, ...(options.extraArgs ?? [])],
    });

    getLogger().debug(
      `Podman build command: ${redactCommandForDisplay(this.binaryName, args)}`,
    );

    await this.exec(this.binaryName, args, {
      env: this.getBuildEnv(),
      interactive: !options.silent,
    });
  }

  /**
   * Podman does not support BuildKit `env=` in --secret.
   * Use --build-arg as fallback.
   */
  override getBuildSecretArgs(secretName: string, _envVar: string): string[] {
    return ["--build-arg", `${secretName}=$${secretName}`];
  }

  override getRuntimeRunFlags(config?: RuntimeFlagsConfig): string[] {
    const flags = [
      "--network=private",
      "--cgroups=disabled",
      "--cap-add=NET_ADMIN",
      "--sysctl=net.ipv4.tcp_tw_reuse=1",
      "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
      "--sysctl=net.ipv4.tcp_fin_timeout=10",
      "--ulimit",
      "nofile=65535:65535",
    ];
    if (config?.shmSize) {
      flags.push("--shm-size", config.shmSize);
    }
    return flags;
  }

  override getHostInternalDns(): string {
    return "host.containers.internal";
  }

  override async ensureHostSetup(): Promise<{ memoryBytes: number | null }> {
    try {
      await this.exec(this.binaryName, ["info"]);
      return { memoryBytes: null };
    } catch (error) {
      throw new Error(
        `${chalk.red("Podman is not running.")}\n` +
          `First time? Run: ${chalk.cyan("podman machine init")}\n` +
          `Start it with: ${chalk.cyan("podman machine start")}\n` +
          chalk.dim(this.getInstallHint()),
        { cause: error },
      );
    }
  }

  override getInstallHint(): string {
    return "Install Podman: https://podman.io/getting-started/installation";
  }

  override getPruneHint(): string {
    return [
      chalk.cyan.bold("podman system prune"),
      "  Removes stopped containers, unused networks, dangling images,",
      "  and all build cache. Safe for active images.",
      "",
      chalk.cyan.bold("podman system prune -a"),
      "  Also removes ALL unused images (not just dangling ones).",
      "  Frees more space but the next build will take longer.",
    ].join("\n");
  }
}
