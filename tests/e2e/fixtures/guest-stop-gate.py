#!/usr/bin/env python3
"""Gate a Podman session stop on the host or in the guest."""

import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


args = sys.argv[1:]
real_podman = os.environ["E2E_REAL_PODMAN"]
if (
    os.environ.get("E2E_STOP_GATE_MODE") == "timeout"
    and args[:1] == ["exec"]
    and "__launch-session" in args
):
    # Detach the local runtime client on the forwarded hangup. Podman can
    # otherwise wait for the guest to exit, hiding the leaked guest session.
    client = subprocess.Popen([real_podman, *args])
    try:
        signal.signal(signal.SIGHUP, lambda *_: client.kill())
        signal.signal(signal.SIGTERM, lambda *_: client.kill())
        status = client.wait(timeout=120)
    finally:
        if client.poll() is None:
            client.kill()
            client.wait(timeout=5)
    sys.exit(status if status >= 0 else 128 - status)

if args[:1] == ["exec"] and args[-2:-1] == ["__stop-session"]:
    gate = Path(os.environ["E2E_STOP_GATE"])
    if os.environ.get("E2E_STOP_GATE_MODE") == "timeout":
        if args[-1] == (gate / "target").read_text():
            tempfile.mkdtemp(prefix="attempt-", dir=gate)
            try:
                (gate / "blocked").mkdir()
            except FileExistsError:
                pass
            else:
                # Outlast the CLI timeout without starting any guest process.
                time.sleep(12)
                (gate / "expired").touch()
                sys.exit("Host stop gate expired before the client was stopped")
        os.execv(real_podman, [real_podman, *args])
    command = args.index("/usr/bin/python3")
    read_fd, write_fd = os.pipe()
    podman_pid = os.getpid()
    if os.fork() == 0:
        os.close(read_fd)
        for fd in (0, 1, 2):
            os.close(fd)
        try:
            deadline = time.monotonic() + 5
            while os.getppid() == podman_pid and time.monotonic() < deadline:
                if (gate / "release").exists():
                    os.write(write_fd, b"stop\n")
                    break
                time.sleep(0.01)
        except BrokenPipeError:
            pass
        finally:
            os._exit(0)
    os.close(write_fd)
    os.dup2(read_fd, 0)
    os.close(read_fd)
    args[command:command] = [
        "/bin/sh",
        "-c",
        'printf "%s\\n" "$2" > "$1.pending" && mv "$1.pending" "$1" || exit 1; '
        'shift 2; read -r token && [ "$token" = stop ] && exec "$@"',
        "stop-gate",
        os.environ["E2E_GUEST_STOP_READY"],
        args[-1],
    ]

os.execv(real_podman, [real_podman, *args])
