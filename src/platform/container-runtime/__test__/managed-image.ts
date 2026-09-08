import type { ImageBuildOptions } from "../index.js";

export interface ManagedImageValues {
  readonly id?: string;
  readonly references?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly parentId?: string;
  readonly dangling?: boolean;
  readonly size?: number;
  readonly created?: string;
  readonly inspectData?: Readonly<Record<string, unknown>>;
}

export interface ManagedImageSnapshot {
  readonly id: string;
  readonly references: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly parentId?: string;
  readonly dangling: boolean;
  readonly size: number;
  readonly created: string;
  readonly inspectData: Readonly<Record<string, unknown>>;
}

export interface ManagedImage {
  readonly id: string;
  snapshot(): ManagedImageSnapshot;
}

export interface ManagedImageState extends ManagedImage {
  readonly references: Set<string>;
  readonly labels: Readonly<Record<string, string>>;
  readonly parentId?: string;
  readonly size: number;
  readonly created: string;
  readonly inspectData: Readonly<Record<string, unknown>>;
  dangling: boolean;
}

export interface ManagedBuildResult {
  readonly id?: string;
  readonly parentId?: string;
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly error?: Error;
}

export interface ManagedBuildRecord {
  readonly options: ImageBuildOptions;
  readonly imageId?: string;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export function createManagedImage(
  values: ManagedImageValues & { readonly id: string },
): ManagedImageState {
  const references = new Set(values.references ?? []);
  const labels = Object.freeze({ ...values.labels });
  const inspectData = Object.freeze({ ...values.inspectData });

  return {
    id: values.id,
    references,
    labels,
    ...(values.parentId ? { parentId: values.parentId } : {}),
    dangling: values.dangling ?? references.size === 0,
    size: values.size ?? 0,
    created: values.created ?? "now",
    inspectData,
    snapshot() {
      return {
        id: this.id,
        references: [...this.references],
        labels: { ...this.labels },
        ...(this.parentId ? { parentId: this.parentId } : {}),
        dangling: this.dangling,
        size: this.size,
        created: this.created,
        inspectData: { ...this.inspectData },
      };
    },
  };
}
