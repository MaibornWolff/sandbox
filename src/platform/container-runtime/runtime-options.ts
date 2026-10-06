export const APPLE_CONTAINER_DNS_MODES = [
  "default",
  "host",
  "host-ipv6",
] as const;

export type AppleContainerDnsMode = (typeof APPLE_CONTAINER_DNS_MODES)[number];

export interface AppleContainerOptions {
  readonly dns: AppleContainerDnsMode;
}

export interface ContainerRuntimeOptions {
  "apple-container": AppleContainerOptions;
}

export const DEFAULT_CONTAINER_RUNTIME_OPTIONS: ContainerRuntimeOptions = {
  "apple-container": { dns: "default" },
};
