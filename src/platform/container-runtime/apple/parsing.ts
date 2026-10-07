import * as path from "node:path";
import { ExecError } from "#platform/process/index.js";
import type {
  ContainerDetails,
  ContainerMount,
  ContainerState,
} from "../container-contract.js";
import { parseRuntimeJsonArray } from "../json-parsing.js";

interface AppleMountJson {
  readonly source?: string;
  readonly destination?: string;
  readonly options?: readonly string[];
}

export interface AppleContainerJson {
  readonly id?: string;
  readonly configuration?: {
    readonly id?: string;
    readonly image?: {
      readonly descriptor?: { readonly digest?: string };
      readonly reference?: string;
    };
    readonly labels?: Readonly<Record<string, string>>;
    readonly mounts?: readonly AppleMountJson[];
  };
  readonly status?: {
    readonly state?: string;
    readonly startedDate?: string;
  };
}

export function isMissingAppleResource(error: unknown): boolean {
  if (!(error instanceof ExecError)) return false;
  const detail = `${error.stderr}\n${error.stdout}\n${error.message}`;
  return /(?:\b(?:container|image|volume) not found:|\bcontainer with ID [^\r\n"]+ not found\b)/iu.test(
    detail,
  );
}

function normalizeState(
  value: string | undefined,
  startedAt: Date | null,
): ContainerState {
  switch (value) {
    case "created":
    case "running":
    case "paused":
    case "restarting":
    case "exited":
    case "dead":
      return value;
    case "stopped":
      return startedAt === null ? "created" : "exited";
    default:
      return "unknown";
  }
}

function normalizeMounts(
  mounts: readonly AppleMountJson[],
  volumeRoot: string,
): ContainerMount[] {
  if (!mounts) return [];
  const rootPrefix = `${path.resolve(volumeRoot)}${path.sep}`;
  return mounts.flatMap((mount): ContainerMount[] => {
    if (!mount.source || !mount.destination) return [];
    const readOnly = mount.options?.includes("ro") ?? false;
    const source = path.resolve(mount.source);
    if (source.startsWith(rootPrefix)) {
      return [
        {
          type: "volume",
          volumeName: source
            .slice(rootPrefix.length)
            .split(path.sep)[0] as string,
          targetPath: mount.destination,
          readOnly,
        },
      ];
    }
    return [
      {
        type: "bind",
        sourcePath: mount.source,
        targetPath: mount.destination,
        readOnly,
      },
    ];
  });
}

function parseStartedAt(value: string | undefined, id: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Apple container inspection for ${id} has an invalid start date.`,
    );
  }
  return date;
}

export function parseAppleContainerArray(
  output: string,
  resource: string,
): AppleContainerJson[] {
  const invalidDataMessage = `Apple container returned invalid ${resource} data.`;
  const values = parseRuntimeJsonArray<unknown>(
    output,
    `Apple container returned invalid ${resource} JSON.`,
    invalidDataMessage,
  );
  if (
    values.some(
      (value) =>
        typeof value !== "object" || value === null || Array.isArray(value),
    )
  ) {
    throw new Error(invalidDataMessage);
  }
  return values as AppleContainerJson[];
}

export function parseAppleContainer(
  value: AppleContainerJson,
  getVolumeRoot: () => string,
): ContainerDetails {
  const id = value.configuration?.id ?? value.id;
  const image = value.configuration?.image;
  if (!id || !image?.reference || !image.descriptor?.digest) {
    throw new Error("Apple container inspection is missing identity data.");
  }
  const startedAt = parseStartedAt(value.status?.startedDate, id);
  return {
    id,
    name: id,
    image: image.reference,
    imageIdentity: image.descriptor.digest,
    labels: value.configuration?.labels ?? {},
    state: normalizeState(value.status?.state, startedAt),
    startedAt,
    mounts: value.configuration?.mounts?.length
      ? normalizeMounts(value.configuration.mounts, getVolumeRoot())
      : [],
  };
}
