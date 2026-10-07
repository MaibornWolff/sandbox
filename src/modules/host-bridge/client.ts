import {
  getWebSocketService,
  type WebSocketConnection,
} from "#platform/websocket/index.js";
import {
  HOST_BRIDGE_CERTIFICATE_VARIABLE,
  HOST_BRIDGE_ENDPOINT_VARIABLE,
  HOST_BRIDGE_MAX_MESSAGE_BYTES,
  HOST_BRIDGE_PROTOCOL,
  HOST_BRIDGE_SESSION_PATH,
  HOST_BRIDGE_TOKEN_VARIABLE,
  hostBridgeCapabilityPath,
  isHostBridgeCapabilityName,
} from "./protocol.js";

export async function openHostBridgeConnection(options: {
  readonly capability: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<WebSocketConnection> {
  const endpoint = options.environment[HOST_BRIDGE_ENDPOINT_VARIABLE];
  const token = options.environment[HOST_BRIDGE_TOKEN_VARIABLE];
  const certificate = options.environment[HOST_BRIDGE_CERTIFICATE_VARIABLE];
  if (!endpoint || !token || !certificate) {
    throw new Error("No active host bridge session.");
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== HOST_BRIDGE_SESSION_PATH ||
    !isHostBridgeCapabilityName(options.capability)
  ) {
    throw new Error("Invalid encrypted host bridge endpoint or capability.");
  }
  url.pathname = hostBridgeCapabilityPath(options.capability);
  return getWebSocketService().connect({
    url: url.href,
    protocol: HOST_BRIDGE_PROTOCOL,
    maxMessageBytes: HOST_BRIDGE_MAX_MESSAGE_BYTES,
    pinnedCertificate: certificate,
    headers: { authorization: `Bearer ${token}` },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
