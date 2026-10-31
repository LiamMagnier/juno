#!/usr/bin/env python3
"""Capture the native apps' real surfaces for `.github/workflows/native-snapshots.yml`.

Both apps have a DEBUG-only preview harness (`--juno-ui-preview`) that renders
the production screens over a throwaway fixture world with no network and no
account. This drives it, one relaunch per picture, light and dark:

  macos  Launches the Debug `.app` executable once per surface with
         `--juno-preview-snapshot <png>`. The app photographs its own window
         from the window server's composite (Liquid Glass included, no Screen
         Recording permission) and quits (DesktopPreviewSnapshot.swift).

  ios    Launches the Debug simulator build once per surface with the same
         harness flags, waits for it to settle, and takes
         `xcrun simctl io <udid> screenshot`. Each picture is checked against
         a photo of the home screen taken before the first launch, and the
         app's process must still be alive: a capture of the springboard is
         `not-foreground` and one whose app died is `app-exited`, never `ok`.

A capture that fails is recorded and the run moves on; nothing aborts the rest.
Each mode writes `manifest.json` and `MANIFEST.md` into its output directory
and prints the manifest. The exit status is 0 whenever at least one picture
was taken, so the workflow still publishes a partial set.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

# A PNG this small at these sizes is almost certainly one flat colour.
SUSPECT_BLANK_BYTES = 15_000
# Mean per-channel difference (0-255) between thumbnails below which a
# capture is taken to be the home screen it was compared with. The status bar
# is pinned, so the springboard repeats to the byte; any app screen is far off.
SPRINGBOARD_DIFF = 4.0


@dataclass
class Surface:
    name: str
    args: list[str]
    note: str = ""
    # macOS: seconds before the harness takes the picture.
    delay: float = 7.0
    # macOS: another of the app's windows, by title (Settings).
    window: str | None = None
    # iOS: seconds to wait after launch before the screenshot.
    settle: float = 6.0


@dataclass
class Result:
    platform: str
    surface: str
    appearance: str
    file: str
    status: str
    note: str = ""
    width: int = 0
    height: int = 0
    bytes: int = 0
    seconds: float = 0.0
    args: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# macOS surfaces. Every flag here is read by the DEBUG harness:
# PreviewShell.swift, JunoDesktopPreviewRoot.swift, DesktopChatWorkspace.swift,
# DesktopPreviewOverlay.swift, DesktopPreviewSnapshot.swift.
# ---------------------------------------------------------------------------
LAUNCH_PLAN_PROMPT = "Draft a launch plan for the new pricing page, with owners, dates and the risks"

MAC_SURFACES: list[Surface] = [
    # Chat: the home, a populated thread, the composer's states.
    Surface("chat-home", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft"], "New chat: greeting + empty composer"),
    Surface("chat-thread", ["--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-1"], "Pinned thread, scrolled to the latest turn"),
    Surface("chat-thread-top", ["--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-1", "--juno-preview-scroll-top"], "Same thread from its first turn", delay=8),
    Surface("chat-thread-deliverables", ["--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-deliverables"], "Thread that made a sheet, a doc and a deck"),
    Surface("chat-thread-project", ["--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-proj"], "Project-linked thread"),
    Surface("chat-thread-research", ["--juno-preview-scenario", "showcase", "--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-research"], "Showcase research thread"),
    Surface("chat-showcase", ["--juno-preview-scenario", "showcase", "--juno-preview-tab", "chat"], "Showcase account, default thread"),
    Surface("chat-streaming-thinking", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-send", "Which heat pump suits a 1930s semi?", "--juno-preview-stream-hold", "thinking"], "Turn sent, held on the thinking row", delay=8),
    Surface("chat-streaming", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-send", "Which heat pump suits a 1930s semi?"], "Turn sent, answer streaming", delay=9),
    Surface("chat-private", ["--juno-preview-tab", "chat", "--juno-preview-private"], "Private chat draft"),
    Surface("chat-empty-account", ["--juno-preview-scenario", "empty", "--juno-preview-tab", "chat"], "Account with no chats"),
    Surface("chat-offline", ["--juno-preview-scenario", "offline", "--juno-preview-tab", "chat"], "Offline posture"),
    Surface("composer-typing", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-seed", LAUNCH_PLAN_PROMPT], "Draft typed, unsent"),
    Surface("composer-attachments", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-attach", "--juno-preview-seed", "Summarise these for Monday's review"], "Draft with a CSV and a picture attached", delay=8),
    Surface("composer-plus-menu", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-press", "juno.desktop.chat.add"], "Composer + menu open", delay=9),
    Surface("composer-model-popover", ["--juno-preview-tab", "chat", "--juno-preview-chat-draft", "--juno-preview-overlay", "popover"], "Model popover from the composer chip", delay=9),
    Surface("model-selector", ["--juno-preview-model-selector"], "The model selector on its own"),
    Surface("sidebar-more-menu", ["--juno-preview-tab", "chat", "--juno-preview-press", "juno.desktop.sidebar.more"], "Sidebar More menu open", delay=9),
    Surface("account-menu", ["--juno-preview-tab", "chat", "--juno-preview-press", "juno.desktop.account-menu"], "Sidebar account menu open", delay=9),
    Surface("chat-artifact-canvas", ["--juno-preview-tab", "chat", "--juno-preview-conversation", "conv-deliverables", "--juno-preview-artifact", "art-doc"], "Document artifact open beside the thread", delay=8),
    Surface("chat-report-panel", ["--juno-preview-tab", "chat", "--juno-preview-report-panel"], "Research report in the trailing panel", delay=8),
    Surface("chat-file-panel", ["--juno-preview-tab", "chat", "--juno-preview-file"], "CSV file preview panel", delay=8),
    # The navigation column's destinations.
    Surface("activity", ["--juno-preview-tab", "activity"]),
    Surface("projects", ["--juno-preview-tab", "projects"]),
    Surface("project-detail", ["--juno-preview-tab", "projects", "--juno-preview-project", "proj-1"], "Astro research project page"),
    Surface("library", ["--juno-preview-tab", "library"]),
    Surface("artifacts", ["--juno-preview-tab", "artifacts"]),
    Surface("artifact-open", ["--juno-preview-tab", "artifacts", "--juno-preview-artifact", "art-sheet"], "Spreadsheet artifact open", delay=8),
    Surface("agents", ["--juno-preview-tab", "agents"]),
    Surface("connections", ["--juno-preview-tab", "connections"]),
    Surface("connections-app-detail", ["--juno-preview-tab", "connections", "--juno-preview-app-detail", "github"], "GitHub app details sheet", delay=8),
    Surface("memory", ["--juno-preview-tab", "memory"]),
    Surface("assistants", ["--juno-preview-tab", "assistants"]),
    Surface("skills", ["--juno-preview-tab", "skills"]),
    Surface("automations", ["--juno-preview-tab", "automations"]),
    Surface("permissions", ["--juno-preview-tab", "permissions"]),
    Surface("profile", ["--juno-preview-tab", "profile"]),
    Surface("instructions", ["--juno-preview-tab", "instructions"]),
    # Code, the other product.
    Surface("code", ["--juno-preview-tab", "code"]),
    Surface("code-session-running", ["--juno-preview-tab", "code", "--juno-preview-code-session", "cd-search"], "A run in flight", delay=8),
    Surface("code-session-approval", ["--juno-preview-tab", "code", "--juno-preview-code-session", "cd-migrate"], "A run waiting on an approval", delay=8),
    Surface("code-session-done", ["--juno-preview-tab", "code", "--juno-preview-code-session", "cd-flake"], "A finished run with a diff", delay=8),
]

# Settings is a window of its own (⌘,): one picture of that window per section.
for _section in ["general", "appearance", "personalization", "models", "voice", "notifications",
                 "account", "billing", "connectors", "data", "code"]:
    MAC_SURFACES.append(Surface(
        f"settings-{_section}",
        ["--juno-preview-tab", "settings", "--juno-preview-settings-route", _section],
        f"Settings window, {_section}",
        delay=8,
        window="Settings",
    ))


# ---------------------------------------------------------------------------
# iOS surfaces. Read by JunoMobileRootView.swift, JunoMobileComposer.swift,
# JunoMobileAttachmentMenu.swift, JunoMobileSettingsView.swift, PreviewShell.swift.
# ---------------------------------------------------------------------------
IOS_SURFACES: list[Surface] = [
    Surface("home", ["--juno-preview-chat-draft"], "New chat home"),
    Surface("chat-thread", ["--juno-preview-conversation", "conv-1"], "Pinned thread", settle=7),
    Surface("chat-thread-deliverables", ["--juno-preview-conversation", "conv-deliverables"], "Thread with artifacts", settle=7),
    Surface("chat-thread-project", ["--juno-preview-conversation", "conv-proj"], "Project-linked thread", settle=7),
    Surface("chat-streaming", ["--juno-preview-chat-draft", "--juno-preview-send", "Which heat pump suits a 1930s semi?"], "Turn sent, answer streaming", settle=8),
    Surface("composer-typing", ["--juno-preview-chat-draft", "--juno-preview-prompt", LAUNCH_PLAN_PROMPT], "Draft typed, unsent"),
    Surface("composer-attachments", ["--juno-preview-chat-draft", "--juno-preview-attach", "--juno-preview-prompt", "Summarise these for Monday's review"], "Draft with a picture and a CSV attached", settle=7),
    Surface("composer-keyboard", ["--juno-preview-chat-draft", "--juno-preview-keyboard", "--juno-preview-prompt", "Plan the offsite"], "Composer focused with the keyboard", settle=7),
    Surface("composer-plus-menu", ["--juno-preview-chat-draft", "--juno-preview-plus"], "Composer + menu open", settle=7),
    Surface("composer-model-selector", ["--juno-preview-chat-draft", "--juno-preview-model-selector"], "Model selector from the composer", settle=7),
    Surface("composer-thinking", ["--juno-preview-chat-draft", "--juno-preview-model", "anthropic:claude-sonnet-4-6", "--juno-preview-thinking"], "Thinking level popover", settle=7),
    Surface("incognito", ["--juno-preview-incognito"], "Incognito chat"),
    Surface("drawer", ["--juno-preview-sidebar"], "Sidebar drawer open", settle=7),
    Surface("drawer-search", ["--juno-preview-sidebar", "--juno-preview-sidebar-search", "plan"], "Drawer searching for \"plan\"", settle=7),
    Surface("settings", ["--juno-preview-settings"], "Settings sheet", settle=7),
    Surface("settings-appearance", ["--juno-preview-settings", "--juno-preview-settings-route", "appearance"], settle=7),
    Surface("settings-models", ["--juno-preview-settings", "--juno-preview-settings-route", "models"], settle=7),
    Surface("settings-personalization", ["--juno-preview-settings", "--juno-preview-settings-route", "personalization"], settle=7),
    Surface("settings-account", ["--juno-preview-settings", "--juno-preview-settings-route", "account"], settle=7),
    Surface("settings-usage", ["--juno-preview-settings", "--juno-preview-settings-route", "usage"], settle=7),
    Surface("research-report", ["--juno-preview-report"], "Research report reader", settle=7),
    Surface("search", ["--juno-preview-tab", "search"]),
    Surface("activity", ["--juno-preview-tab", "activity"]),
    Surface("projects", ["--juno-preview-tab", "projects"]),
    Surface("library", ["--juno-preview-tab", "library"]),
    Surface("artifacts", ["--juno-preview-tab", "artifacts"]),
    Surface("agents", ["--juno-preview-tab", "agents"]),
    Surface("connections", ["--juno-preview-tab", "connections"]),
    Surface("tasks", ["--juno-preview-tab", "tasks"]),
    Surface("work", ["--juno-preview-tab", "work"]),
    Surface("code", ["--juno-preview-tab", "code"]),
    Surface("signed-out", ["--juno-preview-signed-out"], "Signed out: the welcome"),
    Surface("signed-out-form", ["--juno-preview-signed-out", "--juno-skip-welcome"], "Signed out: the sign-in form"),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        head = handle.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    width, height = struct.unpack(">II", head[16:24])
    return (width, height)


def judge(path: Path, result: Result) -> None:
    if not path.exists() or path.stat().st_size == 0:
        result.status = "missing"
        return
    result.bytes = path.stat().st_size
    result.width, result.height = png_size(path)
    if result.width == 0:
        result.status = "not-png"
    elif result.bytes < SUSPECT_BLANK_BYTES:
        result.status = "suspect-blank"
    else:
        result.status = "ok"


def decode_png_rgb(data: bytes) -> tuple[int, int, bytes] | None:
    """(width, height, RGB bytes) of a small non-interlaced 8- or 16-bit PNG."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    position, header, chunks = 8, None, []
    while position + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[position:position + 8])
        body = data[position + 8:position + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            chunks.append(body)
        elif kind == b"IEND":
            break
        position += 12 + length
    if not header:
        return None
    width, height, depth, colour, _, _, interlace = header
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(colour)
    if channels is None or depth not in (8, 16) or interlace:
        return None
    step = depth // 8
    bpp = channels * step
    stride = width * bpp
    raw = zlib.decompress(b"".join(chunks))
    previous = bytearray(stride)
    rgb = bytearray()
    for row in range(height):
        start = row * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            left = line[i - bpp] if i >= bpp else 0
            up = previous[i]
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + ((left + up) >> 1)) & 0xFF
            elif kind == 4:
                corner = previous[i - bpp] if i >= bpp else 0
                guess = left + up - corner
                pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        previous = line
        for x in range(width):
            pixel = line[x * bpp:(x + 1) * bpp:step]
            rgb += pixel[:3] if channels >= 3 else bytes([pixel[0]] * 3)
    return width, height, bytes(rgb)


