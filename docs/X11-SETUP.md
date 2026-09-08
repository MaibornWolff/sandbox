# X11 Clipboard Setup

Sandbox uses the X Window System (X11) to share text and images between the host clipboard and the container.

Run this command after you configure the host:

```bash
sandbox setup-x11
```

## macOS

Use XQuartz as the X11 server.

### Install XQuartz

```bash
brew install --cask xquartz
```

You can also download XQuartz from <https://www.xquartz.org>.

### Allow network clients

1. Open XQuartz.
2. Open **XQuartz > Settings > Security**.
3. Enable **Allow connections from network clients**.
4. Restart XQuartz.

```bash
killall XQuartz
open -a XQuartz
```

Restart macOS if this is the first XQuartz installation and the server does not start correctly.

### Allow local connections

Run:

```bash
/opt/X11/bin/xhost +localhost
```

The command must report that it added `localhost` to the access control list.

Add the XQuartz tools to `PATH` when your shell cannot find `xhost`:

```bash
echo 'export PATH="/opt/X11/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

If you need the setting in every shell, add these lines to `~/.zshrc`:

```bash
export DISPLAY=:0
xhost +localhost >/dev/null 2>&1
```

### Prevent an XQuartz clipboard failure

Image paste can fail when XQuartz starts as a login item. Text paste can continue to work.

Remove XQuartz from **System Settings > General > Login Items**. Start XQuartz manually when you need it.

If XQuartz already started at login, restart it:

```bash
killall XQuartz
open -a XQuartz
```

### Diagnose macOS problems

- If XQuartz is not running, run `open -a XQuartz`.
- If network clients are disabled, enable the XQuartz security setting and restart XQuartz.
- If `xhost` does not list `localhost`, run `/opt/X11/bin/xhost +localhost`.
- If `DISPLAY` is empty, run `export DISPLAY=:0`.
- If text paste works but image paste fails, restart XQuartz outside the login process.

## Linux

Most Linux desktop systems provide X11 directly or through XWayland.

### Check the display

```bash
echo "$DISPLAY"
```

The command must print a value such as `:0` or `:1`. Start the desktop display service if the value is empty.

### Allow local connections

```bash
xhost +localhost
```

You can use this Docker-specific rule when the X server supports it:

```bash
xhost +local:docker
```

### Diagnose Linux problems

- If `DISPLAY` is empty, start the X11 or XWayland display service.
- If the connection fails, check `/tmp/.X11-unix/`.
- If access fails, run `xhost` and inspect its output.
- If the session uses Wayland, confirm that XWayland is running.

## Windows

Install an X11 server such as VcXsrv or Xming.

### VcXsrv

1. Install VcXsrv from <https://sourceforge.net/projects/vcxsrv/>.
2. Start XLaunch.
3. Select **Multiple windows**.
4. Set the display number to `0`.
5. Select **Start no client**.
6. Configure Windows Firewall to allow the required container connection.

You can disable VcXsrv access control for local development. This permits more clients to connect. Prefer a Windows Firewall rule that allows only the required connection.

### Xming

1. Install Xming from <https://sourceforge.net/projects/xming/>.
2. Start Xming.
3. Allow Xming through Windows Firewall when required.

### Diagnose Windows problems

- If the X server is not running, start VcXsrv or Xming.
- If the connection is refused, check the X server access controls.
- If the connection is refused, check Windows Firewall.
- If Sandbox cannot find the display, configure display `:0` and restart the X server.

## Verify the Setup

Run on the host:

```bash
sandbox setup-x11
```

Run this internal diagnostic inside a Sandbox container:

```bash
sandbox-container-tools x11 test
```

## Use the Clipboard

Copy text to the host clipboard:

```bash
echo "Hello from Sandbox" | xclip -selection clipboard
```

Read text from the host clipboard:

```bash
xclip -selection clipboard -o
```

Save a clipboard image as a Portable Network Graphics (PNG) file:

```bash
xclip -selection clipboard -t image/png -o > image.png
```

## Configure Clipboard Mode

Set the mode in `~/.config/sandbox/config.toml` or `.sandbox/config.toml`:

```toml
clipboard = "auto"
```

Available modes:

- `auto` uses X11 when it is available.
- `x11` requires an X11 connection.
- `disabled` does not configure clipboard access.

You can also set the mode for one command:

```bash
sandbox --clipboard x11 run bash
sandbox --clipboard disabled run bash
```

## Security

Use `xhost +localhost` to allow local X11 clients. Do not use `xhost +`, because it disables X11 access control for all clients.

Disable clipboard support for a project that must not access the host clipboard:

```toml
clipboard = "disabled"
```
