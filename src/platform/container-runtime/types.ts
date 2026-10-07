export type RuntimeMemoryInfo =
  | {
      readonly bytes: number;
      readonly scope: "shared-runtime-vm" | "per-instance-default";
    }
  | { readonly bytes: null; readonly scope: "unknown" };

export interface RuntimeHostInfo {
  readonly version: string;
  readonly hostAccessName: string;
  readonly memory: RuntimeMemoryInfo;
}
