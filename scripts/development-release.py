#!/usr/bin/env python3
"""Build a private, unsigned development candidate; never publish or deploy."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ("JunoNativeKit", "JunoCode", "JunoWork", "JunoScreenControl")


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def require_source(root: Path, expected: str | None = None) -> str:
    sha = git(root, "rev-parse", "HEAD")
    if expected and sha != expected:
        raise RuntimeError("Source commit changed during candidate verification")
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise RuntimeError("Candidate requires a clean committed worktree, including untracked files")
    for marker in ("MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"):
        if Path(git(root, "rev-parse", "--path-format=absolute", "--git-path", marker)).exists():
            raise RuntimeError(f"Unfinished Git integration: {marker}")
    return sha


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_bundle_source(bundle: Path, expected: str) -> None:
    info = bundle / ("Contents/Info.plist" if (bundle / "Contents").exists() else "Info.plist")
    with info.open("rb") as stream:
        actual = plistlib.load(stream).get("JunoGitSHA")
    if actual != expected:
        raise RuntimeError(f"Bundle source mismatch: {bundle.name}: {actual!r}")


def commands(output: Path, sha: str, simulator: str) -> list[tuple[str, list[str]]]:
    steps = [
        ("dependencies", ["npm", "ci"]),
        ("core-dependencies", ["npm", "ci", "--prefix", "runner/agent-core"]),
        ("env-dependencies", ["npm", "ci", "--prefix", "runner/env-server"]),
        ("relay-dependencies", ["npm", "ci", "--prefix", "relay"]),
        ("exec-sandbox-image", ["docker", "build", "-t", "juno-exec:dev", "deploy/exec-host/image"]),
        ("shared-gates", ["bash", "scripts/local-gates.sh"]),
        ("native-contract", ["npm", "run", "native:contract:check"]),
        ("native-icons", ["npm", "run", "native:icons:check"]),
        ("design-contract", ["npm", "run", "design:contract:check"]),
        ("design-editor", ["npm", "run", "design:editor:check"]),
        ("native-design", ["npm", "run", "native:design:check"]),
        ("task-wire", ["npm", "run", "code:task-wire:check"]),
        ("env-bundle", ["npm", "run", "env-server:bundle:mac"]),
        ("web-build", ["npm", "run", "build"]),
    ]
    for package in PACKAGES:
        steps.append((f"swift-{package}", ["python3", "scripts/run-swift-package-tests.py", "--package", package]))
    common = ["SWIFT_TREAT_WARNINGS_AS_ERRORS=YES", "CODE_SIGNING_ALLOWED=NO", f"JUNO_GIT_SHA={sha}"]
    for configuration, destination, directory in (
        ("Debug", "platform=macOS", "mac-debug"),
        ("Stable", "generic/platform=macOS", "mac-stable"),
    ):
        args = ["xcodebuild", "-project", "native/macOS/JunoDesktop/JunoDesktop.xcodeproj", "-scheme", "JunoDesktop",
                "-configuration", configuration, "-destination", destination,
                "-derivedDataPath", str(output / directory), *common]
        steps.append((f"mac-{configuration.lower()}-build", [*args, "build"]))
        if configuration == "Debug":
            steps.append(("mac-tests", [*args, "-only-testing:JunoDesktopTests", "test"]))
    ios = ["xcodebuild", "-project", "native/iOS/JunoMobile/JunoMobile.xcodeproj", "-scheme", "JunoMobile",
           "-configuration", "Debug", "-derivedDataPath", str(output / "ios"),
           "SWIFT_COMPILATION_MODE=wholemodule", *common]
    steps.append(("ios-simulator-build", [*ios, "-destination", "generic/platform=iOS Simulator", "build"]))
    steps.append(("ios-tests", [*ios, "-destination", f"platform=iOS Simulator,id={simulator}", "-only-testing:JunoMobileTests", "test"]))
    return steps


def run_steps(root: Path, output: Path, manifest: dict, steps: list[tuple[str, list[str]]], environment: dict) -> None:
    for name, command in steps:
        require_source(root, manifest["sourceSHA"])
        print(f"Running {name}; log: {output / (name + '.log')}", flush=True)
        start = time.monotonic()
        with (output / (name + ".log")).open("wb") as log:
            result = subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT)
        manifest["checks"].append({"name": name, "command": command, "exitCode": result.returncode,
                                  "durationSeconds": round(time.monotonic() - start, 2), "log": name + ".log"})
        save(output, manifest)
        if result.returncode:
            raise RuntimeError(f"Required check failed: {name} (exit {result.returncode}); see its log")
        require_source(root, manifest["sourceSHA"])


def save(output: Path, manifest: dict) -> None:
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def seal(output: Path, manifest: dict, steps: list[tuple[str, list[str]]]) -> None:
    if [check["name"] for check in manifest["checks"]] != [name for name, _ in steps] or any(
        check["exitCode"] for check in manifest["checks"]
    ):
        raise RuntimeError("Cannot certify incomplete or failed checks")
    if not manifest.get("artifacts"):
        raise RuntimeError("Cannot certify without artifact checksums")
    manifest["status"] = "verified-development"
    manifest["finishedAt"] = datetime.now(timezone.utc).isoformat()
    for check in manifest["checks"]:
        check["logSHA256"] = digest(output / check["log"])
    save(output, manifest)
    (output / "manifest.sha256").write_text(digest(output / "manifest.json") + "  manifest.json\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory outside the repository")
    parser.add_argument("--plan", action="store_true", help="Print planned checks; does not verify a candidate")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        parser.error("Evidence and derived data must be outside the repository")
    sha = require_source(ROOT)
    if args.plan:
        print(json.dumps({"status": "planned-not-verified", "sourceSHA": sha,
                          "checks": commands(output, sha, "AVAILABLE_SIMULATOR_UDID")}, indent=2))
        return 0
    # Never load a real deployment's credentials or let Next consume its .env.
    if any(file.is_file() and not file.name.endswith((".example", ".sample")) for file in ROOT.glob(".env*")):
        raise RuntimeError("Use a clean checkout without .env files for development release verification")
    allowed = ("PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR", "SDKROOT")
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment.update({"PYTHONDONTWRITEBYTECODE": "1", "NEXT_TELEMETRY_DISABLED": "1", "RUNNER_TEMP": str(output / "swift")})
    # Pin the checked local context for every subprocess; never exercise a
    # production or remote Docker daemon through an inherited default context.
    docker_context = subprocess.check_output(["docker", "context", "show"], text=True, env=environment).strip()
    endpoint = json.loads(subprocess.check_output(["docker", "context", "inspect", docker_context], env=environment))[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Use a local Unix-socket Docker daemon for disposable sandbox tests")
    environment.update({"DOCKER_CONTEXT": docker_context, "JUNO_EXEC_DOCKER_TESTS": "1"})
    subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], env=environment, check=True, stdout=subprocess.DEVNULL)
    if subprocess.check_output(["node", "--version"], text=True, env=environment).strip().split(".")[0] != "v24":
        raise RuntimeError("Use Node 24, the repository's CI runtime")
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"], env=environment))
    simulator = next((device["udid"] for runtime, group in sorted(devices["devices"].items()) if "iOS" in runtime
                      for device in group if ".iPhone-" in device.get("deviceTypeIdentifier", "")), None)
    if not simulator:
        raise RuntimeError("An available iPhone simulator is required; no simulator test is silently skipped")
    output.mkdir(parents=True, exist_ok=False)
    (output / "swift").mkdir()
    manifest = {"formatVersion": 1, "status": "running", "sourceSHA": sha,
                "startedAt": datetime.now(timezone.utc).isoformat(), "checks": [], "artifacts": [],
                "distribution": "private-unsigned-development", "physicalDeviceAcceptance": "not-tested",
                "notarized": False, "productionVerified": False,
                "toolchain": {tool: subprocess.check_output(command, text=True, env=environment).strip()
                              for tool, command in {"node": ["node", "--version"], "xcode": ["xcodebuild", "-version"], "swift": ["swift", "--version"]}.items()}}
    save(output, manifest)
    steps = commands(output, sha, simulator)
    try:
        run_steps(ROOT, output, manifest, steps, environment)
        for name, relative in (("mac-debug", "mac-debug/Build/Products/Debug/JunoDesktop.app"),
                               ("mac-stable", "mac-stable/Build/Products/Stable/Alevr.app"),
                               ("ios-simulator", "ios/Build/Products/Debug-iphonesimulator/JunoMobile.app")):
            bundle = output / relative
            require_bundle_source(bundle, sha)
            archive = output / (name + ".zip")
            subprocess.run(["ditto", "-c", "-k", "--keepParent", str(bundle), str(archive)], check=True, env=environment)
            manifest["artifacts"].append({"file": archive.name, "sha256": digest(archive), "sourceSHA": sha})
        archive = output / "web-build.tar.gz"
        with tarfile.open(archive, "w:gz") as target:
            for file in sorted((ROOT / ".next").iterdir()):
                if file.name not in ("cache", "trace", "dev"):
                    target.add(file, arcname=".next/" + file.name)
            for name in ("package.json", "package-lock.json", "public"):
                if (ROOT / name).exists():
                    target.add(ROOT / name, arcname=name)
        manifest["artifacts"].append({"file": archive.name, "sha256": digest(archive), "sourceSHA": sha})
        require_source(ROOT, sha)
        seal(output, manifest, steps)
        print(f"Verified private development candidate: {output / 'manifest.json'}")
        return 0
    except Exception as error:
        manifest.update({"status": "failed", "error": str(error), "finishedAt": datetime.now(timezone.utc).isoformat()})
        save(output, manifest)
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
