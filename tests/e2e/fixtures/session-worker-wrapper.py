"""Keep a worker, socket, and state file live until the wrapper receives shutdown."""

import os
import signal
import socket
import subprocess
import sys
from pathlib import Path


def stop(_signal, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGTERM, stop)

session_id = os.environ["SANDBOX_SESSION_ID"]
worker_socket = Path(f"/tmp/sandbox-e2e-{session_id}.sock")
worker_state = Path(f"/tmp/sandbox-e2e-{session_id}.state")
with socket.socket(socket.AF_UNIX) as server:
    server.bind(str(worker_socket))
    server.listen()
    try:
        worker_state.touch()
        with subprocess.Popen(
            sys.argv[1:], env={**os.environ, "E2E_WRAPPER_PID": str(os.getpid())}
        ) as worker:
            try:
                sys.exit(worker.wait())
            finally:
                if worker.poll() is None:
                    worker.terminate()
                    try:
                        worker.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        worker.kill()
    finally:
        worker_socket.unlink()
        worker_state.unlink()
