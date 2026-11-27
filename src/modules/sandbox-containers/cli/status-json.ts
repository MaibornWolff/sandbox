import type {
  ContainerStatusInfo,
  SandboxStatus,
  StatusSession,
} from "../lifecycle/status-types.js";

// ---------------------------------------------------------------------------
// Contract of `sandbox status --json`
// ---------------------------------------------------------------------------

/**
 * A new field keeps the version. A rename, a removal, or a change of type or
 * meaning increments it.
 */
const STATUS_SCHEMA_VERSION = 1;

interface StatusDocumentSession {
  readonly id: string | null;
  readonly pid: number;
  readonly startedAt: string;
  readonly command: readonly string[] | null;
  readonly foregroundJob?: StatusSession["foregroundJob"];
}

interface StatusDocumentContainer {
  readonly containerId: string;
  readonly name: string;
  readonly project: { readonly slug: string; readonly dir: string | null };
  readonly image: string;
  readonly startedAt: string | null;
  readonly ready: boolean | null;
  readonly hash: string | null;
  readonly sessions: readonly StatusDocumentSession[] | null;
}

interface StatusDocument {
  readonly schemaVersion: typeof STATUS_SCHEMA_VERSION;
  readonly runtime: SandboxStatus["runtime"];
  readonly containers: readonly StatusDocumentContainer[];
  readonly attachment?: SandboxStatus["attachment"];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSession(session: StatusSession): StatusDocumentSession {
  return {
    id: session.id,
    pid: session.pid,
    startedAt: session.startedAt.toISOString(),
    command: session.command,
    ...(session.foregroundJob ? { foregroundJob: session.foregroundJob } : {}),
  };
}

function toContainer(container: ContainerStatusInfo): StatusDocumentContainer {
  return {
    containerId: container.id,
    name: container.name,
    project: { slug: container.projectSlug, dir: container.projectDir },
    image: container.image,
    startedAt: container.startedAt?.toISOString() ?? null,
    ready: container.ready,
    hash: container.hash,
    sessions: container.sessions?.map(toSession) ?? null,
  };
}

/** Map the internal status to the versioned document of `--json`. */
export function toStatusDocument(status: SandboxStatus): StatusDocument {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    runtime: status.runtime,
    containers: status.containers.map(toContainer),
    ...(status.attachment ? { attachment: status.attachment } : {}),
  };
}
