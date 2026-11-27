import {
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
  getRuntimeProvider,
  type SandboxAttachmentLaunch,
  type SandboxMount,
  type SandboxRuntime,
  type TerminalSessionOptions,
} from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  type ForegroundJobPublication,
  type ForegroundJobTarget,
  getForegroundJobs,
} from "#platform/foreground-job/index.js";
import { getLogger } from "#platform/logging/index.js";

export async function prepareForegroundLaunch(
  terminalSession: boolean,
): Promise<SandboxAttachmentLaunch | undefined> {
  if (!terminalSession || getHostEnvironment().platform !== "darwin") return;
  try {
    const { runtime } = await getRuntimeProvider().resolve({
      configuredRuntime: "podman",
      options: DEFAULT_CONTAINER_RUNTIME_OPTIONS,
    });
    return await runtime.bindLocalLaunch?.();
  } catch {
    getLogger().debug("Could not verify a local Podman attachment context.");
  }
}

export function verifyPublicationMounts(
  publication: ForegroundJobPublication | undefined,
  mounts: readonly SandboxMount[],
): boolean {
  return (
    publication?.avoidMounts(
      mounts.flatMap((mount) =>
        mount.type === "workspace" ? [mount.sourcePath] : [],
      ),
    ) ?? false
  );
}

export async function publishForegroundJob(
  sessionId: string,
  hostMounts: readonly string[],
): Promise<ForegroundJobPublication | undefined> {
  try {
    const registry = await getForegroundJobs();
    registry.assertIsolated(hostMounts);
    const publication = registry.register(sessionId);
    if (!publication) return;
    function safely<T>(operation: () => T): T | undefined {
      try {
        return operation();
      } catch {
        getLogger().debug("Could not update the host foreground-job record.");
      }
    }
    return {
      avoidMounts: (sources) =>
        safely(() => publication.avoidMounts(sources)) ?? false,
      markUnavailable: () => {
        safely(publication.markUnavailable);
      },
      attach: (target, pid) => {
        safely(() => publication.attach(target, pid));
      },
      [Symbol.dispose]: () => {
        safely(() => publication[Symbol.dispose]());
      },
    };
  } catch {
    getLogger().debug(
      "Could not publish a private host foreground-job record.",
    );
  }
}

export function observeForegroundAttachment(
  publication: ForegroundJobPublication | undefined,
  target: ForegroundJobTarget | undefined,
): Pick<TerminalSessionOptions, "attachmentStarted" | "attachmentExited"> {
  if (!publication || !target) return {};
  return {
    attachmentStarted: (pid) => publication.attach(target, pid),
    attachmentExited: () => publication[Symbol.dispose](),
  };
}

export async function verifyForegroundTarget(
  publication: ForegroundJobPublication | undefined,
  context: SandboxAttachmentLaunch | undefined,
  runtime: SandboxRuntime,
  containerId: string,
): Promise<ForegroundJobTarget | undefined> {
  if (!publication || !context) return;
  try {
    await context.verify();
    const instance = await runtime.instances.inspect(containerId);
    if (
      !instance ||
      instance.id !== containerId ||
      !/^[a-f0-9]{64}$/u.test(containerId)
    ) {
      publication.markUnavailable();
      return;
    }
    if (verifyPublicationMounts(publication, instance.mounts))
      return { endpoint: context.identity, containerId };
  } catch {
    publication.markUnavailable();
  }
}
