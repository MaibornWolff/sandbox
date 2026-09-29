import { CONTAINER_SESSIONS_DIRECTORY } from "./container-paths.js";

const removeStaleSessionMarkers = [
  `for f in ${CONTAINER_SESSIONS_DIRECTORY}/*; do`,
  '[ -f "$f" ] || continue;',
  'kill -0 "$(basename "$f")" 2>/dev/null || rm -f "$f";',
  "done",
].join(" ");

/**
 * Shell command that removes stale session markers and exits with 0 when the
 * container has no active sessions, or with 1 when sessions remain.
 */
export function buildSessionIdleCommand(): string[] {
  return [
    "sh",
    "-c",
    `${removeStaleSessionMarkers}; [ -z "$(ls ${CONTAINER_SESSIONS_DIRECTORY}/ 2>/dev/null)" ]`,
  ];
}

/**
 * Shell command that removes stale session markers and prints one
 * `<pid>|<command>` line per active session.
 */
export function buildSessionDetailsCommand(): string[] {
  return [
    "sh",
    "-c",
    [
      `for f in ${CONTAINER_SESSIONS_DIRECTORY}/*; do`,
      '[ -f "$f" ] || continue;',
      'pid=$(basename "$f");',
      'kill -0 "$pid" 2>/dev/null || { rm -f "$f"; continue; };',
      'cmd=$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null | head -c 200);',
      'echo "$pid|$cmd";',
      "done",
    ].join(" "),
  ];
}
