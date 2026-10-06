import * as crypto from "node:crypto";
import * as path from "node:path";
import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import {
  createTemporaryDirectoryIn,
  ensureDirectory,
  getPathType,
  listDirectory,
  removeDirectory,
  removeOwnedDirectory,
  removePath,
  renamePath,
  tryCreateDirectory,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import type {
  ContainerMount,
  ContainerOperations,
  ContainerSpec,
} from "../container-contract.js";
import type { RuntimeExecutor } from "../executor.js";
import type { VolumeOperations } from "../volume-contract.js";

function validateVolumeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) {
    throw new Error(`Invalid Apple container volume name: ${name}`);
  }
}

function getAppleVolumePath(root: string, name: string): string {
  validateVolumeName(name);
  return path.join(root, name);
}

function volumeMarkerPath(
  root: string,
  name: string,
  phase: "pending" | "initialized",
): string {
  validateVolumeName(name);
  return path.join(root, `.${name}.${phase}`);
}

async function acquireVolumeInitializationLock(
  root: string,
): Promise<AsyncDisposable> {
  const lockPath = path.join(root, ".volume-initialization.lock");
  const clock = getClock();
  const deadline = clock.now() + 120_000;
  while (!tryCreateDirectory(lockPath)) {
    if (clock.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Apple storage initialization at ${lockPath}. Remove this lock directory only when no Sandbox instances are starting.`,
      );
    }
    await clock.sleep(100);
  }
  return {
    async [Symbol.asyncDispose]() {
      removeDirectory(lockPath);
    },
  };
}

interface VolumeSeed {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly staging: string;
  readonly guestStaging: string;
}

type VolumeMount = Extract<ContainerMount, { type: "volume" }>;

function volumeIsInitialized(root: string, name: string): boolean {
  const marker = volumeMarkerPath(root, name, "initialized");
  const type = getPathType(marker);
  if (type !== null && type !== "file") {
    throw new Error(
      `Apple storage initialization marker is not a file: ${chalk.dim(marker)}`,
    );
  }
  return type === "file";
}

function uninitializedVolumeMounts(
  root: string,
  mounts: readonly ContainerMount[],
): VolumeMount[] {
  const pending: VolumeMount[] = [];
  for (const mount of mounts) {
    if (mount.type === "volume" && !volumeIsInitialized(root, mount.volumeName))
      pending.push(mount);
  }
  return pending;
}

function prepareVolumeSeeds(options: {
  readonly root: string;
  readonly mounts: readonly VolumeMount[];
  readonly image: string;
  readonly cleanup: DisposableStack;
}): VolumeSeed[] {
  const seeds: VolumeSeed[] = [];
  const existing = new Set<string>();
  for (const mount of options.mounts) {
    if (
      existing.has(mount.volumeName) ||
      volumeIsInitialized(options.root, mount.volumeName)
    )
      continue;
    existing.add(mount.volumeName);
    const source = getAppleVolumePath(options.root, mount.volumeName);
    const pendingMarker = volumeMarkerPath(
      options.root,
      mount.volumeName,
      "pending",
    );
    const existingStorage = getPathType(source) !== null;
    if (!existingStorage) writeTextFile(pendingMarker, "");
    ensureDirectory(source);
    const newlyAllocated = getPathType(pendingMarker) === "file";
    if (!newlyAllocated || listDirectory(source).length > 0) {
      getLogger().debug(
        `Preserving existing Apple storage ${chalk.cyan(mount.volumeName)}`,
      );
      writeTextFile(
        volumeMarkerPath(options.root, mount.volumeName, "initialized"),
        options.image,
      );
      removePath(pendingMarker);
      continue;
    }
    const staging = createTemporaryDirectoryIn(options.root, ".volume-seed-");
    options.cleanup.defer(() => removeOwnedDirectory(staging));
    seeds.push({
      name: mount.volumeName,
      source,
      target: mount.targetPath,
      staging,
      guestStaging: `/run/sandbox-volume-seed/${seeds.length}`,
    });
  }
  return seeds;
}

function volumeSeedArguments(
  image: string,
  seeds: readonly VolumeSeed[],
): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    `sandbox-volume-seed-${crypto.randomUUID()}`,
    "--no-dns",
    "--user",
    "root",
    "--entrypoint",
    "/bin/sh",
  ];
  for (const seed of seeds)
    args.push("-v", `${seed.staging}:${seed.guestStaging}:rw`);
  // VirtioFS mount-root metadata is fixed, but child metadata can be copied.
  args.push(
    image,
    "-c",
    'set -eu; while [ "$#" -gt 0 ]; do if [ -d "$1" ]; then for item in "$1"/* "$1"/.[!.]* "$1"/..?*; do if [ -e "$item" ] || [ -L "$item" ]; then cp -a -- "$item" "$2/"; fi; done; fi; shift 2; done',
    "sandbox-volume-seed",
  );
  for (const seed of seeds) args.push(seed.target, seed.guestStaging);
  return args;
}

export async function initializeAppleVolumeMounts(options: {
  readonly volumeRoot: string;
  readonly spec: ContainerSpec;
  readonly exec: RuntimeExecutor;
}): Promise<void> {
  const { volumeRoot, spec, exec } = options;
  const pending = uninitializedVolumeMounts(volumeRoot, spec.mounts);
  if (pending.length === 0) return;
  ensureDirectory(volumeRoot);
  await using _lock = await acquireVolumeInitializationLock(volumeRoot);
  using cleanup = new DisposableStack();
  const seeds = prepareVolumeSeeds({
    root: volumeRoot,
    mounts: pending,
    image: spec.image,
    cleanup,
  });
  if (seeds.length === 0) return;
  getLogger().debug(
    `Initializing Apple storage from image ${chalk.cyan(spec.image)}`,
  );
  await exec("container", volumeSeedArguments(spec.image, seeds));
  for (const seed of seeds) {
    removeDirectory(seed.source);
    renamePath(seed.staging, seed.source);
    writeTextFile(
      volumeMarkerPath(volumeRoot, seed.name, "initialized"),
      spec.image,
    );
    removePath(volumeMarkerPath(volumeRoot, seed.name, "pending"));
    getLogger().debug(`Initialized Apple storage ${chalk.cyan(seed.name)}`);
  }
}

export function resolveAppleMountSource(
  root: string,
  mount: ContainerMount,
): string {
  if (mount.type === "bind") return mount.sourcePath;
  const source = getAppleVolumePath(root, mount.volumeName);
  ensureDirectory(source);
  return source;
}

async function findVolumeReference(
  containers: ContainerOperations,
  name: string,
): Promise<string | null> {
  for (const summary of await containers.list({ all: true })) {
    const details = await containers.inspect(summary.id);
    if (
      details?.mounts.some(
        (mount) => mount.type === "volume" && mount.volumeName === name,
      )
    ) {
      return details.id;
    }
  }
  return null;
}

export function createAppleVolumeOperations(options: {
  readonly getRoot: () => string;
  readonly containers: ContainerOperations;
}): VolumeOperations {
  const { getRoot, containers } = options;
  const exists = async (name: string): Promise<boolean> =>
    getPathType(getAppleVolumePath(getRoot(), name)) === "directory";

  return {
    exists,
    async create(name) {
      const volumePath = getAppleVolumePath(getRoot(), name);
      getLogger().debug(
        `Creating Apple logical volume at ${chalk.dim(volumePath)}`,
      );
      ensureDirectory(getRoot());
      if (getPathType(volumePath) === null)
        writeTextFile(volumeMarkerPath(getRoot(), name, "pending"), "");
      ensureDirectory(volumePath);
    },
    async remove(request) {
      const volumePath = getAppleVolumePath(getRoot(), request.name);
      if (!(await exists(request.name))) {
        throw new Error(`Volume not found: ${request.name}`);
      }
      const containerId = await findVolumeReference(containers, request.name);
      if (containerId) {
        throw new Error(
          `Volume ${request.name} is referenced by container ${containerId}.`,
        );
      }
      getLogger().debug(
        `Removing Apple logical volume at ${chalk.dim(volumePath)}`,
      );
      removeOwnedDirectory(volumePath);
      removePath(volumeMarkerPath(getRoot(), request.name, "initialized"));
      removePath(volumeMarkerPath(getRoot(), request.name, "pending"));
    },
  };
}
