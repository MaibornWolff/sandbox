/** Largest session marker that the status probe decodes completely. */
const SESSION_MARKER_LIMIT = 64 * 1024;

/**
 * Bytes that the probe reads from each marker. The extra byte lets the parser
 * detect a marker that is larger than the limit.
 */
export const SESSION_MARKER_READ_LIMIT = SESSION_MARKER_LIMIT + 1;

/** One live session in a container, as the status probe reports it. */
export interface ContainerSession {
  /** Process ID of the session in the container. */
  readonly pid: number;
  /** Modification time of the session marker, precise to the second. */
  readonly startedAt: Date;
  /** `SANDBOX_SESSION_ID`, or `null` for markers without an ID. */
  readonly id: string | null;
  /** Requested argv, or `null` for older or incomplete markers. */
  readonly command: readonly string[] | null;
  /** Command line from `/proc`. Show it only when `command` is `null`. */
  readonly title: string;
}

/** Ready state and live sessions of one container. */
export interface ContainerSessionStatus {
  readonly ready: boolean;
  readonly sessions: readonly ContainerSession[];
}

const EMPTY_FIELD = "-";
const LINE_PREVIEW_LENGTH = 80;

function previewLine(line: string): string {
  return line.length > LINE_PREVIEW_LENGTH
    ? `${line.slice(0, LINE_PREVIEW_LENGTH)}…`
    : line;
}

function decodeHex(value: string, field: string): Buffer {
  if (value === EMPTY_FIELD) return Buffer.alloc(0);
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) {
    throw new Error(`Session status has an invalid ${field} encoding.`);
  }
  return Buffer.from(value, "hex");
}

function splitZeroTerminated(bytes: Buffer): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    fields.push(bytes.subarray(start, end).toString("utf8"));
    start = end + 1;
  }
  return fields;
}

function decodeMarker(bytes: Buffer): Pick<ContainerSession, "id" | "command"> {
  const tooLarge = bytes.length > SESSION_MARKER_LIMIT;
  const idEnd = bytes.indexOf(0);
  if (idEnd === -1) {
    const id = tooLarge ? "" : bytes.toString("utf8");
    return { id: id || null, command: null };
  }
  const id = bytes.subarray(0, idEnd).toString("utf8") || null;
  const complete = !tooLarge && bytes.at(-1) === 0;
  if (!complete) return { id, command: null };
  return { id, command: splitZeroTerminated(bytes.subarray(idEnd + 1)) };
}

function decodeTitle(bytes: Buffer): string {
  return bytes
    .toString("utf8")
    .split("\0")
    .filter((part) => part !== "")
    .join(" ");
}

function parseInteger(value: string | undefined, field: string): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error(`Session status has an invalid ${field}: ${value ?? ""}`);
  }
  return Number(value);
}

function parseSessionLine(line: string): ContainerSession {
  const fields = line.split(" ");
  if (fields.length !== 5) {
    throw new Error(
      `Session status has an invalid session line: ${previewLine(line)}`,
    );
  }
  const [, pid, started, marker = "", title = ""] = fields;
  return {
    pid: parseInteger(pid, "PID"),
    startedAt: new Date(parseInteger(started, "start time") * 1_000),
    ...decodeMarker(decodeHex(marker, "marker")),
    title: decodeTitle(decodeHex(title, "title")),
  };
}

/**
 * Parse the output of `buildSessionStatusCommand()`. Throws if the output does
 * not start with a valid `ready` line or contains an invalid line.
 */
export function parseSessionStatus(output: string): ContainerSessionStatus {
  const [readyLine, ...lines] = output.split("\n");
  if (readyLine !== "ready 0" && readyLine !== "ready 1") {
    throw new Error("Session status output has no valid ready line.");
  }
  const sessions: ContainerSession[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if (!line.startsWith("session ")) {
      throw new Error(
        `Session status has an unknown line: ${previewLine(line)}`,
      );
    }
    sessions.push(parseSessionLine(line));
  }
  return { ready: readyLine === "ready 1", sessions };
}
