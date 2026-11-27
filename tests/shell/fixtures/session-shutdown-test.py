"""Test session shutdown without depending on the host kernel or running as root."""

import importlib.util
from pathlib import Path
import signal
import stat
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch


script = Path(__file__).resolve().parents[3] / "src/platform/container-system/guest/session-shutdown.py"
spec = importlib.util.spec_from_file_location("session_shutdown", script)
shutdown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shutdown)
SESSION = "93b080a5-b550-46ef-8359-c6c53d51be0d"
SIBLING = "06592aee-a1c5-4e36-bd4c-b3bcbf65505a"


class SessionShutdownTest(unittest.TestCase):
    def setUp(self):
        directory = self.use(TemporaryDirectory())
        registry = Path(directory)
        self.record = registry / SESSION
        self.sibling = registry / SIBLING
        self.sibling.write_text("42 200\n")
        self.use(patch.object(shutdown, "REGISTRY", registry))
        self.use(patch.object(shutdown, "process_start_time", return_value="100"))
        self.open_pidfd = self.use(
            patch.object(shutdown.os, "pidfd_open", return_value=12_345, create=True)
        )
        self.send = self.use(patch.object(signal, "pidfd_send_signal", create=True))
        self.wait_for_exit = self.use(
            patch.object(shutdown, "wait_for_exit", side_effect=[False, True])
        )
        self.remove_marker = self.use(patch.object(shutdown, "remove_marker"))
        close = shutdown.os.close
        self.use(patch.object(shutdown.os, "close", side_effect=lambda fd: (
            None if fd == 12_345 else close(fd)
        )))

    def use(self, context):
        value = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        return value

    def stop(self):
        shutdown.stop(self.record, SESSION)

    def test_stop_before_registration_cancels_launch(self):
        self.stop()
        self.assertFalse(shutdown.register(self.record, 41))
        self.assertEqual(self.record.read_bytes(), b"")
        self.open_pidfd.assert_not_called()

    def test_only_the_exact_session_is_signaled(self):
        self.assertTrue(shutdown.register(self.record, 41))
        self.stop()
        self.open_pidfd.assert_called_once_with(41)
        self.send.assert_called_once_with(12_345, signal.SIGTERM)
        self.remove_marker.assert_called_once_with(41, SESSION)
        self.assertEqual(self.sibling.read_text(), "42 200\n")

    def test_absent_pid_is_a_no_op(self):
        self.record.write_text("41 100\n")
        self.open_pidfd.side_effect = ProcessLookupError
        self.stop()
        self.send.assert_not_called()
        self.remove_marker.assert_called_once_with(41, SESSION)

    def test_reused_pid_is_not_signaled(self):
        self.record.write_text("41 50\n")
        self.stop()
        self.send.assert_not_called()
        self.remove_marker.assert_called_once_with(41, SESSION)

    def test_process_exit_during_grace_period_does_not_signal_reused_pid(self):
        self.record.write_text("41 100\n")
        self.wait_for_exit.side_effect = [False, True]
        self.stop()
        self.send.assert_called_once_with(12_345, signal.SIGTERM)
        self.open_pidfd.assert_called_once_with(41)

    def test_escalation_uses_the_same_descriptor_with_bounded_waits(self):
        self.record.write_text("41 100\n")
        self.wait_for_exit.side_effect = [False, False, True]
        self.stop()
        self.assertEqual(
            self.send.call_args_list,
            [call(12_345, signal.SIGTERM), call(12_345, signal.SIGKILL)],
        )
        self.assertEqual(
            self.wait_for_exit.call_args_list,
            [call(12_345, 0), call(12_345, 500), call(12_345, 500)],
        )
        self.remove_marker.assert_called_once_with(41, SESSION)

    def test_failed_escalation_preserves_the_marker(self):
        self.record.write_text("41 100\n")
        self.wait_for_exit.side_effect = [False, False, False]
        with self.assertRaisesRegex(ValueError, "did not exit"):
            self.stop()
        self.remove_marker.assert_not_called()

    def test_descriptor_failure_does_not_fall_back_to_a_raw_pid(self):
        self.record.write_text("41 100\n")
        self.open_pidfd.side_effect = PermissionError
        with self.assertRaises(PermissionError):
            self.stop()
        self.send.assert_not_called()
        self.remove_marker.assert_not_called()

    def test_ambiguous_registration_sends_no_signals(self):
        self.record.write_text("41 100\n42 200\n")
        with self.assertRaisesRegex(ValueError, "ambiguous session process registration"):
            self.stop()
        self.open_pidfd.assert_not_called()
        self.remove_marker.assert_not_called()

    def test_duplicate_registration_cannot_overwrite_original(self):
        self.assertTrue(shutdown.register(self.record, 41))
        with self.assertRaisesRegex(ValueError, "already has a registered process"):
            shutdown.register(self.record, 42)
        self.assertEqual(self.record.read_text(), "41 100\n")


class SessionMarkerTest(unittest.TestCase):
    def test_removes_only_markers_with_the_exact_session_id(self):
        session = SESSION.encode("ascii")
        sibling = SIBLING.encode("ascii")
        with TemporaryDirectory() as directory, patch.object(shutdown, "MARKERS", directory):
            self.check_markers(Path(directory), session, sibling)

    def check_markers(self, directory, session, sibling):
        marker = directory / "41"
        owner = directory.stat().st_uid
        real_fstat = shutdown.os.fstat

        def fstat(fd):
            info = real_fstat(fd)
            if stat.S_ISDIR(info.st_mode) and info.st_uid == owner:
                return SimpleNamespace(st_uid=0, st_mode=info.st_mode)
            return info

        with patch.object(shutdown.os, "fstat", side_effect=fstat):
            for contents, removed in (
                (session, True),
                (session + b"\0claude\0--resume\0", True),
                (sibling + b"\0claude\0", False),
                (session + b"x", False),
            ):
                with self.subTest(contents=contents):
                    marker.write_bytes(contents)
                    shutdown.remove_marker(41, SESSION)
                    self.assertEqual(not marker.exists(), removed)


if __name__ == "__main__":
    unittest.main()
