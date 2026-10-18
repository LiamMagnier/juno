#!/usr/bin/env python3
"""Run a Swift package test suite with one bounded retry after a true stall."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=480)
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--build-timeout-seconds", type=int, default=600)
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


def main() -> int:
    args = parse_args()
    repository = Path.cwd()
    package_path = repository / "native" / "Packages" / args.package
    runner_temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))

    if not package_path.is_dir():
        print(f"Package directory does not exist: {package_path}", file=sys.stderr)
        return 2
    if min(args.timeout_seconds, args.build_timeout_seconds, args.attempts) <= 0:
        print("Timeout and attempts must be positive.", file=sys.stderr)
        return 2

    # Compilation is not a stalled test. JunoCode's cold build takes 5–6
    # minutes on CI; charging it to the test deadline killed progressing tests.
    scratch_path = runner_temp / f"{args.package}-tests"
    common = [
        "--package-path", str(package_path),
        "--scratch-path", str(scratch_path),
        "-Xswiftc", "-warnings-as-errors",
    ]
    print(f"Building {args.package} tests (timeout {args.build_timeout_seconds}s).", flush=True)
    build = subprocess.Popen(["swift", "build", "--build-tests", *common], start_new_session=True)
    try:
        build_code = build.wait(timeout=args.build_timeout_seconds)
    except subprocess.TimeoutExpired:
        print(f"{args.package} test build exceeded its deadline.", file=sys.stderr, flush=True)
        stop_process_group(build)
        return 124
    if build_code != 0:
        return build_code

    for attempt in range(1, args.attempts + 1):
        command = ["swift", "test", "--skip-build", "--no-parallel", *common]
        print(
            f"Running {args.package} tests (attempt {attempt}/{args.attempts}, "
            f"timeout {args.timeout_seconds}s).",
            flush=True,
        )
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
                print("Retrying the built tests in a fresh process.", flush=True)
                continue
            return 124

        if return_code != 0:
            print(
                f"{args.package} tests failed with exit code {return_code}; "
                "a real failure is not retried.",
                file=sys.stderr,
            )
        return return_code

    return 124


if __name__ == "__main__":
    raise SystemExit(main())
