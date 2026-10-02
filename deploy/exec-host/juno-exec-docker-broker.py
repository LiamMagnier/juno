#!/usr/bin/python3
"""juno-exec-docker-broker: the only thing on the execution host that talks to Docker.

Root-owned and argv-validating, modelled on deploy/agent-computers/docker-broker.py.
juno-exec (an unprivileged service with NoNewPrivileges) never holds the Docker
socket and never runs sudo: systemd socket-activates one broker instance per
connection on /run/juno-exec/broker.sock (root:juno-exec 0660, Accept=yes). The
client writes ONE JSON line, {"argv": [...]}; the broker validates it against the
policy (/etc/juno/exec-broker.json, root-owned 0644) and runs `docker <argv>`,
relaying the child's stdout and stderr as frames and finally its exit status:

    frame = type (1 byte) + length (4 bytes, big endian) + payload
    o = stdout bytes, e = stderr bytes, x = exit status (ASCII int), r = refused (reason)

Permitted operations, exactly:
  run   the fixed sandbox profile below with the pinned image and one of four commands
  kill  / rm -f  a container named juno-exec-<run id> that carries the label app=juno-exec
  ps    one fixed listing of juno-exec containers
  image inspect  the pinned image's security label

Every sandbox flag is required with its exact policy value; anything else (another
image, network, mount, capability, user, device, limit, environment, privilege or
runtime) is refused. Bind sources must be the service's own per-session
directories under policy.sessionsRoot, real directories and not symlinks.

Developer mode: when not running as root (a Mac with Docker Desktop, the unit
tests) the policy path and the docker binary may come from JUNO_EXEC_BROKER_POLICY
and JUNO_EXEC_DOCKER. As root they are ignored; sudo/systemd reset the environment
anyway.
"""
import json
import os
import re
import selectors
import struct
import subprocess
import sys

CONFIG = "/etc/juno/exec-broker.json"
DOCKER = "/usr/bin/docker"
RUN_ID = r"r_[0-9a-f]{24}"
SESSION_ID = r"s_[0-9a-f]{32}"
SLUG = r"[a-z0-9][a-z0-9-]{0,63}"
NAME = re.compile(r"juno-exec-" + RUN_ID + r"\Z")
LABEL_SESSION = re.compile(r"juno\.session=" + SESSION_ID + r"\Z")
LABEL_RUN = re.compile(r"juno\.run=" + RUN_ID + r"\Z")
PS_ARGV = ["ps", "-a", "--filter", "label=app=juno-exec", "--format", '{{.Names}}\t{{.Label "juno.session"}}\t{{.State}}']
COMMANDS = (
    ["python3", "/juno/program/main.py"],
    ["node", "/juno/program/main.js"],
    ["bash", "/juno/program/main.sh"],
    ["python3", "/opt/juno/manifest.py"],
)
MAX_REQUEST = 64 * 1024
MAX_SKILL_MOUNTS = 8


def load_policy():
    path = CONFIG
    if os.geteuid() != 0:
        path = os.environ.get("JUNO_EXEC_BROKER_POLICY", CONFIG)
    with open(path, encoding="utf-8") as file:
        policy = json.load(file)
    for key in ("image", "sessionsRoot", "runUser", "memoryMb", "cpus", "pidsLimit", "tmpfsSize"):
        if key not in policy:
            raise ValueError("Policy is missing " + key)
    if not re.fullmatch(r"[1-9][0-9]{0,9}:[1-9][0-9]{0,9}", policy["runUser"]):
        raise ValueError("Policy run user must be a non-root numeric uid:gid")
    if not policy["sessionsRoot"].startswith("/") or policy["sessionsRoot"].rstrip("/") != policy["sessionsRoot"]:
        raise ValueError("Policy sessionsRoot must be an absolute path without a trailing slash")
    return policy


def docker_binary():
    if os.geteuid() != 0:
        return os.environ.get("JUNO_EXEC_DOCKER", DOCKER)
    return DOCKER


