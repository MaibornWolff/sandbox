"""Launch a CLI in a controlling PTY and relay terminal commands from stdin."""

import errno
import os
import pty
import select
import signal
import sys


redirect, pgid_file, *command = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    try:
        if pgid_file != "-":
            with open(pgid_file, "w", encoding="ascii") as output:
                output.write(f"{os.tcgetpgrp(0)}\n")
        if redirect != "-":
            with open(redirect, "wb") as output:
                os.dup2(output.fileno(), 2)
        os.execvp(command[0], command)
    except OSError as error:
        print(error, file=sys.stderr, flush=True)
        os._exit(127)

control = sys.stdin.fileno()
reaped = False
try:
    while True:
        descriptors = [control] if master is None else [control, master]
        ready, _, _ = select.select(descriptors, [], [], 0.025)
        if control in ready:
            action = os.read(control, 1)
            if not action:
                break
            if action == b"C":
                os.close(master)
                master = None
            else:
                os.kill(pid, {b"H": signal.SIGHUP, b"T": signal.SIGTERM}[action])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data:
                sys.stderr.buffer.write(data)
                sys.stderr.buffer.flush()
            else:
                os.close(master)
                master = None
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            reaped = True
            print(os.waitstatus_to_exitcode(status), flush=True)
            break
finally:
    if not reaped:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    if master is not None:
        os.close(master)
