import type {
  ImageBuildSpec,
  ImageCleanupRemoval,
  ImageCleanupRequest,
  ImageCleanupResult,
  ImageCleanupSkip,
  ImageCleanupSkipReason,
  ImageDetails,
} from "./image-contract.js";

export function buildImageArguments(
  spec: ImageBuildSpec,
  options: { readonly loadResult: boolean },
): string[] {
  const args = ["build"];
  if (options.loadResult) args.push("--load");
  if (spec.cachePolicy === "bypass") args.push("--no-cache");
  for (const [key, value] of Object.entries(spec.buildArguments)) {
    args.push("--build-arg", `${key}=${value}`);
  }
  for (const secret of spec.secrets) {
    args.push("--secret", `id=${secret.id},env=${secret.environmentVariable}`);
  }
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  args.push("-t", spec.tag, "-f", spec.dockerfilePath, spec.contextDirectory);
  return args;
}

function createImageCleanupResult(
  removed: readonly ImageCleanupRemoval[],
  skipped: readonly ImageCleanupSkip[],
): ImageCleanupResult {
  return {
    removed,
    skipped,
    estimatedReclaimedBytes: removed.reduce(
      (total, image) => total + image.estimatedReclaimedBytes,
      0,
    ),
  };
}

async function getImageCleanupSkipReason(
  image: ImageDetails | null,
  request: ImageCleanupRequest,
  isUsed: (image: ImageDetails) => Promise<boolean>,
): Promise<ImageCleanupSkipReason | null> {
  if (!image) return "missing";
  if (image.labels[request.managedLabel.key] !== request.managedLabel.value) {
    return "unmanaged";
  }
  if (image.references.length > 0) return "tagged";
  if (await isUsed(image)) return "in-use";
  return null;
}

export async function inspectBuiltImage(
  inspect: (reference: string) => Promise<ImageDetails | null>,
  tag: string,
): Promise<ImageDetails> {
  const result = await inspect(tag);
  if (!result) {
    throw new Error(`Built image ${tag} is not available after build.`);
  }
  return result;
}

export async function removeUnusedImages(options: {
  readonly request: ImageCleanupRequest;
  readonly inspect: (id: string) => Promise<ImageDetails | null>;
  readonly isUsed: (image: ImageDetails) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
}): Promise<ImageCleanupResult> {
  const removed: ImageCleanupRemoval[] = [];
  const skipped: ImageCleanupSkip[] = [];
  for (const id of new Set(options.request.candidates)) {
    const initialImage = await options.inspect(id);
    const initialReason = await getImageCleanupSkipReason(
      initialImage,
      options.request,
      options.isUsed,
    );
    if (initialReason) {
      skipped.push({ id, reason: initialReason });
      continue;
    }
    const finalImage = await options.inspect(id);
    const finalReason = await getImageCleanupSkipReason(
      finalImage,
      options.request,
      options.isUsed,
    );
    if (finalReason) {
      skipped.push({ id, reason: finalReason });
      continue;
    }
    await options.remove(id);
    removed.push({
      id,
      estimatedReclaimedBytes: initialImage?.sizeBytes ?? 0,
    });
  }
  return createImageCleanupResult(removed, skipped);
}
