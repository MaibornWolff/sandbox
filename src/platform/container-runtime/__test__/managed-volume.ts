export interface ManagedVolumeValues {
  readonly name: string;
  readonly files?: Readonly<Record<string, string>>;
}

export interface ManagedVolumeSnapshot {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ManagedVolume {
  readonly name: string;
  snapshot(): ManagedVolumeSnapshot;
}

export interface ManagedVolumeState extends ManagedVolume {
  files: Record<string, string>;
}

export function createManagedVolume(
  values: ManagedVolumeValues,
): ManagedVolumeState {
  return {
    name: values.name,
    files: { ...values.files },
    snapshot() {
      return { name: this.name, files: { ...this.files } };
    },
  };
}