def real_directory(path):
    """The path exists, is a directory, and no component of it is a symlink."""
    try:
        return os.path.realpath(path) == path and os.path.isdir(path) and not os.path.islink(path)
    except OSError:
        return False


def mount_spec(value, policy, session):
    """Parse one --mount value and check it is one of the service's own directories."""
    parts = value.split(",")
    fields = {}
    flags = []
    for part in parts:
        if "=" in part:
            key, _, item = part.partition("=")
            if key in fields:
                raise ValueError("Duplicate mount field")
            fields[key] = item
        else:
            flags.append(part)
    if fields.get("type") != "bind" or set(fields) != {"type", "source", "target"}:
        raise ValueError("Only fixed bind mounts are permitted")
    root = policy["sessionsRoot"] + "/" + session
    source, target = fields["source"], fields["target"]
    if target == "/work" and source == root + "/work" and flags == []:
        kind = "work"
    elif target == "/work/inputs" and source == root + "/inputs" and flags == ["readonly"]:
        kind = "inputs"
    elif target == "/juno/program" and re.fullmatch(re.escape(root + "/programs/") + RUN_ID, source) and flags == ["readonly"]:
        kind = "program"
    elif re.fullmatch(r"/skills/" + SLUG, target) and source == root + "/skills/" + target[len("/skills/"):] and flags == ["readonly"]:
        kind = "skill"
    else:
        raise ValueError("Mount is not one of the session's own directories")
    if not real_directory(source):
        raise ValueError("Mount source is not a real directory")
    return kind, source


def validate_run(argv, policy):
    """argv = ["run", <flags...>, image, <command...>]. Returns the container name."""
    index = 1
    flags = {}
    boolean = {"--rm", "--read-only", "--init"}
    valued = {"--name", "--label", "--network", "--cap-drop", "--security-opt", "--user", "--pids-limit",
              "--memory", "--memory-swap", "--cpus", "--tmpfs", "--mount", "--workdir", "--runtime", "--stop-timeout"}
    while index < len(argv) and argv[index].startswith("--"):
        key = argv[index]
        if key in boolean:
            flags.setdefault(key, []).append(True)
            index += 1
        elif key in valued and index + 1 < len(argv):
            flags.setdefault(key, []).append(argv[index + 1])
            index += 2
        else:
            raise ValueError("Unknown run option " + key[:40])
    if index >= len(argv) or argv[index] != policy["image"]:
        raise ValueError("Unapproved image")
    command = argv[index + 1:]
    if command not in [list(entry) for entry in COMMANDS]:
        raise ValueError("Unapproved command")
    name = flags.get("--name", [""])[0]
    if len(flags.get("--name", [])) != 1 or not NAME.fullmatch(name):
        raise ValueError("Invalid container name")
    labels = flags.get("--label", [])
    if len(labels) != 3 or labels[0] != "app=juno-exec" or not LABEL_SESSION.fullmatch(labels[1]) or labels[2] != "juno.run=" + name[len("juno-exec-"):]:
        raise ValueError("Invalid labels")
    session = labels[1][len("juno.session="):]
    fixed = {
        "--rm": [True], "--read-only": [True], "--init": [True],
        "--network": ["none"], "--cap-drop": ["ALL"], "--security-opt": ["no-new-privileges"],
        "--user": [policy["runUser"]], "--pids-limit": [str(policy["pidsLimit"])],
        "--memory": [str(policy["memoryMb"]) + "m"], "--memory-swap": [str(policy["memoryMb"]) + "m"],
        "--cpus": [str(policy["cpus"])],
        "--tmpfs": ["/tmp:rw,nosuid,nodev,size=" + policy["tmpfsSize"] + ",mode=1777"],
        "--workdir": ["/work"], "--stop-timeout": ["1"],
    }
    if policy.get("runtime"):
        fixed["--runtime"] = [policy["runtime"]]
    elif "--runtime" in flags:
        raise ValueError("Runtime is not permitted")
    for key, expected in fixed.items():
        if flags.get(key) != expected:
            raise ValueError("Sandbox requirement missing: " + key)
    kinds = []
    for value in flags.get("--mount", []):
        kind, _ = mount_spec(value, policy, session)
        kinds.append(kind)
    if kinds[:2] != ["work", "inputs"] or kinds.count("work") != 1 or kinds.count("inputs") != 1:
        raise ValueError("The session workspace and inputs must be mounted first, once")
    programs = kinds.count("program")
    manifest = command == list(COMMANDS[3])
    if (programs != 1 and not manifest) or (programs != 0 and manifest):
        raise ValueError("A program run mounts exactly its own program directory")
    if programs and not any(value.endswith("/programs/" + name[len("juno-exec-"):] + ",target=/juno/program,readonly") for value in flags["--mount"]):
        raise ValueError("The program directory must belong to this run")
    if kinds.count("skill") > policy.get("maxSkillMounts", MAX_SKILL_MOUNTS):
        raise ValueError("Too many skill mounts")
    return name