def thumbnail(path: Path) -> tuple[int, int, bytes] | None:
    """The picture shrunk by `sips` to 48 px on its long side, as RGB."""
    small = path.with_name(path.stem + ".thumb.png")
    try:
        shrink = run(["sips", "-Z", "48", "-s", "format", "png", str(path), "--out", str(small)], timeout=30)
        if shrink.returncode != 0 or not small.exists():
            return None
        return decode_png_rgb(small.read_bytes())
    except Exception:  # A thumbnail is a check, never a reason to stop.
        return None
    finally:
        small.unlink(missing_ok=True)


def difference(a: tuple[int, int, bytes] | None, b: tuple[int, int, bytes] | None) -> float | None:
    """Mean per-channel difference of two thumbnails, or None if incomparable."""
    if not a or not b or a[:2] != b[:2] or not a[2]:
        return None
    return sum(abs(x - y) for x, y in zip(a[2], b[2])) / len(a[2])


def log(message: str) -> None:
    print(message, flush=True)


def run(cmd: list[str], timeout: float = 60, check: bool = False) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=check)
    except subprocess.TimeoutExpired as error:
        return subprocess.CompletedProcess(cmd, 124, error.stdout or "", (error.stderr or "") + "\n[timeout]")


def selected(surfaces: list[Surface], only: str | None) -> list[Surface]:
    if not only:
        return surfaces
    wanted = {name.strip() for name in only.split(",") if name.strip()}
    return [surface for surface in surfaces if surface.name in wanted]


