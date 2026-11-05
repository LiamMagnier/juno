#!/usr/bin/python3
"""juno-computer-host-broker: the only thing on a computer host that talks to Docker.

A computer host (deploy/computer-host/README.md, COMPUTERS_2026-10.md S3) runs
agent computers on a machine of its own, away from the web VM's database URL
and provider keys. The host service (juno-computer-host.py) is unprivileged
(NoNewPrivileges, no docker group, no sudo); every Docker call it makes goes
through this broker, socket-activated by systemd one instance per connection
on /run/juno-computer-host/broker.sock (root:juno-computer-host 0660,
Accept=yes, D6).

The client writes ONE JSON line:

    {"argv": [...], "namespace": "<ns>", "stdin_b64": "<optional>"}

and reads frames back, exactly as deploy/exec-host's broker writes them:

    frame = type (1 byte) + length (4 bytes, big endian) + payload
    o = stdout bytes, e = stderr bytes, x = exit status (ASCII int),
    r = refused: "missing" (no such container), "foreign" (another
        namespace's container or volume) or "refused: <reason>"

The argv policy is NOT copied here: `validate()`, the namespace inspect and
the egress-map hooks are imported from deploy/agent-computers/docker-broker.py
(installed beside this file as /usr/local/lib/juno-computer-host/docker-broker.py)
and called in host mode with the request's namespace, so the single-box sudo
broker and this one can never disagree about what a computer may be. `stdin`
is accepted only for `docker exec -i` (the CDP token, the VNC passwords and
file writes travel that way, never in argv or env).

Developer mode (`--developer`, used by local/run-local.sh and the tests: the
host service starts this file as a child process instead of dialling the
socket) reads the request from stdin and writes frames to stdout, and takes
`--policy`, `--docker` and `--egress-map <file>|none` from its own argv. The
production unit passes none of them.
"""
import base64
import importlib.util
import json
import os
import selectors
import struct
import subprocess
import sys
import threading

POLICY = "/etc/juno/computer-host-broker.json"
DOCKER = "/usr/bin/docker"
INSTALLED_MODULE = "/usr/local/lib/juno-computer-host/docker-broker.py"
REPO_MODULE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agent-computers", "docker-broker.py")
REPO_EGRESS_MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agent-computers", "egress-map.py")
ENVIRONMENT = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
# A file write (25 MB at most, the app's own cap) in base64, with room for the JSON around it.
MAX_REQUEST = 48 * 1024 * 1024
MAX_STDIN = 30 * 1024 * 1024


