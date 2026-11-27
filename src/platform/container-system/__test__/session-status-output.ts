/** One live session that the status probe reports. */
export interface SessionStatusOutputSession {
  readonly pid: number;
  readonly startedAt: Date;
  /** `SANDBOX_SESSION_ID`. Omit it or use `null` for a marker without an ID. */
  readonly id?: string | null;
  /** Requested argv. Omit it or use `null` for a marker before marker v2. */
  readonly command?: readonly string[] | null;
  /** Command line in `/proc`. Defaults to `command`. */
  readonly title?: readonly string[];
}

function encodeFields(fields: readonly string[]): string {
  const hex = Buffer.from(
    fields.map((field) => `${field}\0`).join(""),
  ).toString("hex");
  return hex || "-";
}

function encodeMarker(session: SessionStatusOutputSession): string {
  if (session.command)
    return encodeFields([session.id ?? "", ...session.command]);
  return Buffer.from(session.id ?? "").toString("hex") || "-";
}

/**
 * Format the output of `buildSessionStatusCommand()` for the given state.
 * Session markers use marker v2 when `command` is set, otherwise the marker
 * format before v2.
 */
export function formatSessionStatusOutput(status: {
  readonly ready: boolean;
  readonly sessions: readonly SessionStatusOutputSession[];
}): string {
  const lines = [`ready ${status.ready ? 1 : 0}`];
  for (const session of status.sessions) {
    const started = Math.floor(session.startedAt.getTime() / 1_000);
    const title = encodeFields(session.title ?? session.command ?? []);
    lines.push(
      `session ${session.pid} ${started} ${encodeMarker(session)} ${title}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