def validate(argv, policy):
    """Returns the container name the command targets (for the namespace check), or None."""
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        raise ValueError("Missing operation")
    if any("\x00" in item or len(item) > 4096 for item in argv):
        raise ValueError("Invalid argument")
    operation = argv[0]
    if operation == "run":
        validate_run(argv, policy)
        return None
    if argv == PS_ARGV:
        return None
    if argv == ["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', policy["image"]]:
        return None
    if operation == "kill" and len(argv) == 2 and NAME.fullmatch(argv[1]):
        return argv[1]
    if operation == "rm" and len(argv) == 3 and argv[1] == "-f" and NAME.fullmatch(argv[2]):
        return argv[2]
    raise ValueError("Operation is not permitted")


def frame(kind, payload):
    return kind + struct.pack(">I", len(payload)) + payload


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def read_request(fd):
    data = b""
    while b"\n" not in data:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data += chunk
        if len(data) > MAX_REQUEST:
            raise ValueError("Request too large")
    line = data.split(b"\n", 1)[0]
    request = json.loads(line.decode("utf-8"))
    if not isinstance(request, dict) or set(request) != {"argv"}:
        raise ValueError("Malformed request")
    return request["argv"]


def relay(command, environment, out_fd):
    process = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
        # The client went away (juno-exec restarted). The container keeps its own
        # lifetime; the service reaps orphans with `ps` + `kill` when it starts.
        pass
    code = process.wait()
    try:
        write_all(out_fd, frame(b"x", str(code).encode()))
    except BrokenPipeError:
        pass
    return code


def namespace_check(target, docker, environment):
    # Fails closed: a container that cannot be inspected (missing, or a daemon
    # error) is refused rather than operated on unchecked.
    inspected = subprocess.run([docker, "inspect", "--type", "container", "-f", '{{index .Config.Labels "app"}}', target],
                               env=environment, capture_output=True, text=True)
    if inspected.returncode != 0 or inspected.stdout.strip() != "juno-exec":
        raise ValueError("Container is missing or outside the juno-exec namespace")


def main():
    in_fd, out_fd = 0, 1
    try:
        policy = load_policy()
        argv = read_request(in_fd)
        target = validate(argv, policy)
        # A fixed environment: no DOCKER_HOST, DOCKER_CONFIG, PATH or plugin injection.
        environment = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
        if os.geteuid() != 0:
            environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}
        docker = docker_binary()
        if target:
            namespace_check(target, docker, environment)
    except (ValueError, IndexError, KeyError, OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        message = "exec broker refused request: " + str(error)
        print(message, file=sys.stderr)
        try:
            write_all(out_fd, frame(b"r", message.encode()))
        except OSError:
            pass
        return 1
    relay([docker] + argv, environment, out_fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
