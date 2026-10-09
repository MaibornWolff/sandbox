import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import { z } from "zod";
import { requireCommandSuccess, runReleaseCommand } from "./release-command.js";
import {
  type ReleasePlan,
  readReleaseMetadata,
  readReleasePlan,
  readReleaseTarballIntegrity,
  releaseDirectory,
  releaseMetadataDigest,
  releaseTarballPath,
  verifyReleaseTarball,
  writeReleasePlan,
} from "./release-plan.js";

const REQUIRED_PACKAGE_FILES = [
  "bin/sandbox.js",
  "dist/apps/sandbox/main.js",
  "CHANGELOG.md",
  "SBOM.cdx.json",
  "THIRD_PARTY_NOTICES.md",
] as const;

const packSchema = z
  .array(
    z.object({
      filename: z.string(),
      integrity: z.string(),
      files: z.array(z.object({ path: z.string() })),
    }),
  )
  .length(1);

const sbomSchema = z.object({
  metadata: z.object({
    component: z.object({ name: z.string(), version: z.string() }),
  }),
});

export function parseNpmPackReport(output: string) {
  // Lifecycle tools can write to stdout before npm emits its JSON report.
  const start = output.search(/\[\s*\{\s*"id"\s*:/);
  if (start < 0)
    throw new Error("npm pack did not return a JSON package report");
  const lifecycleOutput = output.slice(0, start).trim();
  if (lifecycleOutput) console.error(lifecycleOutput);
  return packSchema.parse(JSON.parse(output.slice(start)));
}

function npm(args: readonly string[], repoRoot: string): string {
  return requireCommandSuccess("npm", runReleaseCommand("npm", args, repoRoot));
}

async function createReleaseTarball(repoRoot: string): Promise<string> {
  const directory = releaseDirectory(repoRoot);
  const [packed] = parseNpmPackReport(
    npm(["pack", "--json", "--pack-destination", directory], repoRoot),
  );
  if (!packed || path.basename(packed.filename) !== packed.filename) {
    throw new Error("npm pack returned an invalid filename");
  }

  const files = new Set(packed.files.map((file) => file.path));
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!files.has(required))
      throw new Error(`Release tarball is missing ${required}`);
  }

  await rename(
    path.join(directory, packed.filename),
    releaseTarballPath(repoRoot),
  );
  const integrity = await readReleaseTarballIntegrity(repoRoot);
  if (integrity !== packed.integrity) {
    throw new Error("npm pack integrity does not match the tarball");
  }
  return integrity;
}

function installReleaseTarball(repoRoot: string, installRoot: string): string {
  npm(
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      releaseTarballPath(repoRoot),
    ],
    repoRoot,
  );
  return path.join(installRoot, "node_modules", "@maibornwolff", "sandbox");
}

async function verifyInstalledMetadata(
  installedDirectory: string,
  plan: ReleasePlan,
): Promise<void> {
  const metadata = await readReleaseMetadata(installedDirectory);
  if (releaseMetadataDigest(metadata) !== plan.metadataDigest) {
    throw new Error(
      "Installed package version or changelog differs from release metadata",
    );
  }
}

async function verifyInstalledCompliance(
  installedDirectory: string,
  plan: ReleasePlan,
): Promise<void> {
  const sbomText = await readFile(
    path.join(installedDirectory, "SBOM.cdx.json"),
    "utf8",
  );
  const { name, version } = sbomSchema.parse(JSON.parse(sbomText)).metadata
    .component;
  if (name !== plan.packageName || version !== plan.version) {
    throw new Error("Installed SBOM does not match the release version");
  }

  const notices = await readFile(
    path.join(installedDirectory, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  if (!notices.includes(`Version: ${plan.version}`)) {
    throw new Error("Installed third-party notices have the wrong version");
  }
}

function smokeTestInstalledCli(options: {
  readonly installedDirectory: string;
  readonly installRoot: string;
  readonly expectedVersion: string;
}): void {
  const launcher = path.join(options.installedDirectory, "bin", "sandbox.js");
  function runCli(flag: string): string {
    const result = runReleaseCommand(
      "node",
      [launcher, flag],
      options.installRoot,
    );
    return requireCommandSuccess(`sandbox ${flag}`, result);
  }

  const version = runCli("--version");
  if (version !== options.expectedVersion) {
    throw new Error(
      `Installed CLI reports ${version}, expected ${options.expectedVersion}`,
    );
  }
  runCli("--help");
}

async function verifyInstalledPackage(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<void> {
  const installRoot = await mkdtemp(path.join(tmpdir(), "sandbox-release-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(installRoot, { recursive: true, force: true }));

  const installedDirectory = installReleaseTarball(repoRoot, installRoot);
  await verifyInstalledMetadata(installedDirectory, plan);
  await verifyInstalledCompliance(installedDirectory, plan);
  smokeTestInstalledCli({
    installedDirectory,
    installRoot,
    expectedVersion: plan.version,
  });
}

export async function packRelease(repoRoot: string): Promise<void> {
  const plan = await readReleasePlan(repoRoot);
  const metadata = await readReleaseMetadata(repoRoot);
  if (releaseMetadataDigest(metadata) !== plan.metadataDigest) {
    throw new Error("Working tree metadata changed after release preparation");
  }

  console.error(
    `Building ${chalk.cyan(`${plan.packageName}@${plan.version}`)}`,
  );
  npm(["run", "build"], repoRoot);
  const integrity = await createReleaseTarball(repoRoot);
  await writeReleasePlan(repoRoot, { ...plan, integrity });
  console.error(
    `Packed ${chalk.cyan(`${plan.packageName}@${plan.version}`)} for approval and validation`,
  );
}

export async function validateReleasePackage(repoRoot: string): Promise<void> {
  const plan = await readReleasePlan(repoRoot);
  await verifyReleaseTarball(repoRoot, plan);
  await verifyInstalledPackage(repoRoot, plan);
  npm(
    [
      "publish",
      releaseTarballPath(repoRoot),
      "--dry-run",
      "--access=public",
      "--tag=latest",
    ],
    repoRoot,
  );
  await verifyReleaseTarball(repoRoot, plan);
  console.error(
    `Validated ${chalk.cyan(`${plan.packageName}@${plan.version}`)} without publishing`,
  );
}
