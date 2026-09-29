import chalk from "chalk";
import { CONTAINER_READY_FILE } from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";
import { ExecError } from "#platform/process/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import {
  parseSizeToBytes,
  redactCommandForDisplay,
} from "#shared/text/index.js";
import {
  buildCopyVolumeArgs,
  buildCreateContainerArgs,
  buildImageBuildArgs,
} from "../command-args.js";
import type { RuntimeExecutor } from "../executor.js";
import type { Runtime } from "../runtime-types.js";
import type {
  ContainerEntry,
  ContainerExecOptions,
  ContainerRuntime,
  CreateContainerOptions,
  DanglingImageEntry,
  ImageBuildOptions,
  ImageInspection,
  ListContainersOptions,
  RuntimeFlagsConfig,
} from "../types.js";

function validateLabelKeys(
  labelKeys: readonly string[],
  resource: "container" | "image",
): void {
  for (const key of labelKeys) {
    if (!/^[A-Za-z0-9._-]+$/u.test(key)) {
      throw new Error(`Invalid ${resource} label key: ${key}`);
    }
  }
}

/**
 * Docker implementation of ContainerRuntime.
 *
 * Uses the `docker` CLI with Go-template `--format` strings and `--filter`
 * flags for efficient server-side filtering.
 */
export class DockerService implements ContainerRuntime {
  readonly runtime: Runtime = "docker";
  readonly binaryName: string = "docker";
  protected readonly exec: RuntimeExecutor;

  constructor(exec: RuntimeExecutor) {
    this.exec = exec;
  }

  /** Log a failed query and return its documented fallback value. */
  protected fallback<T>(operation: string, error: unknown, value: T): T {
    getLogger().debug(
      `${this.binaryName} ${operation} failed, using fallback: ${getErrorMessage(error)}`,
    );
    return value;
  }

  // -- Detection / system ---------------------------------------------------

  async getVersion(): Promise<string> {
    const output = await this.exec(this.binaryName, ["--version"]);
    return output.trim();
  }

  async getMemoryBytes(): Promise<number | null> {
    try {
      const output = await this.exec(this.binaryName, [
        "info",
        "--format",
        "{{.MemTotal}}",
      ]);
      const memBytes = Number.parseInt(output.trim(), 10);
      return Number.isNaN(memBytes) ? null : memBytes;
    } catch (error) {
      return this.fallback("getMemoryBytes", error, null);
    }
  }

  // -- Container lifecycle --------------------------------------------------

  async listContainers(
    options: ListContainersOptions = {},
  ): Promise<ContainerEntry[]> {
    const args = ["ps"];
    if (options.all) {
      args.push("-a");
    }
    if (options.labelFilter) {
      args.push("--filter", `label=${options.labelFilter}`);
    }
    if (options.statusFilter) {
      for (const status of options.statusFilter) {
        args.push("--filter", `status=${status}`);
      }
    }
    const labelKeys = options.labelKeys ?? [];
    validateLabelKeys(labelKeys, "container");
    const labelFields = labelKeys.map((key) => `{{.Label "${key}"}}`);
    args.push(
      "--format",
      ["{{.ID}}", "{{.Names}}", "{{.Image}}", ...labelFields].join("|"),
    );

    try {
      const output = await this.exec(this.binaryName, args);
      return this.parseContainerList(output, labelKeys);
    } catch (error) {
      return this.fallback("listContainers", error, []);
    }
  }