def write_manifest(out: Path, platform: str, results: list[Result], extra: dict) -> None:
    payload = {"platform": platform, **extra, "captures": [result.__dict__ for result in results]}
    (out / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    lines = [f"# {platform} captures", ""]
    for key, value in extra.items():
        lines.append(f"- **{key}**: {value}")
    ok = sum(1 for result in results if result.status == "ok")
    lines += ["", f"{ok} of {len(results)} captures ok.", "",
              "| file | status | size | note |", "|---|---|---|---|"]
    for result in results:
        size = f"{result.width}x{result.height}" if result.width else "-"
        note = result.note.replace("|", "/").replace("\n", " ")
        lines.append(f"| {result.file} | {result.status} | {size} | {note} |")
    (out / "MANIFEST.md").write_text("\n".join(lines) + "\n")
    log("\n".join(lines))


# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------
def kill_mac_app(executable: Path) -> None:
    run(["pkill", "-9", "-f", str(executable)], timeout=10)


def set_mac_system_appearance(appearance: str) -> None:
    # The harness pins its own windows; the system setting only keeps the
    # menus and sheets AppKit draws for it on the same side.
    if appearance == "dark":
        run(["defaults", "write", "-g", "AppleInterfaceStyle", "Dark"])
    else:
        run(["defaults", "delete", "-g", "AppleInterfaceStyle"])


def capture_mac(args: argparse.Namespace) -> int:
    app = Path(args.app)
    executable = app / "Contents" / "MacOS" / app.stem
    if not executable.exists():
        candidates = list((app / "Contents" / "MacOS").glob("*"))
        if not candidates:
            log(f"::error::No executable inside {app}")
            return 2
        executable = candidates[0]
    out = Path(args.out)
    logs = Path(args.logs)
    out.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    surfaces = selected(MAC_SURFACES, args.only)
    results: list[Result] = []
    log(f"Capturing {len(surfaces)} macOS surfaces x {args.appearances} at {args.size} with {executable}")

    for appearance in args.appearances.split(","):
        set_mac_system_appearance(appearance)
        for surface in surfaces:
            name = f"{surface.name}-{appearance}.png"
            target = out / name
            target.unlink(missing_ok=True)
            flags = [
                "--juno-ui-preview",
                "--juno-preview-appearance", appearance,
                "--juno-preview-size", args.size,
                *surface.args,
                "--juno-preview-snapshot", str(target),
                "--juno-preview-snapshot-delay", str(surface.delay),
            ]
            if surface.window:
                flags += ["--juno-preview-snapshot-window", surface.window]
            # Never restore windows from a previous (killed) launch.
            flags += ["-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO"]
            result = Result("macos", surface.name, appearance, name, "pending", surface.note, args=surface.args)
            kill_mac_app(executable)
            started = time.monotonic()
            stdout_path = logs / f"{surface.name}-{appearance}.log"
            with stdout_path.open("w") as sink:
                process = subprocess.Popen([str(executable), *flags], stdout=sink, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                deadline = started + surface.delay + args.grace
                while process.poll() is None and time.monotonic() < deadline:
                    # Done as soon as the picture is on disk and the app quit,
                    # or a beat after the picture lands if it does not quit.
                    if target.exists() and time.monotonic() - started > surface.delay + 1.5:
                        time.sleep(0.5)
                        break
                    time.sleep(0.25)
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=10)
            result.seconds = round(time.monotonic() - started, 1)
            judge(target, result)
            # The harness's own notes: a press it made, the windows it saw.
            for suffix in (".press.txt", ".windows.txt"):
                side = Path(str(target) + suffix)
                if side.exists():
                    text = side.read_text(errors="replace").strip()
                    # The press note lists the identifiers it saw when it
                    # missed; the manifest is the only place that reaches git.
                    result.note = f"{result.note} [{suffix[1:-4]}: {text[:1200]}]".strip()
                    shutil.move(str(side), logs / side.name)
            if result.status != "ok":
                tail = stdout_path.read_text(errors="replace").strip().splitlines()[-5:]
                if tail:
                    result.note = f"{result.note} [log: {' / '.join(tail)[:400]}]".strip()
            log(f"  {result.status:13} {name} ({result.width}x{result.height}, {result.bytes} B, {result.seconds}s)")
            results.append(result)
    kill_mac_app(executable)
    set_mac_system_appearance("light")

    sw = run(["sw_vers"]).stdout.strip().replace("\n", "; ")
    xcode = run(["xcodebuild", "-version"]).stdout.strip().replace("\n", " ")
    write_manifest(out, "macOS", results, {
        "app": app.name, "window size": args.size, "macOS": sw, "Xcode": xcode,
        "commit": os.environ.get("GITHUB_SHA", "local"),
    })
    return 0 if any(result.status == "ok" for result in results) else 1


# ---------------------------------------------------------------------------
# iOS
# ---------------------------------------------------------------------------
def pick_iphone() -> tuple[str, str, str]:
    """(udid, name, runtime) of the newest iPhone 17-class simulator available."""
    listing = json.loads(run(["xcrun", "simctl", "list", "devices", "available", "--json"]).stdout)
    devices = []
    for runtime, entries in listing.get("devices", {}).items():
        if "iOS" not in runtime:
            continue
        version = tuple(int(part) for part in runtime.rsplit("iOS-", 1)[-1].split("-") if part.isdigit())
        for entry in entries:
            if entry.get("name", "").startswith("iPhone"):
                devices.append((version, entry["name"], entry["udid"], runtime))
    if not devices:
        raise SystemExit("No iPhone simulator available")

    def rank(device):
        version, name, _, _ = device
        preference = ["iPhone 17 Pro", "iPhone 17", "iPhone 17 Pro Max", "iPhone Air", "iPhone 16 Pro"]
        index = next((i for i, prefix in enumerate(preference) if name == prefix), len(preference))
        return (version, -index)

    version, name, udid, runtime = max(devices, key=rank)
    return udid, name, runtime


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def ios_app_alive(udid: str, bundle: str, pid: int | None) -> bool:
    """Whether the app launched for this picture is still running.

    A simulator app is a process on the host, so its pid answers first; the
    simulator's own launchd confirms a pid that has gone.
    """
    if pid:
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except ProcessLookupError:
            pass
    listing = run(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], timeout=30).stdout
    for line in listing.splitlines():
        fields = line.split("\t")
        if len(fields) == 3 and fields[2].startswith(f"UIKitApplication:{bundle}[") and fields[0].isdigit():
            return True
    return False


