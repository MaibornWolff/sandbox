/** A host path mounted into a container. */
export interface Mount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly mode: "ro" | "rw";
}

export type PersistentMount = Mount;
