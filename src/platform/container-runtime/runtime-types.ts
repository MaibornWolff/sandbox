/** All supported container runtimes. */
export const RUNTIMES = ["docker", "podman"] as const;

/** A container runtime identifier. */
export type Runtime = (typeof RUNTIMES)[number];
