# Clipboard access

Sandbox prepares clipboard access by default for each attached host session. It uses a private X Window System (X11) display inside the container. The host uses `@crosscopy/clipboard` to read and write the host clipboard.

No XQuartz installation or Windows X server is required. Do not change host `xhost` access rules. Sandbox does not forward the host `DISPLAY` or mount host X11 sockets into the container.

## Disable clipboard access

Clipboard access is enabled by default. To disable all Sandbox clipboard reads and writes, set this in your user `config.toml`:

```toml
clipboard = "disabled"
```

The available modes are `"enabled"` and `"disabled"`. Project settings override user settings. Restart attached sessions after you change the setting. Disabled sessions have no clipboard capabilities or private display. The host does not load the native clipboard package for them. Host commands and normal terminal text paste still work.

Replace old `"auto"` and `"x11"` clipboard modes with `"enabled"`. Remove `--clipboard` and `-c` from commands and scripts.

Clipboard access is automatic only in attached host sessions. Bare foreground container startup does not provide a host clipboard bridge.

## Host requirements and limits

The reviewed CrossCopy 0.3.6 package declares these native binary targets:

- macOS x64 and arm64: native AppKit pasteboard access.
- Windows x64: Microsoft Visual C++ binary. Run Sandbox in the user's interactive session, not Session 0.
- Linux x64 with glibc: an existing host X11 display or a usable XWayland display.

The reviewed package does not declare native dependencies for Windows arm64, Linux arm64, or Linux musl. These are host requirements, not container architecture requirements.

Limits:

- On Linux, CrossCopy uses X11. A Wayland desktop needs a working XWayland clipboard path. Native Wayland-only access is not supported.
- A Linux copy can depend on a live clipboard owner. Do not assume that copied data remains available after Sandbox exits.
- These package targets are not verified Sandbox support claims. Real operations and performance need tests on each host.

## Use the clipboard

Inside an attached session, copy text to the host clipboard:

```bash
printf '%s' 'Hello from Sandbox' | xclip -selection clipboard
```

Read text from the host clipboard:

```bash
xclip -selection clipboard -o
```

Save a clipboard image as a Portable Network Graphics (PNG) file:

```bash
xclip -selection clipboard -t image/png -o > image.png
```

The initial content types are Unicode text and PNG images. Each container copy publishes one text or image item. File references, mixed text and image items, and the X11 `PRIMARY` selection are outside this scope.

Host content is read when an application requests it. Sandbox does not continuously copy host clipboard changes into the container.

## Failures

If private clipboard setup fails, Sandbox reports a warning. The attached command and normal terminal text paste remain usable. Sandbox does not inject a failed display or forward the host display as a fallback.

A missing native binary, denied access, unavailable format, or interrupted transfer can fail a clipboard operation. An interrupted write can have an uncertain result. Do not assume that the host clipboard is unchanged after a write failure.

## Access risks

When clipboard access is enabled, any process with access to an attached session can read or replace the host clipboard without a visible paste action. Reads can expose passwords and other sensitive data. Writes can replace content that you use outside Sandbox. Run only trusted processes when the host clipboard contains sensitive data.

Session authentication and separate clipboard read and write capabilities control bridge requests. Clipboard access does not require permission to run host commands. Processes that share a container and user remain in the same trust boundary.

The private X11 display disables network listening and uses session authentication. Host bridge network exposure, firewall scope, and transport confidentiality also need review. Authentication alone does not encrypt clipboard data.
