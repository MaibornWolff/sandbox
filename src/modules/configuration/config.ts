import type { CommandPattern } from "#modules/host-command-escape/index.js";
import type { ContainerRuntimeOptions } from "#platform/container-runtime/index.js";
import type { NetworkPortSelection } from "./network-port-selection.js";

export const RUNTIME_IDS = ["docker", "podman", "apple-container"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export const CLIPBOARD_MODES = ["enabled", "disabled"] as const;
type ClipboardMode = (typeof CLIPBOARD_MODES)[number];

export interface AllowedNetwork {
  host: string;
  ports: NetworkPortSelection;
  wildcard: boolean;
}

export interface PersistPathInput {
  path: string;
  default?: string;
  global?: boolean;
  only_if_exists?: boolean;
  use_named_volume?: string;
}

export interface PersistPath {
  path: string;
  default?: string;
  global: boolean;
  onlyIfExists: boolean;
  useNamedVolume?: string;
}

export type SettingsMode = "mount" | "copy";

export type SettingsEntryInput =
  | string
  | {
      path: string;
      mode?: SettingsMode;
    };

export interface SettingsEntry {
  path: string;
  mode: SettingsMode;
}

export interface Config {
  runtime: RuntimeId;
  runtimes: ContainerRuntimeOptions;
  mounts: string[];
  env: string[];
  readonly: boolean;
  clipboard: ClipboardMode;
  persistPaths: PersistPath[];
  settings: SettingsEntry[];
  ports: string[];
  allowNetwork: AllowedNetwork[];
  allowHostCommands: CommandPattern[];
  fullNetwork: boolean;
  noProxy: boolean;
  shmSize?: string;
}

export interface ConfigOverrides {
  mount?: string | string[];
  env?: string | string[];
  readonly?: boolean;
  port?: string | string[];
  allowNetwork?: string | string[];
  fullNetwork?: boolean;
  proxy?: boolean;
  trust?: boolean;
}

export interface TrustEntry {
  hash: string;
  trustedAt: string;
}

export interface TrustStore {
  version: 1;
  projects: Record<string, TrustEntry>;
}
