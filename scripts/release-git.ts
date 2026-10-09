import { gitCommand } from "./release-command.js";
import {
  type ReleaseMetadata,
  type ReleasePlan,
  readReleaseMetadata,
  releaseDirectory,
  releaseMetadataDigest,
  releaseMetadataFiles,
  writeReleaseMetadata,
} from "./release-plan.js";

function releaseTagRef(plan: ReleasePlan): string {
  return `refs/tags/v${plan.version}`;
}

function remoteCommit(repoRoot: string, ref: string): string | null {
  const result = gitCommand(["ls-remote", "origin", ref], repoRoot);
  return result.split(/\s/)[0] || null;
}

export function assertCleanReleaseCheckout(repoRoot: string): void {
  const changes = gitCommand(
    ["status", "--porcelain", "--untracked-files=no"],
    repoRoot,
  );
  if (changes) throw new Error("Release requires a clean tracked working tree");
}

export function assertReleaseSourceCheckout(
  repoRoot: string,
  plan: ReleasePlan,
): void {
  const currentCommit = gitCommand(["rev-parse", "HEAD"], repoRoot);
  if (currentCommit !== plan.sourceCommit) {
    throw new Error(
      "Checkout does not match the prepared release source commit",
    );
  }
}

export function assertReleaseSourceUnchanged(
  repoRoot: string,
  plan: ReleasePlan,
): void {
  if (remoteCommit(repoRoot, "refs/heads/main") !== plan.sourceCommit) {
    throw new Error(
      "main changed after release preparation. Do not overwrite it. See docs/RELEASING.md for recovery",
    );
  }
}

export function assertReleaseTagAvailable(
  repoRoot: string,
  plan: ReleasePlan,
): void {
  if (remoteCommit(repoRoot, releaseTagRef(plan))) {
    throw new Error(`Release tag v${plan.version} already exists`);
  }
}

export async function restoreReleaseCheckout(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<void> {
  assertReleaseSourceCheckout(repoRoot, plan);
  const metadata = await readReleaseMetadata(releaseDirectory(repoRoot));
  await writeReleaseMetadata(repoRoot, metadata);
}

function readCommitMetadata(repoRoot: string, commit: string): ReleaseMetadata {
  return {
    packageJson: `${gitCommand(["show", `${commit}:package.json`], repoRoot)}\n`,
    changelog: `${gitCommand(["show", `${commit}:CHANGELOG.md`], repoRoot)}\n`,
  };
}

function assertMatchingReleaseCommit(
  repoRoot: string,
  plan: ReleasePlan,
  commit: string,
): void {
  const parent = gitCommand(["rev-parse", `${commit}^`], repoRoot);
  const metadata = readCommitMetadata(repoRoot, commit);
  const changedFiles = gitCommand(
    ["diff", "--name-only", plan.sourceCommit, commit],
    repoRoot,
  )
    .split("\n")
    .sort();

  const hasExpectedParent = parent === plan.sourceCommit;
  const hasExpectedMetadata =
    releaseMetadataDigest(metadata) === plan.metadataDigest;
  const onlyMetadataChanged =
    changedFiles.join(",") === [...releaseMetadataFiles].sort().join(",");
  if (!hasExpectedParent || !hasExpectedMetadata || !onlyMetadataChanged) {
    throw new Error(
      `Existing tag v${plan.version} does not match this release`,
    );
  }
}

function findCompletedReleaseCommit(
  repoRoot: string,
  plan: ReleasePlan,
): string | null {
  const tag = releaseTagRef(plan);
  if (!remoteCommit(repoRoot, tag)) return null;

  gitCommand(["fetch", "origin", `${tag}:${tag}`], repoRoot);
  const commit = gitCommand(["rev-parse", `${tag}^{commit}`], repoRoot);
  assertMatchingReleaseCommit(repoRoot, plan, commit);
  gitCommand(["fetch", "origin", "main"], repoRoot);
  gitCommand(["merge-base", "--is-ancestor", commit, "FETCH_HEAD"], repoRoot);
  return commit;
}

function commitAndPushRelease(repoRoot: string, plan: ReleasePlan): string {
  gitCommand(["add", "--", ...releaseMetadataFiles], repoRoot);
  gitCommand(["commit", "-m", `chore: release ${plan.version}`], repoRoot);
  const commit = gitCommand(["rev-parse", "HEAD"], repoRoot);
  const tag = releaseTagRef(plan);
  gitCommand(["tag", `v${plan.version}`, commit], repoRoot);
  // Atomic push prevents a release tag from existing without its main commit.
  gitCommand(
    ["push", "--atomic", "origin", "HEAD:refs/heads/main", tag],
    repoRoot,
  );
  return commit;
}

export async function commitPublishedRelease(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<string> {
  const existingCommit = findCompletedReleaseCommit(repoRoot, plan);
  if (existingCommit) return existingCommit;

  assertReleaseSourceUnchanged(repoRoot, plan);
  await restoreReleaseCheckout(repoRoot, plan);
  return commitAndPushRelease(repoRoot, plan);
}
