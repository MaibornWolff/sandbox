import { getLogger } from "#platform/logging/index.js";
import { ExecError } from "#platform/process/index.js";
import { redactCommandForDisplay } from "#shared/text/index.js";
import type { RuntimeExecutor } from "../executor.js";
import type { ImageDetails, ImageOperations } from "../image-contract.js";
import {
  buildImageArguments,
  inspectBuiltImage,
  removeUnusedImages,
} from "../image-operations.js";
import { parseRuntimeJsonArray } from "../json-parsing.js";

interface DockerImageBuildConfig {
  readonly loadResult: boolean;
  readonly environment: Readonly<Record<string, string>>;
}

function validateLabelKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(key)) {
    throw new Error(`Invalid image label key: ${key}`);
  }
}

function isMissingImage(error: unknown): boolean {
  return (
    error instanceof ExecError &&
    /no such image|no such object|not found|does not exist/iu.test(
      `${error.stderr}\n${error.stdout}\n${error.message}`,
    )
  );
}

function parseStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Container runtime returned invalid image ${field}.`);
  }
  const entries = Object.entries(value);
  if (
    !entries.every(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
  ) {
    throw new Error(`Container runtime returned invalid image ${field}.`);
  }
  return Object.fromEntries(entries);
}

function parseReferences(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Container runtime returned invalid image references.");
  }
  return value;
}

function parseImageInspection(output: string, reference: string): ImageDetails {
  const parsed = parseRuntimeJsonArray<unknown>(
    output,
    "Container runtime returned invalid image inspection JSON.",
    `Container runtime returned invalid image inspection for ${reference}.`,
  );
  if (parsed.length !== 1) {
    throw new Error(
      `Container runtime returned invalid image inspection for ${reference}.`,
    );
  }
  const value = parsed[0];
  if (!value || typeof value !== "object") {
    throw new Error(
      `Container runtime returned invalid image inspection for ${reference}.`,
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  const config = record.Config;
  const labels =
    config && typeof config === "object" && !Array.isArray(config)
      ? parseStringRecord(
          (config as Readonly<Record<string, unknown>>).Labels,
          "labels",
        )
      : {};
  if (typeof record.Id !== "string" || typeof record.Size !== "number") {
    throw new Error(
      `Container runtime image inspection is missing identity or size for ${reference}.`,
    );
  }
  return {
    id: record.Id,
    references: parseReferences(record.RepoTags),
    labels,
    sizeBytes: record.Size,
  };
}

export function createDockerImageOperations(
  binaryName: "docker" | "podman",
  exec: RuntimeExecutor,
  buildConfig: DockerImageBuildConfig,
): ImageOperations {
  const inspect = async (reference: string): Promise<ImageDetails | null> => {
    try {
      const output = await exec(binaryName, ["image", "inspect", reference]);
      return parseImageInspection(output, reference);
    } catch (error) {
      if (isMissingImage(error)) return null;
      throw error;
    }
  };

  const containersUsing = async (id: string): Promise<string[]> => {
    const output = await exec(binaryName, [
      "ps",
      "-a",
      "--filter",
      `ancestor=${id}`,
      "--format",
      "{{.ID}}",
    ]);
    return output.trim().split("\n").filter(Boolean);
  };

  return {
    inspect,
    async build(spec) {
      const args = buildImageArguments(spec, {
        loadResult: buildConfig.loadResult,
      });
      getLogger().debug(
        `${binaryName} build command: ${redactCommandForDisplay(binaryName, args)}`,
      );
      await exec(binaryName, args, {
        env: buildConfig.environment,
        interactive: spec.output === "interactive",
      });
      return inspectBuiltImage(inspect, spec.tag);
    },
    removeUnused(request) {
      validateLabelKey(request.managedLabel.key);
      return removeUnusedImages({
        request,
        inspect,
        isUsed: async (image) => (await containersUsing(image.id)).length > 0,
        remove: async (id) => {
          await exec(binaryName, ["rmi", id]);
        },
      });
    },
  };
}