def load_broker_module(path):
    spec = importlib.util.spec_from_file_location("juno_computer_docker_broker", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frame(kind, payload):
    return kind + struct.pack(">I", len(payload)) + payload


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def read_request(fd):
    chunks = []
    size = 0
    while True:
        chunk = os.read(fd, 1 << 20)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if b"\n" in chunk:
            break
        if size > MAX_REQUEST:
            raise ValueError("Request too large")
    data = b"".join(chunks)
    if len(data) > MAX_REQUEST:
        raise ValueError("Request too large")
    line = data.split(b"\n", 1)[0]
    request = json.loads(line.decode("utf-8"))
    if not isinstance(request, dict) or not set(request) <= {"argv", "namespace", "stdin_b64"} \
            or "argv" not in request or "namespace" not in request:
        raise ValueError("Malformed request")
    argv = request["argv"]
    if not isinstance(argv, list) or not all(isinstance(value, str) for value in argv):
        raise ValueError("Malformed argv")
    stdin = None
    if request.get("stdin_b64") is not None:
        if argv[:2] != ["exec", "-i"]:
            raise ValueError("Only exec -i takes input")
        stdin = base64.b64decode(request["stdin_b64"], validate=True)
        if len(stdin) > MAX_STDIN:
            raise ValueError("Input too large")
    return argv, request["namespace"], stdin


def relay(command, environment, out_fd, stdin=None):
    """Runs docker, relaying its output as frames; returns its exit status."""
    process = subprocess.Popen(command, env=environment,
                               stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if stdin is not None:
        def feed():
            try:
                process.stdin.write(stdin)
            except (BrokenPipeError, OSError):
                pass
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass
        threading.Thread(target=feed, daemon=True).start()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, b"o")
    selector.register(process.stderr, selectors.EVENT_READ, b"e")
    open_streams = 2
    try:
        while open_streams:
            for key, _ in selector.select():
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    open_streams -= 1
                    continue
                write_all(out_fd, frame(key.data, chunk))
    except BrokenPipeError:
        # The host service went away (a timeout, a restart). The command keeps
        # its own time limit inside the computer.
        pass
    return process.wait()


def parse_arguments(argv):
    options = {"developer": False, "policy": POLICY, "docker": DOCKER, "egress_map": None, "module": None}
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag == "--developer":
            options["developer"] = True
            index += 1
        elif flag in ("--policy", "--docker", "--egress-map", "--module") and index + 1 < len(argv):
            options[flag[2:].replace("-", "_")] = argv[index + 1]
            index += 2
        else:
            raise SystemExit("juno-computer-host-broker: unknown argument " + flag)
    if not options["developer"] and any(options[key] not in (None, POLICY, DOCKER) for key in ("policy", "docker", "egress_map", "module")):
        raise SystemExit("juno-computer-host-broker: --policy, --docker, --egress-map and --module are for --developer only")
    return options


def main(argv=None):
    options = parse_arguments(sys.argv[1:] if argv is None else argv)
    in_fd, out_fd = 0, 1
    module_path = options["module"] or (REPO_MODULE if options["developer"] else INSTALLED_MODULE)
    broker = load_broker_module(module_path)
    docker = options["docker"]
    environment = dict(ENVIRONMENT)
    if options["developer"]:
        # Developer mode keeps the caller's PATH so a test's stand-in docker can be found.
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/root")}

    def hooks(*arguments):
        """The egress address map around start, stop and remove (D19)."""
        target = options["egress_map"]
        if options["developer"] and target == "none":
            return True
        if options["developer"] and target:
            command = [sys.executable, "-I", REPO_EGRESS_MAP] + list(arguments)
            env = dict(broker.EGRESS_MAP_ENV, JUNO_EGRESS_MAP=target)
        else:
            command = broker.EGRESS_MAP_HELPER + list(arguments)
            env = broker.EGRESS_MAP_ENV
        try:
            return subprocess.run(command, env=env, capture_output=True, timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    try:
        with open(options["policy"], encoding="utf-8") as file:
            policy = json.load(file)
        argv_, namespace, stdin = read_request(in_fd)
        if not isinstance(namespace, str) or not broker.NAMESPACE.fullmatch(namespace):
            raise ValueError("Invalid namespace")
        broker.prepare(argv_, policy, namespace, docker, environment)
    except broker.Missing:
        write_all(out_fd, frame(b"r", b"missing"))
        return 0
    except broker.Foreign:
        write_all(out_fd, frame(b"r", b"foreign"))
        return 0
    except (ValueError, IndexError, KeyError, OSError, json.JSONDecodeError, UnicodeDecodeError,
            base64.binascii.Error) as error:
        message = "refused: " + str(error)
        print("computer host broker " + message, file=sys.stderr)
        try:
            write_all(out_fd, frame(b"r", message.encode()))
        except OSError:
            pass
        return 1

    def run(command_argv):
        return relay([docker] + command_argv, environment, out_fd, stdin)

    try:
        code = broker.dispatch(argv_, run=run, hooks=hooks)
    except ValueError as error:  # the map could not be rebuilt before a start
        message = "refused: " + str(error)
        print("computer host broker " + message, file=sys.stderr)
        write_all(out_fd, frame(b"r", message.encode()))
        return 1
    try:
        write_all(out_fd, frame(b"x", str(code).encode()))
    except BrokenPipeError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
