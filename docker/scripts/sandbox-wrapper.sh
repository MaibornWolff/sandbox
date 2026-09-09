#!/bin/sh
# Use the image-owned application, independent of host file sharing.
CLI_ENTRY="/opt/sandbox-cli/dist/apps/sandbox/main.js"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "Sandbox CLI is not available." >&2
  echo "The Sandbox image is incomplete. Run 'sandbox build' on the host." >&2
  exit 1
fi
exec /usr/bin/node "$CLI_ENTRY" "$@"
