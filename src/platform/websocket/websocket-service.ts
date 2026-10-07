import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

/** @lintignore Public WebSocket endpoint contract. */
export interface WebSocketEndpoint {
  readonly host: string;
  readonly port: number;
}

/** @lintignore Public generic WebSocket upgrade metadata. */
export interface WebSocketUpgradeMetadata {
  readonly path: string;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}

/** @lintignore Public WebSocket upgrade decision. */
export type WebSocketUpgradeDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly statusCode?: number;
      readonly reason?: string;
    };

/** @lintignore Public WebSocket incoming message. */
export type WebSocketMessage =
  | { readonly type: "text"; readonly data: string }
  | { readonly type: "binary"; readonly data: Uint8Array };

/** @lintignore Public WebSocket close details. */
export interface WebSocketCloseDetails {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** @lintignore Public WebSocket send options. */
export interface WebSocketSendOptions {
  readonly signal?: AbortSignal;
}

/** @lintignore Public WebSocket connection resource. */
export interface WebSocketConnection extends AsyncDisposable {
  readonly protocol: string;
  readonly path?: string;
  readonly messages: AsyncIterable<WebSocketMessage>;
  readonly closed: Promise<WebSocketCloseDetails>;
  sendText(message: string, options?: WebSocketSendOptions): Promise<void>;
  sendBinary(
    message: Uint8Array,
    options?: WebSocketSendOptions,
  ): Promise<void>;
  close(code?: number, reason?: string): Promise<WebSocketCloseDetails>;
}

/** @lintignore Public WebSocket server resource. */
export interface WebSocketServer extends AsyncDisposable {
  readonly endpoint: WebSocketEndpoint;
  readonly certificate: string;
  readonly connections: AsyncIterable<WebSocketConnection>;
}

/** @lintignore Public WebSocket server options. */
export interface StartWebSocketServerOptions {
  readonly host: string;
  readonly port: number;
  readonly maxConnections?: number;
  readonly protocol: string;
  readonly maxMessageBytes: number;
  readonly authorizeUpgrade: (
    metadata: WebSocketUpgradeMetadata,
  ) => WebSocketUpgradeDecision | Promise<WebSocketUpgradeDecision>;
}

/** @lintignore Public WebSocket client options. */
export interface ConnectWebSocketOptions {
  readonly url: string;
  readonly pinnedCertificate: string;
  readonly protocol: string;
  readonly maxMessageBytes: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** @lintignore Public WebSocket platform service. */
export interface WebSocketService {
  startServer(options: StartWebSocketServerOptions): Promise<WebSocketServer>;
  connect(options: ConnectWebSocketOptions): Promise<WebSocketConnection>;
}

const webSocketServiceDependency =
  createDependency<WebSocketService>("WebSocket service");

export function provideWebSocketService(
  service: WebSocketService,
): DependencyBinding {
  return webSocketServiceDependency.provide(service);
}

export function getWebSocketService(): WebSocketService {
  return webSocketServiceDependency.get();
}
