#!/usr/bin/python3
"""juno-exec: Alevr's hosted code-execution service (Python standard library only).

Runs model-written Python, JavaScript (Node) and shell programs, each in a fresh
container with no network, a read-only root, no capabilities, a non-root uid and
hard limits, sharing one workspace per session (a chat generation or a Work run).
It never touches Docker itself: every container operation goes through the root
broker (juno-exec-docker-broker.py), which pins the image, the flags and the mounts.

The host holds no database URL, no provider key and no user identity: sessions and
accounts are opaque hashes chosen by the web side. Requests carry
`Authorization: Bearer <token>`; nginx terminates TLS and the firewall admits the
API port only from the web VM. Design: docs/rework/TOOL_RUNTIME_DESIGN.md §6.3.

API v1 (JSON unless noted):
  GET    /v1/health                         liveness, image, egress "none", load
  GET    /v1/manifest                       runtimes and installed packages
  PUT    /v1/sessions/{s}/inputs/{name}     stream one input file (raw body)
  PUT    /v1/sessions/{s}/skills/{slug}     stream a skill bundle (tar); read-only
  DELETE /v1/sessions/{s}                   drop the workspace
  POST   /v1/runs                           start a run (Idempotency-Key required)
  GET    /v1/runs/{id}?wait=N               status, long-polled up to 25 s
  GET    /v1/runs/{id}/events?after=SEQ     server-sent stdout/stderr chunks
  GET    /v1/runs/{id}/output?stream=&offset=&limit=   paged full output (text)
  GET    /v1/runs/{id}/files                manifest of produced files
  GET    /v1/runs/{id}/files/{path}         one produced file (raw)
  POST   /v1/runs/{id}/cancel               kill the container; status cancelled
The pre-v1 synchronous POST /execute is gone (410): its only client was retired.
"""
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SESSION = re.compile(r"s_[0-9a-f]{32}\Z")
ACCOUNT = re.compile(r"a_[0-9a-f]{32}\Z")
RUN = re.compile(r"r_[0-9a-f]{24}\Z")
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
INPUT_NAME = re.compile(r"[^/\\\x00-\x1f]{1,200}\Z")
LANGUAGES = {"python": ("main.py", ["python3", "/juno/program/main.py"]),
             "javascript": ("main.js", ["node", "/juno/program/main.js"]),
             "bash": ("main.sh", ["bash", "/juno/program/main.sh"])}
MANIFEST_COMMAND = ["python3", "/opt/juno/manifest.py"]
TERMINAL = {"succeeded", "failed", "timed_out", "cancelled", "lost"}

LIMITS = {
    "maxCodeBytes": 256 * 1024,
    "maxRequestBytes": 1024 * 1024,
    "maxTimeoutMs": 30 * 60 * 1000,
    "minTimeoutMs": 1000,
    "maxLogBytes": 16 * 1024 * 1024,      # per stream, on disk
    "maxEventBytes": 2 * 1024 * 1024,     # per run, in memory for the SSE feed
    "maxFiles": 20,
    "maxFileBytes": 25 * 1024 * 1024,
    "maxFilesTotalBytes": 50 * 1024 * 1024,
    "maxInputBytes": 32 * 1024 * 1024,
    "maxSessionInputBytes": 64 * 1024 * 1024,
    "maxSkillBytes": 5 * 1024 * 1024,
    "maxSkillFiles": 200,
    "maxSkills": 8,
    "perAccountConcurrent": 2,
    "hostConcurrent": 4,
    "hostPending": 64,
    "sessionIdleSeconds": 30 * 60,
    "runRetentionSeconds": 30 * 60,
    "tailBytes": 8 * 1024,
    "walkMaxEntries": 5000,
}


