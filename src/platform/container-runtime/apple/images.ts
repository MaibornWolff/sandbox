import { getLogger } from "#platform/logging/index.js";
import { redactCommandForDisplay } from "#shared/text/index.js";
import type { RuntimeExecutor } from "../executor.js";
import type { ImageDetails, ImageOperations } from "../image-contract.js";
import {
  buildImageArguments,
  inspectBuiltImage,
  inspectImage,
  removeUnusedImages,
} from "../image-operations.js";
import { matchesImageReference } from "../image-reference.js";
import { parseRuntimeJsonArray } from "../json-parsing.js";
import type { AppleNetworkOperations } from "./networking.js";
import {
  type AppleContainerJson,
  parseAppleContainerArray,
} from "./parsing.js";

const BINARY_NAME = "container";

interface AppleImageVariantJson {
  readonly platform?: {
    readonly architecture?: string;
    readonly os?: string;
  };
  readonly config?: {
    readonly config?: { readonly Labels?: unknown };
  };
  readonly size?: number;
}

interface AppleImageJson {
  readonly configuration?: {
    readonly name?: string;
    readonly descriptor?: { readonly digest?: string };
  };
  readonly variants?: readonly AppleImageVariantJson[];
}

function parseLabels(
  value: unknown,
  reference: string,
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Apple image inspection has invalid labels: ${reference}`);
  }
  const entries = Object.entries(value);
  if (
    !entries.every(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
  ) {
    throw new Error(`Apple image inspection has invalid labels: ${reference}`);
  }
  return Object.fromEntries(entries);
}

function parseImageArray(output: string, resource: string): AppleImageJson[] {
  const values = parseRuntimeJsonArray<unknown>(
    output,
    `Apple container returned invalid ${resource} JSON.`,
    `Apple container returned invalid ${resource} data.`,
  );
  if (
    values.some(
      (value) =>
        typeof value !== "object" || value === null || Array.isArray(value),
    )
  ) {
    throw new Error(`Apple container returned invalid ${resource} data.`);
  }
  return values as AppleImageJson[];
}

function selectArm64Variant(
  image: AppleImageJson,
  reference: string,
): AppleImageVariantJson {
  const variant = image.variants?.find(
    (entry) =>
      entry.platform?.os === "linux" && entry.platform.architecture === "arm64",
  );
  if (!variant) {
    throw new Error(
      `Apple image inspection has no Linux ARM64 variant: ${reference}`,
    );
  }
  return variant;
}

function parseAppleImage(
  image: AppleImageJson,
  reference: string,
): ImageDetails {
  const id = image.configuration?.descriptor?.digest;
  if (!id) {
    throw new Error(`Apple image inspection has no identity: ${reference}`);
  }
  const variant = selectArm64Variant(image, reference);
  const name = image.configuration?.name;
  return {
    id,
    references: name ? [name] : [],
    labels: parseLabels(variant.config?.config?.Labels, reference),
    sizeBytes: variant.size ?? 0,
  };
}

function parseSingleImage(output: string, reference: string): ImageDetails {
  const images = parseImageArray(output, "image inspection");
  if (images.length !== 1 || !images[0]) {
    throw new Error(
      `Apple container returned invalid image inspection for ${reference}.`,
    );
  }
  return parseAppleImage(images[0], reference);
}

function listedImageIdentity(image: AppleImageJson): {
  readonly id: string;
  readonly references: readonly string[];
} {
  const id = image.configuration?.descriptor?.digest;
  const name = image.configuration?.name;
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
    throw new Error("Apple image list is missing identity or reference data.");
  }
  const repository = name.replace(/@.*$/u, "").replace(/:[^/]+$/u, "");
  return { id, references: [name, `${repository}@${id}`] };
}

function containerUsesImage(
  container: AppleContainerJson,
  image: ImageDetails,
): boolean {
  const configuredImage = container.configuration?.image;
  return (
    configuredImage?.descriptor?.digest === image.id ||
    (configuredImage?.reference !== undefined &&
      image.references.includes(configuredImage.reference))
  );
}

export function createAppleImageOperations(
  exec: RuntimeExecutor,
  networking: AppleNetworkOperations,
): ImageOperations {
  const exists = async (reference: string): Promise<boolean> => {
    const images = parseImageArray(
      await exec(BINARY_NAME, ["image", "list", "--format", "json"]),
      "image list",
    );
    const identities = images.map(listedImageIdentity);
    return identities.some((image) => matchesImageReference(reference, image));
  };
  const inspect = (reference: string): Promise<ImageDetails | null> =>
    inspectImage({
      read: () => exec(BINARY_NAME, ["image", "inspect", reference]),
      exists: () => exists(reference),
      parse: (output) => parseSingleImage(output, reference),
    });

  const containersUsing = async (image: ImageDetails): Promise<string[]> => {
    const containers = parseAppleContainerArray(
      await exec(BINARY_NAME, ["list", "-a", "--format", "json"]),
      "container list",
    );
    return containers
      .filter((container) => containerUsesImage(container, image))
      .map((container) => container.configuration?.id ?? container.id ?? "")
      .filter(Boolean);
  };

  return {
    inspect,
    async build(spec) {
      await networking.prepareBuild();
      const args = buildImageArguments(spec, { loadResult: false });
      getLogger().debug(
        `Apple container build command: ${redactCommandForDisplay(BINARY_NAME, args)}`,
      );
      await exec(BINARY_NAME, args, {
        interactive: spec.output === "interactive",
      });
      return inspectBuiltImage(inspect, spec.tag);
    },
    removeUnused: (request) =>
      removeUnusedImages({
        request,
        inspect,
        isUsed: async (image) => (await containersUsing(image)).length > 0,
        remove: async (id) => {
          await exec(BINARY_NAME, ["image", "delete", id]);
        },
      }),
  };
}
