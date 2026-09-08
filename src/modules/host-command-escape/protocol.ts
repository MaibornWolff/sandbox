export const HOST_COMMAND_ESCAPE_PROTOCOL = "sandbox-host-command-escape.v1";
export const HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE =
  "SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT";
export const HOST_COMMAND_ESCAPE_TOKEN_VARIABLE =
  "SANDBOX_HOST_COMMAND_ESCAPE_TOKEN";
export const HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE =
  "SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL";

export const STREAM_CHANNEL = {
  stdin: 1,
  stdout: 2,
  stderr: 3,
} as const;

type SupportedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

type ClientControlMessage =
  | {
      readonly type: "execute";
      readonly argv: readonly string[];
      readonly cwd: string;
    }
  | { readonly type: "stdin-end" }
  | { readonly type: "signal"; readonly signal: SupportedSignal }
  | { readonly type: "list" };

type BrokerControlMessage =
  | { readonly type: "ready" }
  | { readonly type: "allowed-commands"; readonly patterns: readonly string[] }
  | { readonly type: "exit"; readonly exitCode: number }
  | { readonly type: "error"; readonly code: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => key in value)
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Host command escape control message is not valid JSON.", {
      cause: error,
    });
  }
}

function parseSupportedSignal(value: unknown): SupportedSignal | undefined {
  return value === "SIGINT" || value === "SIGTERM" || value === "SIGHUP"
    ? value
    : undefined;
}

export function parseClientControlMessage(text: string): ClientControlMessage {
  const value = parseJson(text);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Host command escape client control message is invalid.");
  }
  if (value.type === "list" && hasOnlyKeys(value, ["type"]))
    return { type: "list" };
  if (value.type === "stdin-end" && hasOnlyKeys(value, ["type"])) {
    return { type: "stdin-end" };
  }
  if (
    value.type === "execute" &&
    hasOnlyKeys(value, ["type", "argv", "cwd"]) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.every((part) => typeof part === "string") &&
    typeof value.argv[0] === "string" &&
    value.argv[0].length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0
  ) {
    return { type: "execute", argv: value.argv, cwd: value.cwd };
  }
  const signal = parseSupportedSignal(value.signal);
  if (
    value.type === "signal" &&
    hasOnlyKeys(value, ["type", "signal"]) &&
    signal !== undefined
  ) {
    return { type: "signal", signal };
  }
  throw new Error("Host command escape client control message is invalid.");
}

export function parseBrokerControlMessage(text: string): BrokerControlMessage {
  const value = parseJson(text);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Host command escape broker control message is invalid.");
  }
  if (value.type === "ready" && hasOnlyKeys(value, ["type"]))
    return { type: "ready" };
  if (
    value.type === "allowed-commands" &&
    hasOnlyKeys(value, ["type", "patterns"]) &&
    Array.isArray(value.patterns) &&
    value.patterns.every((pattern) => typeof pattern === "string")
  ) {
    return { type: "allowed-commands", patterns: value.patterns };
  }
  if (
    value.type === "exit" &&
    hasOnlyKeys(value, ["type", "exitCode"]) &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode) &&
    value.exitCode >= 0
  ) {
    return { type: "exit", exitCode: value.exitCode };
  }
  if (
    value.type === "error" &&
    hasOnlyKeys(value, ["type", "code", "message"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return { type: "error", code: value.code, message: value.message };
  }
  throw new Error("Host command escape broker control message is invalid.");
}

export function encodeControlMessage(
  message: ClientControlMessage | BrokerControlMessage,
): string {
  return JSON.stringify(message);
}

export function encodeBinaryChannel(
  channel: 1 | 2 | 3,
  payload: Uint8Array,
): Uint8Array {
  const message = new Uint8Array(payload.byteLength + 1);
  message[0] = channel;
  message.set(payload, 1);
  return message;
}

export function decodeBinaryChannel(message: Uint8Array): {
  readonly channel: 1 | 2 | 3;
  readonly payload: Uint8Array;
} {
  const channel = message[0];
  if ((channel !== 1 && channel !== 2 && channel !== 3) || message.length < 2) {
    throw new Error("Host command escape binary channel is invalid.");
  }
  return { channel, payload: message.subarray(1) };
}
