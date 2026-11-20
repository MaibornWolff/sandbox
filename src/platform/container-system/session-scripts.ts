import {
  CONTAINER_READY_FILE,
  CONTAINER_SESSIONS_DIRECTORY,
} from "./container-paths.js";
import { SESSION_MARKER_READ_LIMIT } from "./session-status.js";

const SESSION_CONTROL_MARKERS_DIRECTORY = `${CONTAINER_SESSIONS_DIRECTORY}/.controls`;
const SESSION_TITLE_READ_LIMIT = 512;

const detectActiveSession = [
  `for f in ${CONTAINER_SESSIONS_DIRECTORY}/* ${SESSION_CONTROL_MARKERS_DIRECTORY}/*; do`,
  '[ -f "$f" ] || continue;',
  'kill -0 "$(basename "$f")" 2>/dev/null && exit 1;',
  'rm -f "$f";',
  "done",
].join(" ");

const hexEncode = "od -An -v -tx1 | tr -d ' \\n'";

const readSessionStatus = [
  `if [ -f ${CONTAINER_READY_FILE} ]; then echo 'ready 1'; else echo 'ready 0'; fi`,
  `for f in ${CONTAINER_SESSIONS_DIRECTORY}/*; do`,
  '  [ -f "$f" ] || continue',
  "  pid=${f##*/}",
  "  case $pid in ''|*[!0-9]*) continue ;; esac",
  '  kill -0 "$pid" 2>/dev/null || continue',
  '  started=$(date -r "$f" +%s 2>/dev/null) || continue',
  `  marker=$(head -c ${SESSION_MARKER_READ_LIMIT} "$f" 2>/dev/null | ${hexEncode})`,
  `  title=$(head -c ${SESSION_TITLE_READ_LIMIT} "/proc/$pid/cmdline" 2>/dev/null | ${hexEncode})`,
  '  echo "session $pid $started ${marker:--} ${title:--}"',
  "done",
].join("\n");

/**
 * Shell command that removes stale session markers and exits with 0 when the
 * container has no active sessions, or with 1 when sessions remain.
 */
export function buildSessionIdleCommand(): string[] {
  return ["sh", "-c", detectActiveSession];
}

/**
 * Read-only shell command that prints the ready state and one line per live
 * session. `parseSessionStatus()` reads its output.
 */
export function buildSessionStatusCommand(): string[] {
  return ["sh", "-c", readSessionStatus];
}
