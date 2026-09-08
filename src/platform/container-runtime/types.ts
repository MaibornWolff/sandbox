import type { Runtime } from "./runtime-types.js";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * Options for listing containers.
 */
export interface ListContainersOptions {
  /** Show all containers (not just running). Default: false */
  all?: boolean;
  /** Filter by label (key=value). */
  labelFilter?: string;
  /** Filter by status (e.g. "running", "exited"). Multiple values use OR logic. */
  statusFilter?: string[];
  /** Include these label values in each returned entry. */
  labelKeys?: string[];
}

/**
 * A container entry returned by listContainers.
 */
export interface ContainerEntry {
  id: string;
  name: string;
  image: string;
  labels?: Record<string, string>;
}

/**
 * Options for creating (run -d) a container.
 */
export interface CreateContainerOptions {
  name: string;
  labels?: Record<string, string>;
  /** Extra args passed verbatim between `run -d --rm` and the image. */
  extraArgs?: string[];
  image: string;
  /** Remove the container when it exits. Default: true */
  autoRemove?: boolean;
}

/**
 * Options for exec-ing into a container.
 */
export interface ContainerExecOptions {
  interactive?: boolean;
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
}

/**
 * Options for building an image.
 */
export interface ImageBuildOptions {
  tag: string;
  dockerfilePath: string;
  contextDir: string;
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  secrets?: Array<{ id: string; env: string }>;
  noCache?: boolean;
  /** Suppress interactive build output. */
  silent?: boolean;
  /** Extra raw args to pass to the build command. */
  extraArgs?: string[];
}

/**
 * A dangling image entry.
 */
export interface DanglingImageEntry {
  id: string;
  size: number;
  created: string;
}

export interface ImageInspection {
  id: string;
  labels: Record<string, string | null>;
}

/**
 * Config values that influence runtime-specific run flags.
 */
export interface RuntimeFlagsConfig {
  shmSize?: string;
}

export interface RuntimeHostInfo {
  memoryBytes: number | null;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over a container runtime CLI (Docker, Podman).
 *
 * Each method maps to one or more CLI invocations. Implementations handle
 * runtime-specific differences (flag syntax, JSON parsing, etc.).
 */
export interface ContainerRuntime {
  /** Runtime identifier (e.g. "docker"). */
  readonly runtime: Runtime;
  /** Binary name used for raw spawn() calls (e.g. "docker", "container"). */
  readonly binaryName: string;

  // -- Detection / system ---------------------------------------------------

  /** Return the runtime version string. */
  getVersion(): Promise<string>;

  /** Return total memory in bytes, or null if unavailable. */
  getMemoryBytes(): Promise<number | null>;

  // -- Container lifecycle --------------------------------------------------

  /** List containers matching the given filters. */
  listContainers(options?: ListContainersOptions): Promise<ContainerEntry[]>;

  /** Create and start a detached container. */
  createContainer(options: CreateContainerOptions): Promise<void>;

  /** Send a signal directly to a managed container's PID 1. */
  signalContainer(id: string, signal: NodeJS.Signals): Promise<void>;

  /** Stop a managed container gracefully, then remove it if it remains. */
  stopContainer(id: string): Promise<void>;

  /** Remove a container (optionally force). */
  removeContainer(id: string, force?: boolean): Promise<void>;

  /** Wait for the container entrypoint readiness marker. */
  waitUntilContainerReady(container: string, timeoutMs: number): Promise<void>;

  /** Run a command inside a running container and return stdout. */
  execInContainer(
    container: string,
    command: string[],
    options?: ContainerExecOptions,
  ): Promise<string>;

  /** Get the current state of a container (e.g. "running"). */
  getContainerState(id: string): Promise<string>;

  /** Read a single label from a container, or null if not found. */
  getContainerLabel(id: string, label: string): Promise<string | null>;

  /** Get the last N lines of container logs. */
  getContainerLogs(id: string, tail?: number): Promise<string>;

  /** Get a human-readable uptime string for a container. */
  getContainerUptime(id: string): Promise<string>;

  // -- Image operations -----------------------------------------------------

  /** List local image references (e.g. "sandbox-base:latest"). */
  listImageReferences(): Promise<string[]>;

  /** Check whether an image exists locally. */
  imageExists(name: string): Promise<boolean>;

  /** Read an image ID and selected labels with one runtime request. */
  inspectImage(
    name: string,
    labelKeys?: readonly string[],
  ): Promise<ImageInspection | null>;

  /** Read a single label from an image, or null if not found. */
  getImageLabel(name: string, label: string): Promise<string | null>;

  /** Get the full image ID (digest). */
  getImageId(name: string): Promise<string>;

  /** Build an image from a Dockerfile. */
  buildImage(options: ImageBuildOptions): Promise<void>;

  /** Pull an image from a registry. */
  pullImage(image: string, interactive?: boolean): Promise<void>;

  /** Tag a local image with a new reference. */
  tagImage(source: string, target: string): Promise<void>;

  /** Remove a local image. */
  removeImage(id: string): Promise<void>;

  /** List dangling (untagged) images matching a reference pattern. */
  listDanglingImages(referencePattern: string): Promise<DanglingImageEntry[]>;

  /** List container IDs that use a given image. */
  getContainersUsingImage(imageId: string): Promise<string[]>;

  // -- Volume operations ----------------------------------------------------

  /** Check whether a named volume exists. */
  volumeExists(name: string): Promise<boolean>;

  /** Create a named volume. */
  createVolume(name: string): Promise<void>;

  /** Copy the contents of one volume into another. */
  copyVolume(source: string, target: string): Promise<void>;

  /** Remove a named volume. */
  removeVolume(name: string): Promise<void>;

  // -- Runtime-specific flags -----------------------------------------------

  /** Extra `docker run` flags for this runtime (cap-add, sysctl, dns, etc.). */
  getRuntimeRunFlags(config?: RuntimeFlagsConfig): string[];

  /** Extra environment variables for the build command. */
  getBuildEnv(): Record<string, string>;

  /** Args for forwarding a build secret (e.g. GITHUB_TOKEN). */
  getBuildSecretArgs(secretName: string, envVar: string): string[];

  // -- Host networking ------------------------------------------------------

  /** Hostname that resolves to the host machine from inside a container. */
  getHostInternalDns(): string;

  // -- Host setup -----------------------------------------------------------

  /**
   * Verify that the runtime daemon is running and any host-level
   * prerequisites are met. Throws with actionable instructions if not.
   */
  ensureHostSetup(): Promise<RuntimeHostInfo>;

  // -- Error messages -------------------------------------------------------

  /** Human-readable hint for freeing disk space. */
  getPruneHint(): string;

  /** Human-readable hint for installing this runtime. */
  getInstallHint(): string;
}