  protected parseContainerList(
    output: string,
    labelKeys: readonly string[] = [],
  ): ContainerEntry[] {
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        if (parts.length < 3) return null;
        const labels = Object.fromEntries(
          labelKeys.map((key, index) => [key, parts[index + 3] ?? ""]),
        );
        return {
          id: parts[0] ?? "",
          name: parts[1] ?? "",
          image: (parts[2] ?? "").replace(/^localhost\//, ""),
          ...(labelKeys.length > 0 ? { labels } : {}),
        };
      })
      .filter((c): c is ContainerEntry => c !== null);
  }

  async createContainer(options: CreateContainerOptions): Promise<void> {
    await this.exec(this.binaryName, buildCreateContainerArgs(options));
  }

  async signalContainer(id: string, signal: NodeJS.Signals): Promise<void> {
    await this.exec(this.binaryName, ["kill", "--signal", signal, id]);
  }

  async stopContainer(id: string): Promise<void> {
    await this.exec(this.binaryName, ["stop", id]);
    try {
      await this.exec(this.binaryName, ["rm", id]);
    } catch (error) {
      if (
        error instanceof ExecError &&
        /no such container|no container with name or id/iu.test(error.stderr)
      ) {
        return;
      }
      throw error;
    }
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const args = ["rm"];
    if (force) args.push("-f");
    args.push(id);
    await this.exec(this.binaryName, args);
  }

  async waitUntilContainerReady(
    container: string,
    timeoutMs: number,
  ): Promise<void> {
    const intervalMs = 50;
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    const command =
      `i=0; while [ "$i" -lt ${attempts} ]; do ` +
      `[ -f ${CONTAINER_READY_FILE} ] && exit 0; ` +
      `i=$((i + 1)); sleep ${intervalMs / 1_000}; done; exit 124`;
    await this.exec(this.binaryName, ["exec", container, "sh", "-c", command]);
  }

  async execInContainer(
    container: string,
    command: string[],
    options: ContainerExecOptions = {},
  ): Promise<string> {
    const args = ["exec"];
    if (options.interactive) args.push("-it");
    if (options.user) args.push("-u", options.user);
    if (options.workdir) args.push("-w", options.workdir);
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }
    args.push(container, ...command);
    return this.exec(this.binaryName, args);
  }

  async getContainerState(id: string): Promise<string> {
    const output = await this.exec(this.binaryName, [
      "inspect",
      "--format",
      "{{.State.Status}}",
      id,
    ]);
    return output.trim();
  }

  async getContainerLabel(id: string, label: string): Promise<string | null> {
    try {
      const output = await this.exec(this.binaryName, [
        "inspect",
        "--format",
        `{{index .Config.Labels "${label}"}}`,
        id,
      ]);
      const trimmed = output.trim();
      return trimmed === "<no value>" || trimmed === "" ? null : trimmed;
    } catch (error) {
      return this.fallback("getContainerLabel", error, null);
    }
  }

  async getContainerLogs(id: string, tail = 50): Promise<string> {
    return this.exec(this.binaryName, ["logs", "--tail", String(tail), id]);
  }

  async getContainerUptime(id: string): Promise<string> {
    try {
      const output = await this.exec(this.binaryName, [
        "ps",
        "--filter",
        `id=${id}`,
        "--format",
        "{{.RunningFor}}",
      ]);
      return output.trim() || "unknown";
    } catch (error) {
      return this.fallback("getContainerUptime", error, "unknown");
    }
  }

  // -- Image operations -----------------------------------------------------

  async listImageReferences(): Promise<string[]> {
    try {
      const output = await this.exec(this.binaryName, [
        "images",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      return output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0 && line !== "<none>:<none>");
    } catch (error) {
      return this.fallback("listImageReferences", error, []);
    }
  }

  async imageExists(name: string): Promise<boolean> {
    try {
      const output = await this.exec(this.binaryName, ["images", "-q", name]);
      return output.trim().length > 0;
    } catch (error) {
      return this.fallback("imageExists", error, false);
    }
  }

  async inspectImage(
    name: string,
    labelKeys: readonly string[] = [],
  ): Promise<ImageInspection | null> {
    validateLabelKeys(labelKeys, "image");
    const format = [
      "{{.Id}}",
      ...labelKeys.map((key) => `{{index .Config.Labels "${key}"}}`),
    ].join("|");
    try {
      const output = await this.exec(this.binaryName, [
        "image",
        "inspect",
        "--format",
        format,
        name,
      ]);
      const [id, ...values] = output.trim().split("|");
      if (!id) return null;
      return {
        id,
        labels: Object.fromEntries(
          labelKeys.map((key, index) => {
            const value = values[index];
            return [key, !value || value === "<no value>" ? null : value];
          }),
        ),
      };
    } catch (error) {
      return this.fallback("inspectImage", error, null);
    }
  }

  async getImageLabel(name: string, label: string): Promise<string | null> {
    try {
      const output = await this.exec(this.binaryName, [
        "inspect",
        "--format",
        `{{index .Config.Labels "${label}"}}`,
        name,
      ]);
      const trimmed = output.trim();
      return trimmed === "<no value>" || trimmed === "" ? null : trimmed;
    } catch (error) {
      return this.fallback("getImageLabel", error, null);
    }
  }

  async getImageId(name: string): Promise<string> {
    const output = await this.exec(this.binaryName, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      name,
    ]);
    return output.trim();
  }

  async buildImage(options: ImageBuildOptions): Promise<void> {
    const args = buildImageBuildArgs(options, {
      includeLoad: true,
      includeSecrets: true,
    });

    getLogger().debug(
      `Docker build command: ${redactCommandForDisplay(this.binaryName, args)}`,
    );

    await this.exec(this.binaryName, args, {
      env: this.getBuildEnv(),
      interactive: !options.silent,
    });
  }

  async pullImage(image: string, interactive = false): Promise<void> {
    await this.exec(this.binaryName, ["pull", image], { interactive });
  }

  async tagImage(source: string, target: string): Promise<void> {
    await this.exec(this.binaryName, ["tag", source, target]);
  }

  async removeImage(id: string): Promise<void> {
    await this.exec(this.binaryName, ["rmi", id]);
  }

  async listDanglingImages(
    referencePattern: string,
  ): Promise<DanglingImageEntry[]> {
    try {
      const output = await this.exec(this.binaryName, [
        "images",
        "--filter",
        "dangling=true",
        "--filter",
        `reference=${referencePattern}`,
        "--format",
        "{{.ID}}|{{.Size}}|{{.CreatedAt}}",
      ]);

      if (!output.trim()) return [];

      return output
        .trim()
        .split("\n")
        .map((line) => {
          const parts = line.split("|");
          if (parts.length !== 3) return null;
          const [id, sizeStr, created] = parts;
          if (!id || !sizeStr || !created) return null;
          return {
            id: id.trim(),
            size: parseSizeToBytes(sizeStr.trim()),
            created: created.trim(),
          };
        })
        .filter((img): img is DanglingImageEntry => img !== null);
    } catch (error) {
      return this.fallback("listDanglingImages", error, []);
    }
  }

  async getContainersUsingImage(imageId: string): Promise<string[]> {
    try {
      const output = await this.exec(this.binaryName, [
        "ps",
        "-a",
        "--filter",
        `ancestor=${imageId}`,
        "--format",
        "{{.ID}}",
      ]);
      if (!output.trim()) return [];
      return output.trim().split("\n");
    } catch (error) {
      return this.fallback("getContainersUsingImage", error, []);
    }
  }

  // -- Volume operations ----------------------------------------------------

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.exec(this.binaryName, ["volume", "inspect", name]);
      return true;
    } catch (error) {
      return this.fallback("volumeExists", error, false);
    }
  }

  async createVolume(name: string): Promise<void> {
    await this.exec(this.binaryName, ["volume", "create", name]);
  }

  async copyVolume(source: string, target: string): Promise<void> {
    await this.exec(this.binaryName, buildCopyVolumeArgs(source, target));
  }

  async removeVolume(name: string): Promise<void> {
    await this.exec(this.binaryName, ["volume", "rm", name]);
  }

  // -- Runtime-specific flags -----------------------------------------------

  getRuntimeRunFlags(config?: RuntimeFlagsConfig): string[] {
    const flags = [
      "--cap-add=NET_ADMIN",
      "--add-host=host.docker.internal:host-gateway",
      "--sysctl=net.ipv4.tcp_tw_reuse=1",
      "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
      "--sysctl=net.ipv4.tcp_fin_timeout=10",
      "--ulimit",
      "nofile=65536:65536",
    ];
    if (config?.shmSize) {
      flags.push("--shm-size", config.shmSize);
    }
    return flags;
  }

  getBuildEnv(): Record<string, string> {
    return { DOCKER_BUILDKIT: "1" };
  }

  getBuildSecretArgs(secretName: string, envVar: string): string[] {
    return ["--secret", `id=${secretName},env=${envVar}`];
  }

  // -- Host networking ------------------------------------------------------

  getHostInternalDns(): string {
    return "host.docker.internal";
  }

  // -- Host setup -----------------------------------------------------------

  async ensureHostSetup(): Promise<{ memoryBytes: number | null }> {
    try {
      const output = await this.exec(this.binaryName, [
        "info",
        "--format",
        "{{.MemTotal}}",
      ]);
      const memoryBytes = Number.parseInt(output.trim(), 10);
      return { memoryBytes: Number.isNaN(memoryBytes) ? null : memoryBytes };
    } catch (error) {
      throw new Error(
        `${chalk.red(`${this.binaryName} daemon is not running.`)}\n` +
          `Start it with ${chalk.cyan("Rancher Desktop")}, ${chalk.cyan("Colima")}, or your preferred method.\n` +
          chalk.dim(this.getInstallHint()),
        { cause: error },
      );
    }
  }

  // -- Error messages -------------------------------------------------------

  getPruneHint(): string {
    return [
      chalk.cyan.bold(`${this.binaryName} system prune`),
      "  Removes stopped containers, unused networks, dangling images,",
      "  and all build cache. Safe for active images.",
      "",
      chalk.cyan.bold(`${this.binaryName} system prune -a`),
      "  Also removes ALL unused images (not just dangling ones).",
      "  Frees more space but the next build will take longer.",
    ].join("\n");
  }

  getInstallHint(): string {
    return "Install Docker: https://docs.docker.com/get-docker/";
  }
}
