/** All supported container runtimes. */
export const RUNTIMES = ["docker", "podman", "apple-container"] as const;

/** A container runtime identifier. */
export type Runtime = (typeof RUNTIMES)[number];

/** Whether a runtime is installed and whether its host accepts commands. */
type RuntimeProbeStatus = "running" | "not-running" | "not-installed";

/** The status of one container runtime on the current host. */
export interface RuntimeProbe {
  readonly runtime: Runtime;
  readonly status: RuntimeProbeStatus;
  /** Version reported by the runtime CLI when it is installed. */
  readonly version?: string;
  /** Plain-text start hint from the runtime host when status is "not-running". */
  readonly hint?: string;
}
