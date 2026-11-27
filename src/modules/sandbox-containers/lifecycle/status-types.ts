import type { ContainerSession } from "#platform/container-system/index.js";

export type ForegroundAttachment = {
  readonly foregroundPgid: number;
} & (
  | { readonly state: "attached" | "starting"; readonly sessionId: string }
  | { readonly state: "not-found" | "ambiguous"; readonly sessionId: null }
);

export interface StatusSession extends ContainerSession {
  readonly foregroundJob?: { readonly type: "pgid"; readonly id: number };
}

export interface ContainerStatusInfo {
  id: string;
  name: string;
  projectSlug: string;
  /** `null` for containers from older CLIs without the folder label. */
  projectDir: string | null;
  image: string;
  startedAt: Date | null;
  hash: string | null;
  /** `null` if the status probe failed. */
  ready: boolean | null;
  /** Sorted by start time and PID. `null` if the status probe failed. */
  sessions: readonly StatusSession[] | null;
}

export interface SandboxStatus {
  /**
   * `null` with `--all` and `--session`, because the containers can belong to
   * many projects.
   */
  projectSlug: string | null;
  /** Full ID of the looked-up session, or `null` without `--session`. */
  sessionId: string | null;
  runtime: "apple-container" | "docker" | "podman";
  containers: ContainerStatusInfo[];
  attachment?: ForegroundAttachment;
}
