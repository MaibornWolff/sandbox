const BRIDGE_ERRNO = [
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
] as const;

function bridgeErrnoCode(errno: string): string {
  return `bridge-${errno.toLowerCase().replaceAll("_", "-")}`;
}

const STARTUP_CODES = new Set([
  ...BRIDGE_ERRNO.map(bridgeErrnoCode),
  "bridge-unavailable",
  "bridge-missing-session",
  "bridge-missing-service",
  "bridge-authentication-failed",
  "bridge-capability-unavailable",
  "bridge-protocol-failed",
  "display-unavailable",
  "display-authentication-failed",
  "display-exited",
  "display-connection-failed",
  "display-connection-closed",
  "display-xfixes-unavailable",
  "display-selection-failed",
  "display-timeout",
  "display-executable-unavailable",
]);

function bridgeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "bridge-unavailable";
  const errno = BRIDGE_ERRNO.find(
    (name) => "code" in error && error.code === name,
  );
  if (errno) return bridgeErrnoCode(errno);
  if (error.message === "No active host bridge session.")
    return "bridge-missing-session";
  if (error.message.includes("Missing dependency"))
    return "bridge-missing-service";
  if (error.message.includes("Unexpected server response: 401"))
    return "bridge-authentication-failed";
  if (error.message.includes("Unexpected server response: 404"))
    return "bridge-capability-unavailable";
  if (error.message === "Clipboard transfer is invalid or incomplete.")
    return "bridge-protocol-failed";
  return "bridge-unavailable";
}

function isStartupCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (STARTUP_CODES.has(value) || /^display-request-[0-9]{1,3}$/u.test(value))
  );
}

export class ClipboardProxyStartupError extends Error {
  constructor(
    readonly phase: "bridge" | "display",
    readonly code: string,
  ) {
    super(`Clipboard ${phase} startup failed: ${code}.`);
  }
}

export function reportStartupFailure(
  phase: "bridge" | "display",
  error: unknown,
  write: (line: string) => void,
): never {
  const fallback =
    phase === "bridge" ? bridgeFailureCode(error) : "display-unavailable";
  const code =
    error instanceof Error && "code" in error && isStartupCode(error.code)
      ? error.code
      : fallback;
  write(
    `${JSON.stringify({ type: "clipboard-startup-failed", phase, code })}\n`,
  );
  throw new ClipboardProxyStartupError(phase, code);
}

const TRANSFER_CODES = new Set([
  "transfer-timeout",
  "transfer-format-changed",
  "transfer-size-invalid",
  "transfer-targets-invalid",
  "transfer-type-invalid",
  "transfer-format-unavailable",
  "transfer-failed",
]);

export function transferFailureCode(error: Error): string {
  return "code" in error &&
    typeof error.code === "string" &&
    TRANSFER_CODES.has(error.code)
    ? error.code
    : "transfer-failed";
}

export function decodeClipboardProxyNotice(line: string): string {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "clipboard-operation-failed" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !TRANSFER_CODES.has(value.code)
  )
    throw new Error("Clipboard proxy notice is invalid.");
  return `Clipboard transfer failed: ${value.code}. The local copy was not confirmed on the host.`;
}

interface ClipboardProxyReady {
  readonly DISPLAY: string;
  readonly XAUTHORITY: string;
  readonly WAYLAND_DISPLAY: string;
}

export function decodeClipboardProxyReady(line: string): ClipboardProxyReady {
  if (line.length > 4096)
    throw new Error("Clipboard proxy readiness is invalid.");
  const message: unknown = JSON.parse(line);
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "clipboard-startup-failed" &&
    "phase" in message &&
    (message.phase === "bridge" || message.phase === "display") &&
    "code" in message &&
    isStartupCode(message.code)
  ) {
    throw new ClipboardProxyStartupError(message.phase, message.code);
  }
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "clipboard-ready" ||
    !("display" in message) ||
    typeof message.display !== "string" ||
    !/^:[0-9]{1,5}$/u.test(message.display) ||
    !("authority" in message) ||
    typeof message.authority !== "string" ||
    !/^\/[a-zA-Z0-9_./-]{1,1024}$/u.test(message.authority)
  )
    throw new Error("Clipboard proxy readiness is invalid.");
  return {
    DISPLAY: message.display,
    XAUTHORITY: message.authority,
    WAYLAND_DISPLAY: "",
  };
}