def now():
    return time.time()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class Refused(Exception):
    """A request the API refuses, with an HTTP status and a stable code."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ── Broker transport ─────────────────────────────────────────────────────────


class BrokerCall:
    """One broker invocation: a framed stream of stdout/stderr chunks and an exit code."""

    def __init__(self, transport, argv):
        self.refused = None
        self.exit_code = None
        self._sock = None
        self._proc = None
        request = (json.dumps({"argv": argv}) + "\n").encode()
        if transport["mode"] == "socket":
            self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._sock.connect(transport["path"])
            self._sock.sendall(request)
            self._sock.shutdown(socket.SHUT_WR)
            self._reader = self._sock.makefile("rb")
        else:
            self._proc = subprocess.Popen(transport["argv"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, env=transport.get("env"))
            self._proc.stdin.write(request)
            self._proc.stdin.close()
            self._reader = self._proc.stdout

    def frames(self):
        """Yield (stream, bytes) until the exit frame; sets exit_code or refused."""
        try:
            while True:
                header = self._reader.read(5)
                if len(header) < 5:
                    break
                kind, length = header[:1], struct.unpack(">I", header[1:])[0]
                payload = self._reader.read(length) if length else b""
                if kind in (b"o", b"e"):
                    yield ("stdout" if kind == b"o" else "stderr", payload)
                elif kind == b"x":
                    self.exit_code = int(payload.decode() or "1")
                    break
                elif kind == b"r":
                    self.refused = payload.decode("utf-8", "replace")
                    break
        finally:
            self.close()

    def close(self):
        try:
            self._reader.close()
        except Exception:
            pass
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
        if self._proc:
            try:
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.kill()


def broker_run(transport, argv):
    """Run a short broker command; returns (exit code or None, stdout text, refusal)."""
    call = BrokerCall(transport, argv)
    out = []
    for stream, chunk in call.frames():
        if stream == "stdout":
            out.append(chunk)
    return call.exit_code, b"".join(out).decode("utf-8", "replace"), call.refused


# ── Filesystem helpers that never follow a symlink ───────────────────────────
# The container (a different, unprivileged uid) can write anything into /work,
# including symlinks pointing at host paths. Everything the service reads from a
# workspace goes through these, which open each component with O_NOFOLLOW.


def open_beneath(root, relative):
    """Open `root/relative` for reading without following any symlink. Returns an fd."""
    parts = [part for part in relative.split("/") if part]
    if not parts or any(part in (".", "..") for part in parts):
        raise Refused(400, "bad_path", "Invalid file path")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0), dir_fd=fd)
    finally:
        os.close(fd)
    info = os.fstat(file_fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(file_fd)
        raise Refused(404, "not_a_file", "Not a regular file")
    return file_fd


def walk_regular_files(root, skip_top=("inputs",)):
    """{relative path: (size, mtime_ns, inode)} for regular files under root, never following links."""
    result = {}
    stack = [""]
    seen = 0
    while stack:
        relative = stack.pop()
        directory = os.path.join(root, relative) if relative else root
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > LIMITS["walkMaxEntries"]:
                return result
            path = f"{relative}/{entry.name}" if relative else entry.name
            if not relative and entry.name in skip_top:
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(info.st_mode) and path.count("/") < 8:
                stack.append(path)
            elif stat.S_ISREG(info.st_mode):
                result[path] = (info.st_size, info.st_mtime_ns, info.st_ino)
    return result


def guess_mime(name):
    lower = name.lower()
    for suffix, mime in ((".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"),
                         (".webp", "image/webp"), (".svg", "image/svg+xml"), (".csv", "text/csv"), (".json", "application/json"),
                         (".txt", "text/plain"), (".md", "text/markdown"), (".html", "text/html"), (".pdf", "application/pdf"),
                         (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                         (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                         (".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
                         (".zip", "application/zip"), (".py", "text/x-python"), (".js", "text/javascript")):
        if lower.endswith(suffix):
            return mime
    return "application/octet-stream"


# ── Runs ─────────────────────────────────────────────────────────────────────


class Run:
    def __init__(self, record):
        self.__dict__.update(record)
        self.cond = threading.Condition()
        self.events = []          # (seq, stream, text)
        self.event_bytes = 0
        self.events_truncated = False
        self.cancel_requested = False
        self.timed_out = False
        self.call = None

    def record(self):
        keys = ("id", "session", "account", "language", "codeDigest", "status", "exitCode", "createdAt", "startedAt",
                "finishedAt", "timeoutMs", "stdoutBytes", "stderrBytes", "stdoutTruncated", "stderrTruncated", "files",
                "skippedFiles", "error", "skills", "idempotencyKeyDigest", "bodyDigest", "internal")
        return {key: getattr(self, key, None) for key in keys}


class Service:
    def __init__(self, config):
        self.config = config
        self.data = config["dataRoot"]
        self.sessions_root = os.path.join(self.data, "sessions")
        self.runs_root = os.path.join(self.data, "runs")
        self.idem_root = os.path.join(self.data, "idempotency")
        for path in (self.sessions_root, self.runs_root, self.idem_root):
            os.makedirs(path, mode=0o750, exist_ok=True)
        self.lock = threading.RLock()
        self.runs = {}
        self.account_active = {}
        self.host_active = 0
        self.pending = 0
        self.slot = threading.Condition(self.lock)
        self.manifest = None
        self.manifest_lock = threading.Lock()
        self.started_runs = 0      # how many containers this process started (tests)
        self._load()

    # ── persistence ──
    def _run_dir(self, run_id):
        return os.path.join(self.runs_root, run_id)

    def _persist(self, run):
        directory = self._run_dir(run.id)
        os.makedirs(directory, mode=0o750, exist_ok=True)
        temporary = os.path.join(directory, "run.json.tmp")
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(run.record(), file)
        os.replace(temporary, os.path.join(directory, "run.json"))

    def _load(self):
        """Reload run records; a run that was in flight when the service stopped is `lost`."""
        for run_id in os.listdir(self.runs_root):
            path = os.path.join(self.runs_root, run_id, "run.json")
            if not RUN.fullmatch(run_id) or not os.path.isfile(path):
                continue
            try:
                with open(path, encoding="utf-8") as file:
                    run = Run(json.load(file))
            except (OSError, ValueError):
                continue
            if run.status not in TERMINAL:
                run.status = "lost"
                run.error = "The execution service restarted while this ran; its outcome is unknown."
                run.finishedAt = now()
                self._persist(run)
            self.runs[run.id] = run
        self.reap_orphans()

    def reap_orphans(self):
        """Kill containers left by a previous process (their runs are now `lost`)."""
        try:
            code, out, refused = broker_run(self.config["broker"], ["ps", "-a", "--filter", "label=app=juno-exec", "--format",
                                                                    '{{.Names}}\t{{.Label "juno.session"}}\t{{.State}}'])
        except OSError:
            return
        if code != 0 or refused:
            return
        live = {run.id for run in self.runs.values() if run.status not in TERMINAL}
        for line in out.splitlines():
            name = line.split("\t", 1)[0]
            if name.startswith("juno-exec-") and name[len("juno-exec-"):] not in live:
                try:
                    broker_run(self.config["broker"], ["kill", name])
                    broker_run(self.config["broker"], ["rm", "-f", name])
                except OSError:
                    pass

    # ── sessions ──
    def session_dir(self, session, create=True):
        if not SESSION.fullmatch(session or ""):
            raise Refused(400, "bad_session", "Invalid session id")
        root = os.path.join(self.sessions_root, session)
        if create:
            for sub in ("work", "inputs", "programs", "skills"):
                os.makedirs(os.path.join(root, sub), mode=0o755, exist_ok=True)
            # The mountpoint for the read-only inputs inside the workspace.
            os.makedirs(os.path.join(root, "work", "inputs"), mode=0o755, exist_ok=True)
            self.touch_session(session)
        elif not os.path.isdir(root):
            raise Refused(404, "no_session", "Unknown session")
        return root

    def touch_session(self, session):
        marker = os.path.join(self.sessions_root, session, ".active")
        with open(marker, "w", encoding="utf-8") as file:
            file.write(str(now()))

    def put_input(self, session, name, body, length):
        name = urllib.parse.unquote(name)
        if not INPUT_NAME.fullmatch(name) or name in (".", "..") or name.startswith("."):
            raise Refused(400, "bad_name", "Invalid input file name")
        if length is None or length < 0:
            raise Refused(411, "length_required", "Content-Length is required")
        if length > LIMITS["maxInputBytes"]:
            raise Refused(413, "input_too_large", "Input file exceeds 32 MB")
        root = self.session_dir(session)
        inputs = os.path.join(root, "inputs")
        used = sum(entry.stat(follow_symlinks=False).st_size for entry in os.scandir(inputs) if entry.is_file(follow_symlinks=False) and entry.name != name)
        if used + length > LIMITS["maxSessionInputBytes"]:
            raise Refused(413, "session_inputs_full", "The session's inputs would exceed 64 MB")
        temporary = os.path.join(inputs, ".upload-" + secrets.token_hex(8))
        digest = hashlib.sha256()
        remaining = length
        with open(temporary, "wb") as file:
            while remaining > 0:
                chunk = body.read(min(65536, remaining))
                if not chunk:
                    break
                digest.update(chunk)
                file.write(chunk)
                remaining -= len(chunk)
        if remaining:
            os.unlink(temporary)
            raise Refused(400, "short_body", "The upload ended early")
        os.chmod(temporary, 0o644)
        os.replace(temporary, os.path.join(inputs, name))
        return {"name": name, "bytes": length, "sha256": digest.hexdigest()}

    def put_skill(self, session, slug, body, length, expected_digest):
        if not SLUG.fullmatch(slug or ""):
            raise Refused(400, "bad_slug", "Invalid skill slug")
        if length is None or length > LIMITS["maxSkillBytes"] * 2:
            raise Refused(413, "skill_too_large", "Skill bundle is too large")
        data = body.read(length)
        if len(data) != length:
            raise Refused(400, "short_body", "The upload ended early")
        digest = sha256(data)
        if expected_digest and not hmac.compare_digest(expected_digest, digest):
            raise Refused(400, "digest_mismatch", "The bundle digest does not match")
        root = self.session_dir(session)
        target = os.path.join(root, "skills", slug)
        marker = os.path.join(root, "skills", "." + slug + ".digest")
        if os.path.isdir(target) and os.path.isfile(marker) and open(marker, encoding="utf-8").read() == digest:
            return {"slug": slug, "sha256": digest, "files": None, "reused": True}
        if len([entry for entry in os.listdir(os.path.join(root, "skills")) if not entry.startswith(".")]) >= LIMITS["maxSkills"] and not os.path.isdir(target):
            raise Refused(413, "too_many_skills", "Too many skill bundles in this session")
        staging = os.path.join(root, "skills", ".staging-" + secrets.token_hex(6))
        os.makedirs(staging, mode=0o755)
        files = 0
        total = 0
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                for member in archive.getmembers():
                    name = member.name
                    parts = [part for part in name.split("/") if part not in ("", ".")]
                    if name.startswith("/") or ".." in parts or not parts or "\\" in name or any(ord(c) < 32 for c in name):
                        raise Refused(400, "bad_bundle", "Bundle path is not allowed: " + name[:80])
                    if member.isdir():
                        os.makedirs(os.path.join(staging, *parts), mode=0o755, exist_ok=True)
                        continue
                    if not member.isfile():
                        raise Refused(400, "bad_bundle", "Bundles may contain only files and folders")
                    files += 1
                    total += member.size
                    if files > LIMITS["maxSkillFiles"] or total > LIMITS["maxSkillBytes"]:
                        raise Refused(413, "bundle_too_large", "Bundle exceeds 200 files or 5 MB")
                    destination = os.path.join(staging, *parts)
                    os.makedirs(os.path.dirname(destination), mode=0o755, exist_ok=True)
                    source = archive.extractfile(member)
                    with open(destination, "xb") as file:
                        shutil.copyfileobj(source, file)
                    os.chmod(destination, 0o444)
        except tarfile.TarError as error:
            shutil.rmtree(staging, ignore_errors=True)
            raise Refused(400, "bad_bundle", "Not a readable tar archive: " + str(error)[:120])
        except Refused:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        for directory, subdirectories, _ in os.walk(staging):
            for sub in subdirectories:
                os.chmod(os.path.join(directory, sub), 0o555)
        os.chmod(staging, 0o555)
        if os.path.isdir(target):
            self._remove_tree(target)
        os.replace(staging, target)
        with open(marker, "w", encoding="utf-8") as file:
            file.write(digest)
        return {"slug": slug, "sha256": digest, "files": files, "reused": False}

    def _remove_tree(self, path):
        for directory, subdirectories, _ in os.walk(path):
            try:
                os.chmod(directory, 0o755)
            except OSError:
                pass
        shutil.rmtree(path, ignore_errors=True)

    def delete_session(self, session):
        root = self.session_dir(session, create=False)
        with self.lock:
            active = [run for run in self.runs.values() if run.session == session and run.status not in TERMINAL]
        for run in active:
            self.cancel(run.id)
        for run in active:
            with run.cond:
                run.cond.wait_for(lambda: run.status in TERMINAL, timeout=15)
        self._remove_tree(root)
        return {"deleted": True}

    # ── runs ──
    def start_run(self, body, idempotency_key):
        if not idempotency_key or len(idempotency_key) > 300:
            raise Refused(400, "idempotency_key_required", "Idempotency-Key header is required")
        session = body.get("session")
        account = body.get("account")
        language = body.get("language", "python")
        code = body.get("code")
        timeout_ms = body.get("timeoutMs", 120000)
        skills = body.get("skills", []) or []
        unknown = set(body) - {"session", "account", "language", "code", "timeoutMs", "skills"}
        if unknown:
            raise Refused(400, "unknown_field", "Unknown field: " + sorted(unknown)[0])
        if not SESSION.fullmatch(session or ""):
            raise Refused(400, "bad_session", "Invalid session id")
        if not ACCOUNT.fullmatch(account or ""):
            raise Refused(400, "bad_account", "Invalid account id")
        if language not in LANGUAGES:
            raise Refused(400, "bad_language", "language must be python, javascript or bash")
        if not isinstance(code, str) or not code.strip():
            raise Refused(400, "no_code", "code is required")
        if len(code.encode()) > LIMITS["maxCodeBytes"]:
            raise Refused(413, "code_too_large", "code exceeds 256 KB")
        if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not LIMITS["minTimeoutMs"] <= timeout_ms <= LIMITS["maxTimeoutMs"]:
            raise Refused(400, "bad_timeout", "timeoutMs must be between 1 s and 30 min")
        if not isinstance(skills, list) or len(skills) > LIMITS["maxSkills"] or not all(isinstance(s, str) and SLUG.fullmatch(s) for s in skills):
            raise Refused(400, "bad_skills", "Invalid skills list")
        canonical = json.dumps({"session": session, "account": account, "language": language, "code": code,
                                "timeoutMs": timeout_ms, "skills": sorted(set(skills))}, sort_keys=True).encode()
        body_digest = sha256(canonical)
        key_digest = sha256(idempotency_key.encode())
        idem_path = os.path.join(self.idem_root, key_digest + ".json")
        with self.lock:
            if os.path.isfile(idem_path):
                with open(idem_path, encoding="utf-8") as file:
                    entry = json.load(file)
                if not hmac.compare_digest(entry["bodyDigest"], body_digest):
                    raise Refused(409, "idempotency_key_reused", "This Idempotency-Key was used for a different request")
                run = self.runs.get(entry["runId"])
                if run:
                    return run, True
            root = self.session_dir(session)
            for slug in skills:
                if not os.path.isdir(os.path.join(root, "skills", slug)):
                    raise Refused(409, "skill_not_mounted", "Skill bundle not uploaded: " + slug)
            if self.pending + self.host_active >= LIMITS["hostPending"] + LIMITS["hostConcurrent"]:
                raise Refused(503, "busy", "The execution service is at capacity")
            run = Run({"id": "r_" + secrets.token_hex(12), "session": session, "account": account, "language": language,
                       "codeDigest": sha256(code.encode()), "status": "queued", "exitCode": None, "createdAt": now(),
                       "startedAt": None, "finishedAt": None, "timeoutMs": timeout_ms, "stdoutBytes": 0, "stderrBytes": 0,
                       "stdoutTruncated": False, "stderrTruncated": False, "files": [], "skippedFiles": [], "error": None,
                       "skills": sorted(set(skills)), "idempotencyKeyDigest": key_digest, "bodyDigest": body_digest,
                       "internal": False})
            program_dir = os.path.join(root, "programs", run.id)
            os.makedirs(program_dir, mode=0o755)
            filename = LANGUAGES[language][0]
            with open(os.path.join(program_dir, filename), "w", encoding="utf-8") as file:
                file.write(code)
            os.chmod(os.path.join(program_dir, filename), 0o444)
            self.runs[run.id] = run
            self._persist(run)
            temporary = idem_path + ".tmp"
            with open(temporary, "w", encoding="utf-8") as file:
                json.dump({"runId": run.id, "bodyDigest": body_digest}, file)
            os.replace(temporary, idem_path)
            self.pending += 1
        threading.Thread(target=self._execute, args=(run,), daemon=True).start()
        return run, False

    def _acquire_slot(self, run):
        with self.slot:
            while True:
                if run.cancel_requested:
                    return False
                if self.host_active < LIMITS["hostConcurrent"] and self.account_active.get(run.account, 0) < LIMITS["perAccountConcurrent"]:
                    self.host_active += 1
                    self.account_active[run.account] = self.account_active.get(run.account, 0) + 1
                    self.pending -= 1
                    return True
                self.slot.wait(timeout=1)

    def _release_slot(self, run):
        with self.slot:
            self.host_active -= 1
            self.account_active[run.account] = max(0, self.account_active.get(run.account, 1) - 1)
            self.slot.notify_all()

    def run_argv(self, run, command, program=True):
        policy = self.config["policy"]
        root = os.path.join(self.sessions_root, run.session)
        argv = ["run", "--rm", "--init", "--read-only", "--name", "juno-exec-" + run.id,
                "--label", "app=juno-exec", "--label", "juno.session=" + run.session, "--label", "juno.run=" + run.id,
                "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--user", policy["runUser"], "--pids-limit", str(policy["pidsLimit"]),
                "--memory", f"{policy['memoryMb']}m", "--memory-swap", f"{policy['memoryMb']}m", "--cpus", str(policy["cpus"]),
                "--tmpfs", f"/tmp:rw,nosuid,nodev,size={policy['tmpfsSize']},mode=1777",
                "--workdir", "/work", "--stop-timeout", "1"]
        if policy.get("runtime"):
            argv += ["--runtime", policy["runtime"]]
        argv += ["--mount", f"type=bind,source={root}/work,target=/work",
                 "--mount", f"type=bind,source={root}/inputs,target=/work/inputs,readonly"]
        if program:
            argv += ["--mount", f"type=bind,source={root}/programs/{run.id},target=/juno/program,readonly"]
        for slug in run.skills or []:
            argv += ["--mount", f"type=bind,source={root}/skills/{slug},target=/skills/{slug},readonly"]
        return argv + [policy["image"]] + command

    def _append_event(self, run, stream, text):
        with run.cond:
            if run.event_bytes + len(text) > LIMITS["maxEventBytes"]:
                if not run.events_truncated:
                    run.events_truncated = True
                    run.events.append((len(run.events) + 1, "notice", "[live output stopped here; the full log is kept]"))
                run.cond.notify_all()
                return
            run.event_bytes += len(text)
            run.events.append((len(run.events) + 1, stream, text))
            run.cond.notify_all()

    def _execute(self, run, command=None):
        if not self._acquire_slot(run):
            with self.lock:
                self.pending -= 1
            self._finish(run, "cancelled", None, None)
            return
        directory = self._run_dir(run.id)
        os.makedirs(directory, mode=0o750, exist_ok=True)
        logs = {"stdout": open(os.path.join(directory, "stdout.log"), "wb"),
                "stderr": open(os.path.join(directory, "stderr.log"), "wb")}
        root = os.path.join(self.sessions_root, run.session)
        before = walk_regular_files(os.path.join(root, "work"))
        timer = None
        try:
            with run.cond:
                run.status = "running"
                run.startedAt = now()
                run.cond.notify_all()
            self._persist(run)
            argv = self.run_argv(run, command or LANGUAGES[run.language][1], program=command is None)
            run.call = BrokerCall(self.config["broker"], argv)
            if not run.internal:
                self.started_runs += 1
            timer = threading.Timer(run.timeoutMs / 1000.0, self._timeout, args=(run,))
            timer.daemon = True
            timer.start()
            for stream, chunk in run.call.frames():
                key = stream + "Bytes"
                setattr(run, key, getattr(run, key) + len(chunk))
                written = logs[stream].tell()
                if written < LIMITS["maxLogBytes"]:
                    logs[stream].write(chunk[: LIMITS["maxLogBytes"] - written])
                if getattr(run, key) > LIMITS["maxLogBytes"]:
                    setattr(run, stream + "Truncated", True)
                self._append_event(run, stream, chunk.decode("utf-8", "replace"))
            exit_code, refused = run.call.exit_code, run.call.refused
        except OSError as error:
            exit_code, refused = None, "broker unavailable: " + str(error)
        finally:
            if timer:
                timer.cancel()
            for file in logs.values():
                file.close()
            self._release_slot(run)
        if refused:
            self._finish(run, "failed", None, "The sandbox refused to start: " + refused[:300])
            return
        if run.cancel_requested:
            status = "cancelled"
        elif run.timed_out:
            status = "timed_out"
        elif exit_code == 0:
            status = "succeeded"
        else:
            status = "failed"
        error = None
        if exit_code in (125, 126, 127) and run.stdoutBytes == 0 and status == "failed":
            error = "The sandbox could not start the program (docker exit %d)." % exit_code
        elif exit_code == 137 and status == "failed":
            error = "The program was killed (exit 137): it most likely ran out of memory (%d MB)." % self.config["policy"]["memoryMb"]
        if status in ("succeeded", "failed", "timed_out"):
            self._collect_files(run, root, before)
        self._finish(run, status, exit_code, error)

    def _collect_files(self, run, root, before):
        after = walk_regular_files(os.path.join(root, "work"))
        files, skipped, total = [], [], 0
        for path in sorted(after):
            if before.get(path) == after[path]:
                continue
            size = after[path][0]
            if len(files) >= LIMITS["maxFiles"]:
                skipped.append({"path": path, "bytes": size, "reason": "more than 20 files"})
                continue
            if size > LIMITS["maxFileBytes"]:
                skipped.append({"path": path, "bytes": size, "reason": "larger than 25 MB"})
                continue
            if total + size > LIMITS["maxFilesTotalBytes"]:
                skipped.append({"path": path, "bytes": size, "reason": "over 50 MB in total"})
                continue
            try:
                fd = open_beneath(os.path.join(root, "work"), path)
            except (OSError, Refused):
                continue
            digest = hashlib.sha256()
            with os.fdopen(fd, "rb") as file:
                for chunk in iter(lambda: file.read(65536), b""):
                    digest.update(chunk)
            total += size
            files.append({"path": path, "bytes": size, "sha256": digest.hexdigest(), "mime": guess_mime(path)})
        run.files, run.skippedFiles = files, skipped

    def _finish(self, run, status, exit_code, error):
        with run.cond:
            run.status = status
            run.exitCode = exit_code
            run.finishedAt = now()
            if error and not run.error:
                run.error = error
            run.cond.notify_all()
        self._persist(run)
        try:
            self.touch_session(run.session)
        except OSError:
            pass

    def _timeout(self, run):
        if run.status == "running":
            run.timed_out = True
            self._kill(run)

    def _kill(self, run):
        try:
            broker_run(self.config["broker"], ["kill", "juno-exec-" + run.id])
        except OSError:
            pass

    def cancel(self, run_id):
        run = self.get(run_id)
        run.cancel_requested = True
        if run.status == "queued":
            with self.slot:
                self.slot.notify_all()
        elif run.status == "running":
            self._kill(run)
        return run

    def get(self, run_id):
        if not RUN.fullmatch(run_id or ""):
            raise Refused(400, "bad_run", "Invalid run id")
        run = self.runs.get(run_id)
        if not run or getattr(run, "internal", False):
            raise Refused(404, "no_run", "Unknown run")
        return run

    def wait(self, run, seconds):
        deadline = now() + max(0.0, min(25.0, seconds))
        with run.cond:
            while run.status not in TERMINAL:
                remaining = deadline - now()
                if remaining <= 0:
                    break
                run.cond.wait(remaining)

    def read_log(self, run, stream, offset, limit):
        path = os.path.join(self._run_dir(run.id), stream + ".log")
        try:
            with open(path, "rb") as file:
                file.seek(offset)
                return file.read(limit)
        except FileNotFoundError:
            return b""

    def head_tail(self, run, stream):
        path = os.path.join(self._run_dir(run.id), stream + ".log")
        size = getattr(run, stream + "Bytes") or 0
        tail_bytes = LIMITS["tailBytes"]
        try:
            with open(path, "rb") as file:
                head = file.read(tail_bytes)
                stored = os.fstat(file.fileno()).st_size
                if stored > tail_bytes * 2:
                    file.seek(stored - tail_bytes)
                    tail = file.read(tail_bytes)
                else:
                    file.seek(0)
                    whole = file.read()
                    head, tail = whole, b""
        except FileNotFoundError:
            head, tail, stored = b"", b"", 0
        return {"head": head.decode("utf-8", "replace"), "tail": tail.decode("utf-8", "replace"),
                "bytes": size, "storedBytes": stored}

    def snapshot(self, run, include_output=True):
        data = {key: value for key, value in run.record().items() if key not in ("idempotencyKeyDigest", "bodyDigest", "internal")}
        started, finished = run.startedAt, run.finishedAt
        data["durationMs"] = int(((finished or now()) - started) * 1000) if started else None
        data["context"] = "hosted_sandbox"
        data["network"] = "none"
        if include_output:
            data["stdout"] = self.head_tail(run, "stdout")
            data["stderr"] = self.head_tail(run, "stderr")
        return data

    def get_manifest(self):
        with self.manifest_lock:
            if self.manifest is not None:
                return self.manifest
            session = "s_" + "0" * 32
            self.session_dir(session)
            run = Run({"id": "r_" + secrets.token_hex(12), "session": session, "account": "a_" + "0" * 32,
                       "language": "python", "codeDigest": "", "status": "queued", "exitCode": None, "createdAt": now(),
                       "startedAt": None, "finishedAt": None, "timeoutMs": 60000, "stdoutBytes": 0, "stderrBytes": 0,
                       "stdoutTruncated": False, "stderrTruncated": False, "files": [], "skippedFiles": [],
                       "error": None, "skills": [], "idempotencyKeyDigest": None, "bodyDigest": None, "internal": True})
            self.runs[run.id] = run
            with self.lock:
                self.pending += 1
            self._execute(run, command=list(MANIFEST_COMMAND))
            text = self.read_log(run, "stdout", 0, 1024 * 1024).decode("utf-8", "replace")
            try:
                manifest = json.loads(text)
                manifest["limits"] = {key: LIMITS[key] for key in ("maxTimeoutMs", "maxFiles", "maxFileBytes", "maxInputBytes")}
                self.manifest = manifest
            except ValueError:
                return {"error": "manifest_unavailable", "status": run.status}
            return self.manifest

    def health(self):
        return {"ok": True, "service": "juno-exec", "api": 1, "egress": "none", "image": self.config["policy"]["image"],
                "activeRuns": self.host_active, "queuedRuns": self.pending, "runsStarted": self.started_runs,
                "time": int(now())}

    def sweep(self):
        """Drop idle sessions and old run records (30 minutes after the last activity)."""
        cutoff_session = now() - LIMITS["sessionIdleSeconds"]
        cutoff_run = now() - LIMITS["runRetentionSeconds"]
        with self.lock:
            active_sessions = {run.session for run in self.runs.values() if run.status not in TERMINAL}
            old_runs = [run for run in self.runs.values() if run.status in TERMINAL and (run.finishedAt or 0) < cutoff_run]
            for run in old_runs:
                del self.runs[run.id]
        for run in old_runs:
            shutil.rmtree(self._run_dir(run.id), ignore_errors=True)
            if run.idempotencyKeyDigest:
                try:
                    os.unlink(os.path.join(self.idem_root, run.idempotencyKeyDigest + ".json"))
                except OSError:
                    pass
        for session in os.listdir(self.sessions_root):
            if not SESSION.fullmatch(session) or session in active_sessions:
                continue
            marker = os.path.join(self.sessions_root, session, ".active")
            try:
                last = os.stat(marker).st_mtime
            except OSError:
                last = 0
            if last < cutoff_session:
                self._remove_tree(os.path.join(self.sessions_root, session))


# ── HTTP ─────────────────────────────────────────────────────────────────────


def make_handler(service, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "juno-exec"
        sys_version = ""

        def log_message(self, format, *args):
            # Ids, sizes and verdicts only; never bodies, code or file contents.
            sys.stderr.write("juno-exec %s %s\n" % (self.command, self.path.split("?")[0][:120]))

        def send_json(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def refuse(self, error):
            self.send_json(error.status, {"error": error.code, "message": error.message})

        def authorized(self):
            header = self.headers.get("Authorization", "")
            supplied = header[7:] if header.startswith("Bearer ") else ""
            return bool(supplied) and hmac.compare_digest(supplied.encode(), token.encode())

        def length(self):
            value = self.headers.get("Content-Length")
            try:
                return int(value) if value is not None else None
            except ValueError:
                return None

        def json_body(self):
            length = self.length()
            if length is None or length > LIMITS["maxRequestBytes"]:
                raise Refused(413, "body_too_large", "Request body is missing or too large")
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise Refused(400, "bad_json", "Body is not JSON")
            if not isinstance(body, dict):
                raise Refused(400, "bad_json", "Body must be an object")
            return body

        def drain(self):
            length = self.length()
            if length and length <= LIMITS["maxRequestBytes"]:
                self.rfile.read(length)
            elif length:
                self.close_connection = True

        def dispatch(self, method):
            url = urllib.parse.urlsplit(self.path)
            parts = [urllib.parse.unquote(part) for part in url.path.split("/") if part]
            query = urllib.parse.parse_qs(url.query)
            if not self.authorized():
                self.drain()
                raise Refused(401, "unauthorized", "Missing or invalid token")
            if method == "POST" and parts == ["execute"]:
                self.drain()
                raise Refused(410, "gone", "Use the v1 API")
            if not parts or parts[0] != "v1":
                raise Refused(404, "not_found", "Not found")
            route = parts[1:]
            if method == "GET" and route == ["health"]:
                return self.send_json(200, service.health())
            if method == "GET" and route == ["manifest"]:
                return self.send_json(200, service.get_manifest())
            if len(route) == 4 and route[0] == "sessions" and route[2] == "inputs" and method == "PUT":
                return self.send_json(201, service.put_input(route[1], route[3], self.rfile, self.length()))
            if len(route) == 4 and route[0] == "sessions" and route[2] == "skills" and method == "PUT":
                return self.send_json(201, service.put_skill(route[1], route[3], self.rfile, self.length(), self.headers.get("X-Bundle-Digest")))
            if len(route) == 2 and route[0] == "sessions" and method == "DELETE":
                return self.send_json(200, service.delete_session(route[1]))
            if route == ["runs"] and method == "POST":
                run, replayed = service.start_run(self.json_body(), self.headers.get("Idempotency-Key"))
                payload = service.snapshot(run)
                payload["replayed"] = replayed
                return self.send_json(200 if replayed else 201, payload)
            if len(route) >= 2 and route[0] == "runs":
                run = service.get(route[1])
                rest = route[2:]
                if method == "GET" and rest == []:
                    wait = float(query.get("wait", ["0"])[0] or 0)
                    service.wait(run, wait)
                    return self.send_json(200, service.snapshot(run))
                if method == "POST" and rest == ["cancel"]:
                    self.drain()
                    service.cancel(run.id)
                    return self.send_json(202, service.snapshot(run, include_output=False))
                if method == "GET" and rest == ["output"]:
                    stream = query.get("stream", ["stdout"])[0]
                    if stream not in ("stdout", "stderr"):
                        raise Refused(400, "bad_stream", "stream must be stdout or stderr")
                    offset = max(0, int(query.get("offset", ["0"])[0]))
                    limit = max(1, min(1024 * 1024, int(query.get("limit", ["65536"])[0])))
                    data = service.read_log(run, stream, offset, limit)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("X-Total-Bytes", str(getattr(run, stream + "Bytes")))
                    self.send_header("X-Truncated", "1" if getattr(run, stream + "Truncated") else "0")
                    self.end_headers()
                    self.wfile.write(data)
                    return None
                if method == "GET" and rest == ["files"]:
                    return self.send_json(200, {"files": run.files, "skipped": run.skippedFiles, "status": run.status})
                if method == "GET" and len(rest) >= 2 and rest[0] == "files":
                    relative = "/".join(rest[1:])
                    entry = next((item for item in run.files if item["path"] == relative), None)
                    if not entry:
                        raise Refused(404, "no_file", "No such produced file")
                    fd = open_beneath(os.path.join(service.sessions_root, run.session, "work"), relative)
                    with os.fdopen(fd, "rb") as file:
                        size = os.fstat(file.fileno()).st_size
                        if size != entry["bytes"]:
                            raise Refused(409, "file_changed", "The file changed after the run")
                        self.send_response(200)
                        self.send_header("Content-Type", entry["mime"])
                        self.send_header("Content-Length", str(size))
                        self.send_header("X-Sha256", entry["sha256"])
                        self.end_headers()
                        shutil.copyfileobj(file, self.wfile, 65536)
                    return None
                if method == "GET" and rest == ["events"]:
                    return self.stream_events(run, int(query.get("after", ["0"])[0] or 0))
            raise Refused(404, "not_found", "Not found")

        def stream_events(self, run, after):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sent = after
            last_beat = now()
            try:
                while True:
                    with run.cond:
                        pending = [event for event in run.events if event[0] > sent]
                        done = run.status in TERMINAL
                        if not pending and not done:
                            run.cond.wait(timeout=15)
                            pending = [event for event in run.events if event[0] > sent]
                            done = run.status in TERMINAL
                    for seq, stream, text in pending:
                        payload = json.dumps({"seq": seq, "stream": stream, "text": text})
                        self.wfile.write(f"id: {seq}\nevent: chunk\ndata: {payload}\n\n".encode())
                        sent = seq
                    if done and not [event for event in run.events if event[0] > sent]:
                        payload = json.dumps({"status": run.status, "exitCode": run.exitCode})
                        self.wfile.write(f"event: end\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                        return
                    if now() - last_beat > 15:
                        self.wfile.write(b": keep-alive\n\n")
                        last_beat = now()
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def handle_method(self, method):
            try:
                self.dispatch(method)
            except Refused as error:
                self.refuse(error)
            except (ValueError, KeyError) as error:
                self.refuse(Refused(400, "bad_request", str(error)[:200]))
            except OSError as error:
                self.refuse(Refused(500, "host_error", "The execution host failed: " + type(error).__name__))

        def do_GET(self):
            self.handle_method("GET")

        def do_POST(self):
            self.handle_method("POST")

        def do_PUT(self):
            self.handle_method("PUT")

        def do_DELETE(self):
            self.handle_method("DELETE")

    return Handler


def load_config():
    """Configuration from the environment (systemd unit or the local profile)."""
    token = os.environ.get("JUNO_EXEC_TOKEN", "")
    token_file = os.environ.get("JUNO_EXEC_TOKEN_FILE") or (
        os.path.join(os.environ["CREDENTIALS_DIRECTORY"], "token") if os.environ.get("CREDENTIALS_DIRECTORY") else "")
    if token_file:
        with open(token_file, encoding="utf-8") as file:
            token = file.read().strip()
    if len(token) < 32:
        raise SystemExit("juno-exec: the API token must be at least 32 characters (JUNO_EXEC_TOKEN_FILE)")
    policy_path = os.environ.get("JUNO_EXEC_POLICY", "/etc/juno/exec-broker.json")
    with open(policy_path, encoding="utf-8") as file:
        policy = json.load(file)
    data_root = os.environ.get("JUNO_EXEC_DATA", "/var/lib/juno-exec")
    if os.path.realpath(os.path.join(data_root, "sessions")) != policy["sessionsRoot"]:
        raise SystemExit("juno-exec: the broker policy sessionsRoot must be <data>/sessions")
    if os.environ.get("JUNO_EXEC_BROKER_SOCKET"):
        broker = {"mode": "socket", "path": os.environ["JUNO_EXEC_BROKER_SOCKET"]}
    else:
        # Developer profile: the broker runs as a child process with the same
        # validation (no root, Docker Desktop).
        broker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "juno-exec-docker-broker.py")
        env = dict(os.environ)
        env["JUNO_EXEC_BROKER_POLICY"] = policy_path
        broker = {"mode": "process", "argv": [sys.executable, broker_path], "env": env}
    return {"token": token, "policy": policy, "dataRoot": data_root, "broker": broker,
            "host": os.environ.get("JUNO_EXEC_HOST", "127.0.0.1"), "port": int(os.environ.get("JUNO_EXEC_PORT", "8740"))}


def serve(config):
    service = Service(config)
    server = ThreadingHTTPServer((config["host"], config["port"]), make_handler(service, config["token"]))
    server.daemon_threads = True

    def sweeper():
        while True:
            time.sleep(60)
            try:
                service.sweep()
            except Exception as error:  # the sweep must never take the service down
                sys.stderr.write("juno-exec sweep failed: %s\n" % type(error).__name__)

    threading.Thread(target=sweeper, daemon=True).start()
    sys.stderr.write("juno-exec listening on %s:%d\n" % (config["host"], config["port"]))
    server.serve_forever()


if __name__ == "__main__":
    serve(load_config())
