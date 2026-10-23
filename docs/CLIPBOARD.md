# Clipboard access

Attached Sandbox sessions enable host clipboard access by default.
Container processes can read or replace the host clipboard without a visible paste action.
Disable it when the clipboard can contain secrets.

## Disable access

Add this to your user configuration:

```toml
clipboard = "disabled"
```

Start new attached sessions after changing it.
Project configuration can override the user value.
Check `sandbox config` for the effective mode.

Modes are `"enabled"` and `"disabled"`.
Replace old `"auto"` or `"x11"` values with `"enabled"`.
Remove obsolete `--clipboard` and `-c` flags.

Disabling the bridge does not disable normal terminal text paste or allowed host commands.

## Copy and paste

Inside an attached session:

```bash
printf '%s' 'Hello from Sandbox' | xclip -selection clipboard
xclip -selection clipboard -o
xclip -selection clipboard -t image/png -o > image.png
```

Supported content is Unicode text or a PNG image.
File references, mixed content, and the X11 `PRIMARY` selection are not supported.

Sandbox uses a private container X11 display.
You do not need [XQuartz](https://www.xquartz.org/) or a Windows X server.
Do not change host `xhost` rules or forward a host display.

## Host limits

The native clipboard dependency, [CrossCopy](https://www.npmjs.com/package/@crosscopy/clipboard), provides binaries for:

- macOS x64 and arm64.
- Windows x64 in an interactive user session.
- Linux x64 with glibc and a working X11 or XWayland clipboard.

It does not declare native binaries for Windows arm64, Linux arm64, or Linux musl.
Native Wayland-only clipboard access is not supported.
A Linux copy can need a live clipboard owner and may not survive Sandbox exit.
These dependency targets are not proof of testing on every host.

Bare `sandbox container start` does not provide the clipboard bridge.
If clipboard setup fails, Sandbox warns and continues without it.
A failed write can leave the host clipboard changed.

Clipboard access and host-command permissions are independent.
Processes sharing the container user are within the same trust boundary.
