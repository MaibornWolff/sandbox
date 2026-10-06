export interface ImageDetails {
  /** Runtime-local opaque identity. Do not use this identity with another runtime. */
  readonly id: string;
  readonly references: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly sizeBytes: number;
}

export interface ImageBuildSecret {
  readonly id: string;
  readonly environmentVariable: string;
}

export type ImageBuildCachePolicy = "use" | "bypass";
export type ImageOutputPolicy = "interactive" | "silent";

export interface ImageBuildSpec {
  readonly contextDirectory: string;
  readonly dockerfilePath: string;
  readonly tag: string;
  readonly buildArguments: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly secrets: readonly ImageBuildSecret[];
  readonly cachePolicy: ImageBuildCachePolicy;
  readonly output: ImageOutputPolicy;
}

export interface ImageCleanupRequest {
  /** Runtime-local opaque image identities discovered by the same runtime. */
  readonly candidates: readonly string[];
  readonly managedLabel: {
    readonly key: string;
    readonly value: string;
  };
}

export type ImageCleanupSkipReason =
  | "missing"
  | "unmanaged"
  | "tagged"
  | "in-use";

export interface ImageCleanupRemoval {
  readonly id: string;
  readonly estimatedReclaimedBytes: number;
}

export interface ImageCleanupSkip {
  readonly id: string;
  readonly reason: ImageCleanupSkipReason;
}

export interface ImageCleanupResult {
  readonly removed: readonly ImageCleanupRemoval[];
  readonly skipped: readonly ImageCleanupSkip[];
  readonly estimatedReclaimedBytes: number;
}

export interface ImageOperations {
  inspect(reference: string): Promise<ImageDetails | null>;
  build(spec: ImageBuildSpec): Promise<ImageDetails>;
  removeUnused(request: ImageCleanupRequest): Promise<ImageCleanupResult>;
}
