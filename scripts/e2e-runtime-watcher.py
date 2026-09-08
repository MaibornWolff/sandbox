#!/usr/bin/env python3
"""Run Docker and Podman E2E tests whenever a trigger file changes."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATE_DIR = REPO_ROOT / ".e2e-watcher"
DEFAULT_TESTS = ("tests/e2e/",)
RUNTIMES = ("docker", "podman")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "tests",
        nargs="*",
        default=list(DEFAULT_TESTS),
        help="Test files or directories passed to bun test (default: tests/e2e/)",
    )
    parser.add_argument(
        "--trigger",
        type=Path,
        default=DEFAULT_STATE_DIR / "trigger",
        help="File to watch for changes",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_STATE_DIR,
        help="Directory for current and historical logs",
    )
    parser.add_argument(
        "--run-now",
        action="store_true",
        help="Run once immediately instead of waiting for the first trigger",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=0.5,
        help="Trigger polling interval in seconds (default: 0.5)",
    )
    return parser.parse_args()


def trigger_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_mtime_ns, stat.st_size


def timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def display_command(command: list[str]) -> str:
    return subprocess.list2cmdline(command)


def run_command(
    command: list[str],
    log: TextIO,
    *,
    environment: dict[str, str] | None = None,
) -> tuple[int, float]:
    started = time.monotonic()
    rendered = display_command(command)
    header = f"\n$ {rendered}\n"
    print(header, end="", flush=True)
    log.write(header)
    log.flush()

    process = subprocess.Popen(
        command,
        cwd=REPO_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    try:
        if process.stdout is None:
            raise RuntimeError(f"Failed to capture output from: {rendered}")
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line)
            log.flush()
        exit_code = process.wait()
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise

    duration = time.monotonic() - started
    footer = f"\nExit code: {exit_code} ({duration:.1f}s)\n"
    print(footer, end="", flush=True)
    log.write(footer)
    log.flush()
    return exit_code, duration


def copy_latest(source: Path, destination: Path) -> None:
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    shutil.copyfile(source, temporary)
    temporary.replace(destination)


def run_tests(args: argparse.Namespace, bun: str) -> None:
    run_id = timestamp()
    history_dir = args.output_dir / "runs" / run_id
    history_dir.mkdir(parents=True, exist_ok=True)
    combined_path = history_dir / "combined.log"
    results: dict[str, object] = {}
    summary: dict[str, object] = {
        "runId": run_id,
        "startedAt": datetime.now(UTC).isoformat(),
        "tests": args.tests,
        "results": results,
    }

    with combined_path.open("w", encoding="utf-8") as combined:
        build_path = history_dir / "build.log"
        with build_path.open("w", encoding="utf-8") as build_log:
            build_code, build_duration = run_command([bun, "run", "build"], build_log)
        combined.write(build_path.read_text(encoding="utf-8"))
        copy_latest(build_path, args.output_dir / "latest-build.log")
        summary["build"] = {
            "exitCode": build_code,
            "durationSeconds": round(build_duration, 3),
            "log": str(build_path),
        }

        if build_code == 0:
            for runtime in RUNTIMES:
                runtime_path = history_dir / f"{runtime}.log"
                environment = os.environ.copy()
                environment["SANDBOX_TEST_RUNTIME"] = runtime
                with runtime_path.open("w", encoding="utf-8") as runtime_log:
                    exit_code, duration = run_command(
                        [bun, "test", "--timeout", "120000", *args.tests],
                        runtime_log,
                        environment=environment,
                    )
                combined.write(runtime_path.read_text(encoding="utf-8"))
                combined.flush()
                copy_latest(runtime_path, args.output_dir / f"latest-{runtime}.log")
                results[runtime] = {
                    "exitCode": exit_code,
                    "durationSeconds": round(duration, 3),
                    "log": str(runtime_path),
                }
        else:
            summary["skipped"] = "Runtime tests skipped because the build failed"

    summary["finishedAt"] = datetime.now(UTC).isoformat()
    summary_path = history_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    copy_latest(combined_path, args.output_dir / "latest.log")
    copy_latest(summary_path, args.output_dir / "latest-summary.json")
    print(f"Results: {args.output_dir / 'latest-summary.json'}", flush=True)


def main() -> int:
    args = parse_args()
    if args.poll_interval <= 0:
        raise ValueError("--poll-interval must be greater than zero")

    args.trigger = args.trigger.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.trigger.parent.mkdir(parents=True, exist_ok=True)
    args.trigger.touch(exist_ok=True)

    bun = shutil.which("bun")
    if bun is None:
        print("bun was not found in PATH", file=sys.stderr)
        return 1

    previous_signature = trigger_signature(args.trigger)
    print(f"Watching: {args.trigger}")
    print(f"Tests: {', '.join(args.tests)}")
    print(f"Logs: {args.output_dir}")
    trigger_code = f"from pathlib import Path; Path({str(args.trigger)!r}).touch()"
    trigger_command = subprocess.list2cmdline([sys.executable, "-c", trigger_code])
    print(f"Trigger with: {trigger_command}")

    if args.run_now:
        run_tests(args, bun)
        previous_signature = trigger_signature(args.trigger)

    try:
        while True:
            time.sleep(args.poll_interval)
            current_signature = trigger_signature(args.trigger)
            if current_signature == previous_signature:
                continue
            previous_signature = current_signature
            print(f"\nTrigger changed at {datetime.now(UTC).isoformat()}")
            run_tests(args, bun)
    except KeyboardInterrupt:
        print("\nWatcher stopped")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
