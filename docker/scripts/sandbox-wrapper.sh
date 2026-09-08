#!/bin/sh
# Stable handoff to the package-mounted public Sandbox CLI.
CLI_ENTRY="/opt/sandbox-cli/dist/apps/sandbox/main.js"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "Sandbox CLI is not available." >&2
  echo "Update Sandbox on the host and rebuild the image." >&2
  exit 1
fi
exec /usr/bin/node "$CLI_ENTRY" "$@"
