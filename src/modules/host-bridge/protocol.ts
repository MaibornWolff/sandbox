export const HOST_BRIDGE_PROTOCOL = "sandbox-host-bridge.v1";
export const HOST_BRIDGE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOST_BRIDGE_ENDPOINT_VARIABLE = "SANDBOX_HOST_BRIDGE_ENDPOINT";
export const HOST_BRIDGE_TOKEN_VARIABLE = "SANDBOX_HOST_BRIDGE_TOKEN";
export const HOST_BRIDGE_CERTIFICATE_VARIABLE =
  "SANDBOX_HOST_BRIDGE_CERTIFICATE";
export const HOST_BRIDGE_SESSION_PATH = "/session";
export const HOST_BRIDGE_MAX_CONNECTIONS = 32;

const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

export function isHostBridgeCapabilityName(name: string): boolean {
  return CAPABILITY_NAME.test(name);
}

export function hostBridgeCapabilityPath(name: string): string {
  return `${HOST_BRIDGE_SESSION_PATH}/${name}`;
}

export function* chunkHostBridgePayload(
  payload: Uint8Array,
  reservedBytes = 0,
): Iterable<Uint8Array> {
  if (
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes < 0 ||
    reservedBytes >= HOST_BRIDGE_MAX_MESSAGE_BYTES
  ) {
    throw new Error("Invalid host bridge frame reservation.");
  }
  const size = HOST_BRIDGE_MAX_MESSAGE_BYTES - reservedBytes;
  for (let offset = 0; offset < payload.byteLength; offset += size) {
    yield payload.subarray(offset, offset + size);
  }
}
