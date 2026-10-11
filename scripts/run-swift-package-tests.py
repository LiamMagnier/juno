#!/usr/bin/env python3
"""Run a Swift package test suite with one bounded retry after a true stall."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=480)
    parser.add_argument("--attempts", type=int, default=2)
    return parser.parse_args()


def stop_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def report_new_test_crash(started: float) -> None:
    """Print only crash reason/frames for this run's test process, never environment."""
    directory = Path.home() / "Library" / "Logs" / "DiagnosticReports"
    for _ in range(10):
        candidates = [file for file in directory.glob("*.ips")
                      if file.stat().st_mtime >= started and
                      (file.name.startswith("xctest") or "PackageTests" in file.name)]
        for file in sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                raw = file.read_text()
                # macOS writes a one-line metadata JSON followed by the report.
                _, _, body = raw.partition("\n")
                report = json.loads(body)
                index = report.get("faultingThread", 0)
                threads = report.get("threads", [])
                if not isinstance(index, int) or not 0 <= index < len(threads):
                    continue
                images = report.get("usedImages", [])
                frames = []
                for frame in threads[index].get("frames", [])[:80]:
                    image_index = frame.get("imageIndex")
                    image = images[image_index].get("name") if isinstance(image_index, int) and 0 <= image_index < len(images) else None
                    frames.append({"symbol": frame.get("symbol"), "image": image,
                                   "offset": frame.get("symbolLocation", frame.get("imageOffset"))})
                summary = {key: report.get(key) for key in ("procName", "exception", "termination", "asi")}
                summary["faultingFrames"] = frames
                print("New test crash diagnostic:\n" + json.dumps(summary, indent=2), file=sys.stderr, flush=True)
                return
            except (OSError, ValueError, TypeError):
                continue
        time.sleep(0.5)
    print("No new test crash report was available; failure remains blocking.", file=sys.stderr)


def main() -> int:
    args = parse_args()
    repository = Path.cwd()
    package_path = repository / "native" / "Packages" / args.package
    runner_temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))

    if not package_path.is_dir():
        print(f"Package directory does not exist: {package_path}", file=sys.stderr)
        return 2
    if args.timeout_seconds <= 0 or args.attempts <= 0:
        print("Timeout and attempts must be positive.", file=sys.stderr)
        return 2

    for attempt in range(1, args.attempts + 1):
        scratch_path = runner_temp / f"{args.package}-tests-attempt-{attempt}"
        command = [
            "swift",
            "test",
            "--package-path",
            str(package_path),
            "--scratch-path",
            str(scratch_path),
            "--no-parallel",
            "-Xswiftc",
            "-warnings-as-errors",
        ]
        print(
            f"Running {args.package} tests (attempt {attempt}/{args.attempts}, "
            f"timeout {args.timeout_seconds}s).",
            flush=True,
        )
        started = time.time()
        process = subprocess.Popen(command, start_new_session=True)
        try:
            return_code = process.wait(timeout=args.timeout_seconds)
        except subprocess.TimeoutExpired:
            print(
                f"{args.package} test process stalled for {args.timeout_seconds}s; "
                "terminating its process group.",
                file=sys.stderr,
                flush=True,
            )
            stop_process_group(process)
            if attempt < args.attempts:
                print("Retrying with a clean SwiftPM scratch path.", flush=True)
                continue
            return 124

        if return_code != 0:
            print(
                f"{args.package} tests failed with exit code {return_code}; "
                "a real failure is not retried.",
                file=sys.stderr,
            )
            report_new_test_crash(started)
        return return_code

    return 124


if __name__ == "__main__":
    raise SystemExit(main())
