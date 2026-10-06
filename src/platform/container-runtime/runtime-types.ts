/** All supported container runtimes. */
export const RUNTIMES = ["docker", "podman", "apple-container"] as const;

/** A container runtime identifier. */
export type Runtime = (typeof RUNTIMES)[number];
