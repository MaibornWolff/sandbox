import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { z } from "zod";
import { getRepoRootPath } from "#platform/git/index.js";
import {
  gitCommand,
  type ReleaseCommand,
  ReleaseCommandError,
  runReleaseCommand,
} from "./release-command.js";
import {
  assertCleanReleaseCheckout,
  assertReleaseSourceCheckout,
  assertReleaseSourceUnchanged,
  assertReleaseTagAvailable,
  commitPublishedRelease,
  restoreReleaseCheckout,
} from "./release-git.js";
import { releaseIncrementFromHistory } from "./release-history.js";
import { packRelease, validateReleasePackage } from "./release-package.js";
import {
  type ReleasePlan,
  readReleaseMetadata,
  readReleasePlan,
  releaseDirectory,
  releaseMetadataDigest,
  verifyReleaseTarball,
  writeReleaseMetadata,
  writeReleasePlan,
} from "./release-plan.js";
import { createReleaseRegistry } from "./release-registry.js";
import { nextReleaseVersion, prepareChangelog } from "./release-state.js";

const USAGE =
  "Usage: bun release prepare | pack | validate | restore | publish | finalize";
const packageSchema = z.looseObject({
  name: z.literal("@maibornwolff/sandbox"),
  version: z.string(),
});

interface PrepareReleaseOptions {
  readonly repoRoot: string;
  readonly date: string;
}

interface ReleaseOptions {
  readonly repoRoot: string;
  readonly npm?: ReleaseCommand;
}

export async function prepareRelease(
  options: PrepareReleaseOptions,
): Promise<ReleasePlan> {
  const { repoRoot, date } = options;
  assertCleanReleaseCheckout(repoRoot);
  const currentMetadata = await readReleaseMetadata(repoRoot);
  const manifest = packageSchema.parse(JSON.parse(currentMetadata.packageJson));
  const bump = releaseIncrementFromHistory(repoRoot, manifest.version);
  const version = nextReleaseVersion(manifest.version, bump);

  const preparedChangelog = prepareChangelog({
    changelog: currentMetadata.changelog,
    version,
    date,
  });
  const metadata = {
    packageJson: `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    changelog: preparedChangelog.changelog,
  };
  const plan: ReleasePlan = {
    packageName: manifest.name,
    previousVersion: manifest.version,
    version,
    sourceCommit: gitCommand(["rev-parse", "HEAD"], repoRoot),
    date,
    metadataDigest: releaseMetadataDigest(metadata),
  };

  const directory = releaseDirectory(repoRoot);
  await writeReleaseMetadata(directory, metadata);
  await writeReleaseMetadata(repoRoot, metadata);
  await writeFile(path.join(directory, "notes.md"), preparedChangelog.notes);
  await writeReleasePlan(repoRoot, plan);
  console.error(
    `Prepared ${chalk.cyan(`${plan.packageName}@${version}`)} in ${chalk.dim(directory)}`,
  );
  return plan;
}

export async function restoreReleaseMetadata(repoRoot: string): Promise<void> {
  const plan = await readReleasePlan(repoRoot);
  await restoreReleaseCheckout(repoRoot, plan);
}

export async function publishRelease(options: ReleaseOptions): Promise<void> {
  const { repoRoot } = options;
  const plan = await readReleasePlan(repoRoot);
  const tarball = await verifyReleaseTarball(repoRoot, plan);

  assertCleanReleaseCheckout(repoRoot);
  assertReleaseSourceUnchanged(repoRoot, plan);
  assertReleaseSourceCheckout(repoRoot, plan);
  assertReleaseTagAvailable(repoRoot, plan);

  const registry = createReleaseRegistry({
    repoRoot,
    execute: options.npm ?? runReleaseCommand,
  });
  registry.publish(plan, tarball);
}

export async function finalizeRelease(
  options: ReleaseOptions,
): Promise<string> {
  const { repoRoot } = options;
  const plan = await readReleasePlan(repoRoot);
  await verifyReleaseTarball(repoRoot, plan);
  assertCleanReleaseCheckout(repoRoot);

  const registry = createReleaseRegistry({
    repoRoot,
    execute: options.npm ?? runReleaseCommand,
  });
  registry.assertPublished(plan);
  return commitPublishedRelease(repoRoot, plan);
}

async function prepareFromArguments(
  repoRoot: string,
  args: readonly string[],
): Promise<void> {
  if (args.length > 0) throw new Error(USAGE);
  const plan = await prepareRelease({
    repoRoot,
    date: new Date().toISOString().slice(0, 10),
  });
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    await writeFile(
      outputFile,
      `version=${plan.version}\nsource_commit=${plan.sourceCommit}\n`,
      { flag: "a" },
    );
  }
}

async function main(): Promise<void> {
  const repoRoot = await getRepoRootPath(process.cwd());
  const [phase, ...args] = process.argv.slice(2);
  switch (phase) {
    case "prepare":
      return prepareFromArguments(repoRoot, args);
    case "pack":
      return packRelease(repoRoot);
    case "validate":
      return validateReleasePackage(repoRoot);
    case "restore":
      return restoreReleaseMetadata(repoRoot);
    case "publish":
      return publishRelease({ repoRoot });
    case "finalize":
      await finalizeRelease({ repoRoot });
      return;
    default:
      throw new Error(USAGE);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode =
      error instanceof ReleaseCommandError ? error.exitCode : 1;
  });
}
