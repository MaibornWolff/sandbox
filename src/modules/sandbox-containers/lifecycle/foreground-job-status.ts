import { getContainerRuntimeDirectory } from "#modules/sandbox-runtime/index.js";
import {
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
  getRuntimeProvider,
  type SandboxAttachmentLookup,
  type SandboxRuntime,
} from "#platform/container-runtime/index.js";
import {
  buildSelectedSessionStatusCommand,
  parseSelectedSessionStatus,
} from "#platform/container-system/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  ForegroundJobMountOverlapError,
  getForegroundJobs,
  type VerifiedForegroundJob,
} from "#platform/foreground-job/index.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";
import type { StatusOptions } from "../sandbox-options.js";
import { toSandboxContainer } from "./container-discovery.js";
import type {
  ContainerStatusInfo,
  ForegroundAttachment,
  SandboxStatus,
} from "./status-types.js";

export function parseForegroundPgid(options: StatusOptions): number {
  if (!options.json || options.all || options.session !== undefined) {
    throw new Error(
      "Use --foreground-job with --json and without --all or --session.",
    );
  }
  const input = options.foregroundJob ?? "";
  const pgid = Number(input);
  if (
    !/^[0-9]+$/u.test(input) ||
    !Number.isInteger(pgid) ||
    pgid < 1 ||
    pgid > 2_147_483_647
  ) {
    throw new Error(
      "Use a positive decimal process group ID with --foreground-job.",
    );
  }
  return pgid;
}

function unavailable(): Error {
  return new Error(
    "Could not verify the foreground job and its local Podman attachment.",
  );
}

async function probeSession(
  runtime: SandboxAttachmentLookup,
  containerId: string,
  sessionId: string,
) {
  const result = await runtime.instances.exec(containerId, {
    command: buildSelectedSessionStatusCommand(
      getContainerRuntimeDirectory(),
      sessionId,
    ),
    user: "root",
  });
  if (result.exitCode !== 0) throw unavailable();
  return parseSelectedSessionStatus(result.stdout, sessionId);
}

function envelope(
  attachment: ForegroundAttachment,
  containers: ContainerStatusInfo[] = [],
): SandboxStatus {
  return {
    projectSlug: null,
    sessionId: attachment.sessionId,
    runtime: "podman",
    containers,
    attachment,
  };
}

function emptyResult(foregroundPgid: number, count: number) {
  return envelope({
    foregroundPgid,
    state: count === 0 ? "not-found" : "ambiguous",
    sessionId: null,
  });
}

export async function getForegroundJobStatus(
  foregroundPgid: number,
): Promise<SandboxStatus> {
  if (getHostEnvironment().platform !== "darwin") {
    throw new Error(
      "Foreground-job status is available only on macOS with local Podman.",
    );
  }
  const registry = await getForegroundJobs().catch(() => {
    throw new Error("Could not open the private host foreground-job registry.");
  });
  try {
    const find = () => registry.find({ pgid: foregroundPgid });
    const { runtime } = await getRuntimeProvider().resolve({
      configuredRuntime: "podman",
      options: DEFAULT_CONTAINER_RUNTIME_OPTIONS,
    });
    await using context = await runtime.bindLocalLookup?.();
    if (!context) throw unavailable();
    registry.assertIsolated(context.hostMounts);
    const candidates = find();
    const [job] = candidates;
    if (!job || candidates.length !== 1)
      return emptyResult(foregroundPgid, candidates.length);
    const { sessionId, binding } = job;
    if (binding === "unavailable") throw unavailable();
    const starting = envelope({ foregroundPgid, state: "starting", sessionId });
    if (binding === "starting") return starting;
    if (binding.endpoint !== context.identity) throw unavailable();

    const { containerId } = binding;
    const instance = await context.instances.inspect(containerId);
    if (
      !instance ||
      instance.id !== containerId ||
      instance.state !== "running" ||
      !instance.labels[SANDBOX_PROJECT_LABEL]
    )
      throw unavailable();
    const status = await probeSession(context, containerId, sessionId);
    await context.verify();
    registry.assertIsolated(context.hostMounts);
    const latest = find();
    if (latest.length !== 1) return emptyResult(foregroundPgid, latest.length);
    if (job.snapshot !== latest[0]?.snapshot) throw unavailable();
    const [session] = status.sessions;
    if (!session) return starting;
    return envelope({ foregroundPgid, state: "attached", sessionId }, [
      {
        ...toSandboxContainer(instance),
        ready: status.ready,
        sessions: [{ ...session, foregroundJob: reference(foregroundPgid) }],
      },
    ]);
  } catch (error) {
    if (error instanceof ForegroundJobMountOverlapError) throw error;
    throw unavailable();
  }
}

function reference(pgid: number) {
  return { type: "pgid" as const, id: pgid };
}

type StatusReader = Pick<SandboxAttachmentLookup, "instances">;

export async function readStatusWithForegroundJobs(
  runtime: SandboxRuntime,
  read: (target: StatusReader) => Promise<ContainerStatusInfo[]>,
): Promise<ContainerStatusInfo[]> {
  if (!runtime.bindLocalLookup || getHostEnvironment().platform !== "darwin")
    return read(runtime);
  try {
    const registry = await getForegroundJobs();
    await using context = await runtime.bindLocalLookup();
    registry.assertIsolated(context.hostMounts);
    const containers = await read(context);
    const sessionIds = new Set(
      containers.flatMap(({ sessions }) =>
        (sessions ?? []).flatMap(({ id }) => (id ? [id] : [])),
      ),
    );
    if (sessionIds.size === 0) return containers;
    const jobs = registry.find({ sessionIds });
    const enriched = await Promise.all(
      containers.map(async (container) => {
        if (!container.sessions) return container;
        const sessions = await Promise.all(
          container.sessions.map(async (session) => {
            const job = matchSession(
              jobs,
              session.id,
              container.id,
              context.identity,
            );
            if (!job || !session.id) return session;
            const exact = await probeSession(
              context,
              container.id,
              session.id,
            ).catch(() => undefined);
            const [current] = exact?.sessions ?? [];
            if (
              current?.pid !== session.pid ||
              current.startedAt.getTime() !== session.startedAt.getTime()
            )
              return session;
            return { ...session, foregroundJob: reference(job.pgid) };
          }),
        );
        return { ...container, sessions };
      }),
    );
    await context.verify();
    registry.assertIsolated(context.hostMounts);
    const snapshots = new Set(
      registry.find({ sessionIds }).map(({ snapshot }) => snapshot),
    );
    if (
      jobs.length !== snapshots.size ||
      jobs.some(({ snapshot }) => !snapshots.has(snapshot))
    )
      return containers;
    return enriched;
  } catch {
    return read(runtime);
  }
}

function matchSession(
  jobs: readonly VerifiedForegroundJob[],
  id: string | null,
  containerId: string,
  endpoint: string,
) {
  const matches = jobs.filter(
    ({ sessionId, binding }) =>
      sessionId === id &&
      typeof binding === "object" &&
      binding.endpoint === endpoint &&
      binding.containerId === containerId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
