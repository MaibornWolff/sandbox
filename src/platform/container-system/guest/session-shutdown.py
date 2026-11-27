"""Register or stop the foreground process of one attached Sandbox session."""

import contextlib
import os
from pathlib import Path
import re
import select
import signal
import stat
import sys
import tempfile


REGISTRY = Path("/run/sandbox/session-shutdown")
READY = Path("/run/sandbox/ready")
MARKERS = "/tmp/sandbox-sessions"
ENTRYPOINT = "/usr/local/bin/exec-entrypoint.sh"
SESSION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
IDENTITY = re.compile(r"([1-9][0-9]*) ([0-9]+)\n")


def process_start_time(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
    if len(fields) <= 19 or not fields[19].isdigit():
        raise ValueError("Invalid Linux process start time.")
    if fields[0] in (b"Z", b"X", b"x"):
        return None
    return fields[19].decode("ascii")


def registration_path(session_id, *, create=True):
    if not SESSION_ID.fullmatch(session_id):
        raise ValueError("Invalid session ID.")
    if create:
        REGISTRY.mkdir(mode=0o700, exist_ok=True)
    info = REGISTRY.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError("Session registry is not private to root.")
    return REGISTRY / session_id


def register(record, pid):
    start = process_start_time(pid)
    if start is None:
        raise ValueError("Could not read the session process identity.")
    fd, temp = tempfile.mkstemp(dir=REGISTRY)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            stream.write(f"{pid} {start}\n")
        try:
            os.link(temp, record)
        except FileExistsError:
            if record.read_bytes() == b"":
                return False
            raise ValueError("Session already has a registered process.") from None
    finally:
        os.unlink(temp)
    return True


def wait_for_exit(pidfd, milliseconds):
    poll = select.poll()
    poll.register(pidfd, select.POLLIN)
    for _, events in poll.poll(milliseconds):
        if events & (select.POLLIN | select.POLLHUP):
            return True
        raise OSError("Could not poll the session process descriptor.")
    return False


def stop_process(pid, start):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ValueError("Linux process descriptor support is required to stop a session safely.")
    try:
        pidfd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        # The descriptor cannot move to a reused PID after this identity check.
        if process_start_time(pid) != start or wait_for_exit(pidfd, 0):
            return
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
            if wait_for_exit(pidfd, 500):
                return
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError:
            return
        if not wait_for_exit(pidfd, 500):
            raise ValueError("Session process did not exit after SIGKILL.")
    finally:
        os.close(pidfd)


@contextlib.contextmanager
def marker_directory():
    fd = os.open(MARKERS, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Session marker directory is writable by non-root users.")
        yield fd
    finally:
        os.close(fd)


def remove_marker(pid, session_id):
    with contextlib.suppress(FileNotFoundError), marker_directory() as directory:
        name = str(pid)
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        with os.fdopen(fd, "rb") as marker:
            encoded_id = session_id.encode("ascii")
            if (
                stat.S_ISREG(os.fstat(marker.fileno()).st_mode)
                and marker.read(len(encoded_id) + 1) in (encoded_id, encoded_id + b"\0")
            ):
                os.unlink(name, dir_fd=directory)


def stop(record, session_id):
    # Install a tombstone if the attached exec has not published its identity.
    # Exactly one of this open and the launcher's link can create the record.
    try:
        fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(fd)
        return
    data = record.read_text(encoding="ascii")
    if not data:
        return
    match = IDENTITY.fullmatch(data)
    if not match or not 1 < int(match[1]) < 2**31:
        raise ValueError("Invalid or ambiguous session process registration.")
    pid = int(match[1])
    stop_process(pid, match[2])
    remove_marker(pid, session_id)


def read_metadata(path, limit, *, private=False, directory=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
            raise ValueError("Invalid session metadata file.")
        return os.read(fd, limit), info
    finally:
        os.close(fd)


def selected_session(session_id):
    ready = int(READY.is_file())
    try:
        record = registration_path(session_id, create=False)
        data, _ = read_metadata(record, 64, private=True)
    except FileNotFoundError:
        print(f"ready {ready}")
        return
    match = IDENTITY.fullmatch(data.decode("ascii"))
    if not match or not 1 < int(match[1]) < 2**31:
        raise ValueError("Invalid session process registration.")
    pid = int(match[1])
    if process_start_time(pid) != match[2]:
        raise ValueError("Session registration does not have a live process.")
    expected = session_id.encode("ascii") + b"\0"
    try:
        with marker_directory() as directory:
            marker, info = read_metadata(str(pid), len(expected), directory=directory)
    except FileNotFoundError:
        print(f"ready {ready}")
        return
    if marker != expected or process_start_time(pid) != match[2]:
        raise ValueError("Session marker does not match the registered process.")
    print(f"ready {ready}\nsession {session_id} {pid} {info.st_mtime_ns // 10**9}")


def main(args):
    if len(args) < 2:
        raise ValueError("Missing session operation or ID.")
    operation, session_id, *command = args
    if operation == "__status-session" and not command:
        selected_session(session_id)
        return 0
    record = registration_path(session_id)
    if operation == "__stop-session" and not command:
        stop(record, session_id)
        return 0
    if operation == "__launch-session" and command:
        if not register(record, os.getpid()):
            return 1
        os.execv(ENTRYPOINT, [ENTRYPOINT, *command])
    raise ValueError("Invalid session operation.")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError, IndexError) as error:
        sys.exit(f"Session shutdown: {error}")
