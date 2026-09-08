#!/bin/sh
# =============================================================================
# Exec Session Entrypoint
# =============================================================================
# Wrapper for docker exec sessions in reused containers.
# Manages session marker files for idle detection and drops privileges via gosu.
#
# Session markers live in /tmp/sandbox-sessions/, one file per session named by PID.
# The idle watcher (container PID 1) cleans stale markers by verifying PIDs are alive.
#
# Marker cleanup: best-effort via EXIT trap. Since gosu uses exec() to replace
# this shell, the trap only fires if the script exits before reaching gosu.
# Primary cleanup is handled by the idle watcher's kill -0 check on dead PIDs.
# =============================================================================

set -e

mkdir -p /tmp/sandbox-sessions
session_file="/tmp/sandbox-sessions/$$"
touch "$session_file"
trap 'rm -f "$session_file"' EXIT

# Load the sandbox user's profile for non-interactive commands too. Prefer zsh
# to match the default sandbox shell, but fall back to bash or sh if a derived
# image removed zsh.
if command -v zsh >/dev/null 2>&1; then
  profile_shell="$(command -v zsh)"
elif command -v bash >/dev/null 2>&1; then
  profile_shell="$(command -v bash)"
else
  profile_shell="/bin/sh"
fi

exec gosu sandbox "$profile_shell" -lc 'exec "$@"' sandbox-exec "$@"
