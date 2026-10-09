import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const releaseMetadataFiles = ["package.json", "CHANGELOG.md"] as const;
const planSchema = z.object({
  packageName: z.literal("@maibornwolff/sandbox"),
  previousVersion: z.string().regex(/^0\.\d+\.\d+$/),
  version: z.string().regex(/^0\.\d+\.\d+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metadataDigest: z.string(),
  integrity: z.string().optional(),
});
export type ReleasePlan = z.infer<typeof planSchema>;

export interface ReleaseMetadata {
  readonly packageJson: string;
  readonly changelog: string;
}

export function releaseDirectory(repoRoot: string): string {
  return path.join(repoRoot, ".release");
}

export function releaseTarballPath(repoRoot: string): string {
  return path.join(releaseDirectory(repoRoot), "package.tgz");
}

export async function readReleaseMetadata(
  directory: string,
): Promise<ReleaseMetadata> {
  const [packageJson, changelog] = await Promise.all([
    readFile(path.join(directory, "package.json"), "utf8"),
    readFile(path.join(directory, "CHANGELOG.md"), "utf8"),
  ]);
  return { packageJson, changelog };
}

export async function writeReleaseMetadata(
  directory: string,
  metadata: ReleaseMetadata,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), metadata.packageJson);
  await writeFile(path.join(directory, "CHANGELOG.md"), metadata.changelog);
}

export function releaseMetadataDigest(metadata: ReleaseMetadata): string {
  return createHash("sha256")
    .update(JSON.stringify([metadata.packageJson, metadata.changelog]))
    .digest("hex");
}

export async function readReleasePlan(repoRoot: string): Promise<ReleasePlan> {
  const directory = releaseDirectory(repoRoot);
  const plan = planSchema.parse(
    JSON.parse(await readFile(path.join(directory, "plan.json"), "utf8")),
  );
  const metadata = await readReleaseMetadata(directory);
  if (releaseMetadataDigest(metadata) !== plan.metadataDigest) {
    throw new Error("Release metadata differs from the prepared snapshot");
  }
  return plan;
}

export async function writeReleasePlan(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<void> {
  await writeFile(
    path.join(releaseDirectory(repoRoot), "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
}

export async function readReleaseTarballIntegrity(
  repoRoot: string,
): Promise<string> {
  const tarball = await readFile(releaseTarballPath(repoRoot));
  const digest = createHash("sha512").update(tarball).digest("base64");
  return `sha512-${digest}`;
}

export async function verifyReleaseTarball(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<string> {
  const integrity = await readReleaseTarballIntegrity(repoRoot);
  if (!plan.integrity || integrity !== plan.integrity) {
    throw new Error("Release tarball does not match its recorded integrity");
  }
  return releaseTarballPath(repoRoot);
}
