#!/bin/sh
# The host mounts the cached runtime package read-only during container startup.
CLI_ENTRY="/opt/sandbox-cli/dist/apps/sandbox/main.js"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "Sandbox CLI is not available." >&2
  echo "The Sandbox runtime package is missing. Start this container through Sandbox on the host." >&2
  exit 1
fi
exec /usr/bin/node "$CLI_ENTRY" "$@"