def ios_screenshot(udid: str, target: Path) -> str:
    target.unlink(missing_ok=True)
    shot = run(["xcrun", "simctl", "io", udid, "screenshot", "--type=png", str(target)], timeout=60)
    return "" if shot.returncode == 0 else shot.stderr.strip()[:300]


def ios_os_log(udid: str, process: str, path: Path, seconds: int) -> None:
    """The simulator's unified log for the app (and what launched or killed it)."""
    shown = run(["xcrun", "simctl", "spawn", udid, "log", "show", "--last", f"{seconds}s", "--style", "compact",
                 "--predicate", f'process == "{process}" OR eventMessage CONTAINS "{process}"'], timeout=120)
    path.write_text(shown.stdout[-400_000:] + shown.stderr[-20_000:])


def capture_ios(args: argparse.Namespace) -> int:
    udid = args.udid
    out = Path(args.out)
    logs = Path(args.logs)
    out.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    bundle = args.bundle_id
    process = args.process_name
    surfaces = selected(IOS_SURFACES, args.only)
    appearances = args.appearances.split(",")
    results: list[Result] = []
    run_started = time.time()
    log(f"Capturing {len(surfaces)} iOS surfaces x {args.appearances} of {bundle} on {udid}")
    run(["xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi",
         "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4",
         "--batteryState", "charged", "--batteryLevel", "100"])

    def bad(result: Result) -> bool:
        return result.status != "ok"

    given_up = False
    for appearance in appearances:
        if given_up:
            break
        run(["xcrun", "simctl", "ui", udid, "appearance", appearance])
        # What the screen shows with no app in front: every picture is checked
        # against it, so the home screen can never pass for a capture.
        run(["xcrun", "simctl", "terminate", udid, bundle], timeout=20)
        time.sleep(3)
        home_path = logs / f"springboard-{appearance}.png"
        error = ios_screenshot(udid, home_path)
        home = thumbnail(home_path)
        home_sha = sha256(home_path)
        log(f"  home screen reference ({appearance}): {home_path.name}"
            f"{' thumbnail ok' if home else ' no thumbnail'}{' ' + error if error else ''}")

        for surface in surfaces:
            name = f"{surface.name}-{appearance}.png"
            target = out / name
            target.unlink(missing_ok=True)
            result = Result("ios", surface.name, appearance, name, "pending", surface.note, args=surface.args)
            started = time.monotonic()
            stem = f"{surface.name}-{appearance}"
            run(["xcrun", "simctl", "terminate", udid, bundle], timeout=20)
            launch = run(["xcrun", "simctl", "launch", "--terminate-running-process",
                          f"--stdout={logs / (stem + '.stdout.log')}", f"--stderr={logs / (stem + '.stderr.log')}",
                          udid, bundle, "--juno-ui-preview", "--juno-preview-appearance", appearance,
                          *surface.args], timeout=60)
            (logs / f"{stem}.launch.log").write_text(launch.stdout + launch.stderr)
            match = re.search(r":\s*(\d+)\s*$", launch.stdout.strip())
            pid = int(match.group(1)) if match else None
            if launch.returncode != 0:
                result.status = "launch-failed"
                result.note = f"{result.note} [launch: {(launch.stderr or launch.stdout).strip()[:300]}]".strip()
            else:
                time.sleep(surface.settle)
                error = ios_screenshot(udid, target)
                judge(target, result)
                gap = difference(thumbnail(target), home) if result.status == "ok" else None
                # Still on the home screen: give a slow first frame a little
                # longer while the process lives, then call it what it is.
                waited = 0.0
                while (result.status == "ok" and (gap is not None and gap < SPRINGBOARD_DIFF
                                                  or sha256(target) == home_sha)
                       and waited < args.first_frame_wait and ios_app_alive(udid, bundle, pid)):
                    time.sleep(2)
                    waited += 2
                    error = ios_screenshot(udid, target)
                    judge(target, result)
                    gap = difference(thumbnail(target), home) if result.status == "ok" else None
                if error:
                    result.note = f"{result.note} [screenshot: {error}]".strip()
                if result.status == "ok" and (gap is not None and gap < SPRINGBOARD_DIFF
                                              or sha256(target) == home_sha):
                    result.status = "not-foreground"
                    result.note = f"{result.note} [the home screen, not the app; diff {gap}]".strip()
                if not ios_app_alive(udid, bundle, pid):
                    result.status = "app-exited" if result.status in ("ok", "not-foreground") else result.status
                    result.note = f"{result.note} [pid {pid} gone]".strip()
            if bad(result):
                ios_os_log(udid, process, logs / f"{stem}.oslog.txt", seconds=int(time.monotonic() - started) + 15)
                tail = (logs / f"{stem}.stderr.log")
                if tail.exists():
                    lines = tail.read_text(errors="replace").strip().splitlines()[-3:]
                    if lines:
                        result.note = f"{result.note} [stderr: {' / '.join(lines)[:300]}]".strip()
            result.seconds = round(time.monotonic() - started, 1)
            log(f"  {result.status:14} {name} ({result.width}x{result.height}, {result.bytes} B, {result.seconds}s)")
            results.append(result)
            # A launch path that is broken is broken for every surface: stop
            # after the first few rather than spend the job proving it.
            if len(results) == args.give_up_after and all(bad(r) for r in results):
                log(f"::error::The first {len(results)} iOS captures all failed; skipping the rest.")
                given_up = True
                break
    run(["xcrun", "simctl", "terminate", udid, bundle], timeout=20)

    if given_up:
        done = {(r.surface, r.appearance) for r in results}
        for appearance in appearances:
            for surface in surfaces:
                if (surface.name, appearance) not in done:
                    results.append(Result("ios", surface.name, appearance, f"{surface.name}-{appearance}.png",
                                          "skipped", surface.note, args=surface.args))

    # The app's crash reports, written on the host for simulator processes.
    reports = Path.home() / "Library" / "Logs" / "DiagnosticReports"
    if reports.is_dir():
        for report in reports.iterdir():
            if process in report.name and report.stat().st_mtime >= run_started:
                (logs / "crash-reports").mkdir(exist_ok=True)
                shutil.copy2(report, logs / "crash-reports" / report.name)

    # Two surfaces that drew the same picture: one of them did not take.
    seen: dict[str, str] = {}
    for result in results:
        digest = sha256(out / result.file) if result.status == "ok" else ""
        if digest and digest in seen:
            result.note = f"{result.note} [identical to {seen[digest]}]".strip()
        elif digest:
            seen[digest] = result.file

    write_manifest(out, "iOS", results, {
        "device": args.device_name or udid, "runtime": args.runtime or "?", "app": bundle,
        "commit": os.environ.get("GITHUB_SHA", "local"),
    })
    ok = sum(1 for result in results if result.status == "ok")
    if ok == 0:
        log("::error::No iOS capture shows the app (see the capture logs artifact).")
    elif ok < len(results):
        log(f"::warning::{len(results) - ok} of {len(results)} iOS captures are not ok (see MANIFEST.md).")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)

    mac = sub.add_parser("macos", help="capture the Debug macOS app")
    mac.add_argument("--app", required=True, help="path to the Debug .app")
    mac.add_argument("--out", required=True)
    mac.add_argument("--logs", required=True)
    mac.add_argument("--size", default="1440x900")
    mac.add_argument("--appearances", default="light,dark")
    mac.add_argument("--grace", type=float, default=20, help="seconds past the snapshot delay before a launch is killed")
    mac.add_argument("--only", help="comma-separated surface names")

    ios = sub.add_parser("ios", help="capture the Debug iOS app in a booted simulator")
    ios.add_argument("--udid", required=True)
    ios.add_argument("--bundle-id", default="com.liammagnier.JunoMobile.debug")
    ios.add_argument("--out", required=True)
    ios.add_argument("--logs", required=True)
    ios.add_argument("--appearances", default="light,dark")
    ios.add_argument("--device-name")
    ios.add_argument("--runtime")
    ios.add_argument("--only", help="comma-separated surface names")
    ios.add_argument("--process-name", default="JunoMobile", help="the app's executable, for its logs")
    ios.add_argument("--first-frame-wait", type=float, default=10,
                     help="extra seconds a capture still showing the home screen may wait for the app")
    ios.add_argument("--give-up-after", type=int, default=4,
                     help="stop when this many first captures all fail")

    pick = sub.add_parser("pick-iphone", help="print 'udid<TAB>name<TAB>runtime' of the simulator to use")

    args = parser.parse_args()
    if args.mode == "macos":
        return capture_mac(args)
    if args.mode == "ios":
        return capture_ios(args)
    if args.mode == "pick-iphone":
        print("\t".join(pick_iphone()))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
