import { createHash } from "node:crypto";
import chalk from "chalk";
import { getLogger } from "#platform/logging/index.js";
import type {
  ContainerDetails,
  ContainerMount,
  ContainerOperations,
  ContainerSpec,
} from "./container-contract.js";
import type { ImageOperations } from "./image-contract.js";
import type {
  SandboxImage,
  SandboxImageBuilder,
  SandboxInstanceDetails,
  SandboxInstanceOperations,
  SandboxInstanceSpec,
  SandboxMount,
  SandboxStorage,
  SandboxStorageOperations,
  SandboxStorageSpec,
} from "./sandbox-contract.js";
import type { VolumeOperations } from "./volume-contract.js";

function toLegacyMount(mount: SandboxMount): ContainerMount {
  if (mount.type === "workspace") {
    return {
      type: "bind",
      sourcePath: mount.sourcePath,
      targetPath: mount.targetPath,
      readOnly: mount.readOnly,
    };
  }
  return {
    type: "volume",
    volumeName: mount.storage.id,
    targetPath: mount.targetPath,
    readOnly: mount.readOnly,
  };
}

function toSandboxMount(mount: ContainerMount): SandboxMount {
  if (mount.type === "bind") {
    return {
      type: "workspace",
      sourcePath: mount.sourcePath,
      targetPath: mount.targetPath,
      readOnly: mount.readOnly,
    };
  }
  return {
    type: "storage",
    storage: { id: mount.volumeName },
    targetPath: mount.targetPath,
    readOnly: mount.readOnly,
  };
}

function toLegacySpec(spec: SandboxInstanceSpec): ContainerSpec {
  return {
    ...spec,
    image: spec.image.reference,
    mounts: spec.mounts.map(toLegacyMount),
    ports: spec.ports.map((port) => ({
      ...port,
      containerPort: port.instancePort,
    })),
    security: {
      capabilities: spec.security.capabilities,
      dockerInDocker: spec.security.nestedContainerRuntime,
    },
  };
}

type ResolveSandboxImage = (details: {
  readonly id: string;
  readonly reference: string;
}) => SandboxImage;

export const resolveContentAddressedImage: ResolveSandboxImage = ({ id }) => ({
  reference: id,
  digest: id,
});

function toSandboxDetails(
  details: ContainerDetails,
  resolveImage: ResolveSandboxImage,
): SandboxInstanceDetails {
  return {
    id: details.id,
    name: details.name,
    image: resolveImage({
      id: details.imageIdentity,
      reference: details.image,
    }),
    labels: details.labels,
    state: details.state,
    startedAt: details.startedAt,
    mounts: details.mounts.map(toSandboxMount),
  };
}

export function createSandboxInstanceOperations(
  operations: ContainerOperations,
  resolveImage: ResolveSandboxImage,
): SandboxInstanceOperations {
  const inspect = async (
    id: string,
  ): Promise<SandboxInstanceDetails | null> => {
    const details = await operations.inspect(id);
    return details ? toSandboxDetails(details, resolveImage) : null;
  };
  return {
    async list(query) {
      const entries = await operations.list(query);
      return entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        image: resolveImage({
          id: entry.imageIdentity,
          reference: entry.image,
        }),
        labels: entry.labels,
        state: entry.state,
      }));
    },
    inspect,
    async startDetached(spec) {
      return { id: await operations.startDetached(toLegacySpec(spec)) };
    },
    runAttached: (spec, session) =>
      operations.runAttached(toLegacySpec(spec), session),
    signal: (id, signal) => operations.signal(id, signal),
    stopAndRemove: (id) => operations.stopAndRemove(id),
    remove: (id, options) => operations.remove(id, options),
    exec: (id, spec) => operations.exec(id, spec),
    execAttached: (id, spec, session) =>
      operations.execAttached(id, spec, session),
    readLogs: (id, query) => operations.readLogs(id, query),
    followLogs: (id, request) => operations.followLogs(id, request),
  };
}

export function createSandboxImageBuilder(
  operations: ImageOperations,
  resolveImage: ResolveSandboxImage,
): SandboxImageBuilder {
  return {
    async isAvailable(image) {
      const details = await operations.inspect(image.reference);
      return details?.id === image.digest;
    },
    async build(request): Promise<SandboxImage> {
      const existing = await operations.inspect(request.tag);
      if (request.cachePolicy === "use") {
        const labelsMatch =
          existing !== null &&
          Object.entries(request.labels).every(
            ([key, value]) => existing.labels[key] === value,
          );
        if (existing && labelsMatch) {
          return resolveImage({
            id: existing.id,
            reference: request.tag,
          });
        }
      }
      if (request.output === "interactive") {
        getLogger().info(`Building ${chalk.cyan(request.tag)}...`);
      }
      const image = await operations.build(request);
      if (request.output === "interactive") {
        getLogger().success(`Built ${chalk.cyan(request.tag)}`);
      }
      return resolveImage({ id: image.id, reference: request.tag });
    },
    async removeUnused(request) {
      const result = await operations.removeUnused(request);
      return {
        removed: result.removed.map((entry) => ({
          digest: entry.id,
          estimatedReclaimedBytes: entry.estimatedReclaimedBytes,
        })),
        skipped: result.skipped.map((entry) => ({
          digest: entry.id,
          reason: entry.reason,
        })),
        estimatedReclaimedBytes: result.estimatedReclaimedBytes,
      };
    },
  };
}

const PROJECT_STORAGE_PREFIX = "sandbox-storage-project-";

export function getSandboxStorageNativeName(spec: SandboxStorageSpec): string {
  if (spec.scope === "global") return spec.key;
  const digest = createHash("sha256").update(spec.key).digest("hex");
  return `${PROJECT_STORAGE_PREFIX}${digest}`;
}

function toSandboxStorage(nativeName: string): SandboxStorage {
  return { id: nativeName };
}

export function createSandboxStorageOperations(
  operations: VolumeOperations,
): SandboxStorageOperations {
  return {
    async ensure(spec) {
      const nativeName = getSandboxStorageNativeName(spec);
      if (!(await operations.exists(nativeName)))
        await operations.create(nativeName);
      return toSandboxStorage(nativeName);
    },
    async find(spec) {
      const nativeName = getSandboxStorageNativeName(spec);
      return (await operations.exists(nativeName))
        ? toSandboxStorage(nativeName)
        : null;
    },
    remove: (storage) => operations.remove({ name: storage.id }),
  };
}
