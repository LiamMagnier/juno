#!/usr/bin/python3
"""Root-owned, narrow sudo broker. Never exposes the Docker socket to Juno.

Only agent container lifecycle and exec are permitted. Creation accepts the
fixed sandbox mounts/network/security controls and bounded resource values.
The policy file and this executable must be writable only by root.

pipe-v4 (docs/design/agents-v2/COMPUTERS_2026-10.md S2):
  - every `exec --user 1000` must start with the agent launcher
    (/opt/juno/agent-exec run -- | helper -- | freeze | thaw), so nothing the
    agent's uid runs escapes its namespace ban, fixed environment or the
    take-over freeze;
  - the create argv pins `--dns 192.0.2.53` (RFC 5737; firewall.sh rejects
    port 53 to every address) and the /run/juno-state tmpfs, and its `--security-opt` list is
    exactly `no-new-privileges`, plus `seccomp=<seccompProfile>` only when the
    policy's browserSandbox is true (setup-vm.sh sets it after proving the
    launcher's ban on this kernel);
  - start, stop and rm -f update the egress address map around the operation
    (egress-map.py), so the proxy names every connection after its computer;
  - a container that does not exist is exit 3 and "missing" on stderr; any
    other inspect failure is exit 1, so a daemon hiccup never looks like a
    missing computer (which the app would recreate).
"""
import json
import os
import posixpath
import re
import subprocess
import sys

CONFIG = "/etc/juno/computer-broker.json"
DOCKER = "/usr/bin/docker"
NAME = re.compile(r"juno-agent-[A-Za-z0-9_-]{1,120}\Z")
AGENT_ID = re.compile(r"[A-Za-z0-9_-]{1,120}\Z")
LAUNCHER = "/opt/juno/agent-exec"
# RFC 5737 TEST-NET-1 (documentation; no resolver serves it): Docker's resolver
# forwards there, the firewall rejects port 53 to every address, and a lookup fails
# at once instead of tunnelling out.
DNS_SENTINEL = "192.0.2.53"
STATE_TMPFS = "/run/juno-state:rw,nosuid,nodev,noexec,size=64k,uid=1001,gid=1001,mode=0755"
EGRESS_MAP_HELPER = ["/usr/bin/python3", "-I", "/usr/local/sbin/juno-computers-egress-map"]
EGRESS_MAP_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
EXIT_MISSING = 3
IMAGE_FORMATS = ('{{index .Config.Labels "juno.security"}}', "{{.Id}}",
                 '{{.Id}}\t{{index .Config.Labels "juno.security"}}\t{{.Created}}')
# The provider's two listing calls, exactly (src/lib/computer/docker.ts listOwned).
PS_ARGV = ["ps", "-a", "--filter", "label=app=juno", "--format",
           '{{.Names}}\t{{.Label "juno.agent"}}\t{{.Label "juno.user"}}\t{{.State}}']
VOLUME_LS_ARGV = ["volume", "ls", "--filter", "name=juno-agent-", "--format", "{{.Name}}"]


def agent_workdir(value):
    """A working directory inside the agent's home: absolute, normalized, no
    `..`, no control characters. The provider resolves it with realpath as uid
    1000 first; this is the broker refusing anything else on its own."""
    if not value.startswith("/") or any(ord(c) < 32 for c in value) or len(value) > 4096:
        return False
    if posixpath.normpath(value) != value or "/../" in value + "/":
        return False
    return value == "/home/agent" or value.startswith("/home/agent/")


def security_options(policy):
    """Exactly the `--security-opt` values a create must carry. The seccomp
    profile that lets Chromium's own sandbox create user namespaces is used
    only when setup-vm.sh proved, on this host, that the agent launcher's ban
    still holds under it (browserSandbox true and an absolute profile path)."""
    if policy.get("browserSandbox") is True:
        profile = policy.get("seccompProfile")
        if not isinstance(profile, str) or not profile.startswith("/") or "\n" in profile:
            raise ValueError("browserSandbox needs an absolute seccompProfile")
        return ["no-new-privileges", "seccomp=" + profile]
    return ["no-new-privileges"]


def launcher_command(command):
    """What follows the container name in an exec as the agent's uid."""
    if command[:1] != [LAUNCHER]:
        raise ValueError("Agent commands must start through the agent launcher")
    mode = command[1:]
    if mode in (["freeze"], ["thaw"]):
        return
    if len(mode) >= 3 and mode[0] in ("run", "helper") and mode[1] == "--" and mode[2]:
        return
    raise ValueError("Unknown agent launcher mode")


def validate(argv, policy):
    if not argv:
        raise ValueError("Missing operation")
    operation = argv[0]
    if operation == "image" and len(argv) == 5 and argv[1:3] == ["inspect", "--format"] and argv[3] in IMAGE_FORMATS \
            and argv[4] == policy["image"]:
        return None
    if argv == PS_ARGV or argv == VOLUME_LS_ARGV:
        return None
    if operation == "volume" and len(argv) == 7 and argv[1:3] == ["create", "--label"] and argv[3] == "app=juno" and argv[4] == "--label":
        # The agent's home and browser-profile volumes, labelled with their agent.
        label, name = argv[5], argv[6]
        agent = label.removeprefix("juno.agent=")
        if label.startswith("juno.agent=") and AGENT_ID.fullmatch(agent) and name in ("juno-agent-" + agent, "juno-agent-" + agent + "-browser"):
            return None
        raise ValueError("Volume name and agent label do not match")
    if operation == "volume" and len(argv) == 4:
        if argv[1:3] == ["rm", "-f"] and NAME.fullmatch(argv[3]):
            return None
    if operation in {"start", "stop", "pause", "unpause"} and len(argv) == 2 and NAME.fullmatch(argv[1]):
        return argv[1]
    if operation == "rm" and len(argv) == 3 and argv[1] == "-f" and NAME.fullmatch(argv[2]):
        return argv[2]
    if operation == "inspect" and len(argv) == 4 and argv[1] == "-f" and NAME.fullmatch(argv[3]):
        formats = {"{{.State.Status}}", "{{.Image}}", '{{(index .NetworkSettings.Networks "' + policy["network"] + '").IPAddress}}'}
        if argv[2] in formats:
            return argv[3]
    if operation == "exec":
        index = 1
        if index < len(argv) and argv[index] == "-i":
            index += 1
        if argv[index:index + 2] not in (["--user", "1000"], ["--user", "1001"]):
            raise ValueError("Exec requires an unprivileged numeric user")
        user = argv[index + 1]
        index += 2
        while argv[index:index + 1] in (["-e"], ["--workdir"]):
            if argv[index] == "-e" and argv[index + 1] not in {"DISPLAY=:0", "HOME=/home/agent"}:
                raise ValueError("Exec environment is not permitted")
            if argv[index] == "--workdir" and not agent_workdir(argv[index + 1]):
                raise ValueError("Exec working directory must stay inside /home/agent")
            index += 2
        if index + 1 < len(argv) and NAME.fullmatch(argv[index]):
            if user == "1000":
                launcher_command(argv[index + 1:])
            return argv[index]
    if operation == "create":
        flags = {}
        index = 1
        boolean = {"--read-only"}
        allowed = {"--name", "--hostname", "--network", "--dns", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--shm-size", "--cap-drop", "--security-opt", "--tmpfs", "--mount", "--label", "--restart", "--stop-timeout"}
        while index < len(argv) - 1:
            key = argv[index]
            if key in boolean:
                value = True
                index += 1
            elif key in allowed and index + 1 < len(argv) - 1:
                value = argv[index + 1]
                index += 2
            else:
                raise ValueError("Unknown create option")
            flags.setdefault(key, []).append(value)
        if argv[-1] != policy["image"]:
            raise ValueError("Unapproved image")
        name = flags.get("--name", [""])[0]
        if not NAME.fullmatch(name):
            raise ValueError("Invalid container name")
        fixed = {
            "--name": [name], "--hostname": ["computer"], "--network": [policy["network"]],
            "--dns": [DNS_SENTINEL], "--pids-limit": ["2048"], "--shm-size": ["1g"],
            "--cap-drop": ["ALL"], "--security-opt": security_options(policy), "--read-only": [True],
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m",
                        "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700", STATE_TMPFS,
                        "/var/tmp:rw,nosuid,nodev,size=256m"],
            "--mount": [f"type=volume,source={name},target=/home/agent", f"type=volume,source={name}-browser,target=/home/browser"],
            "--restart": ["no"], "--stop-timeout": ["20"],
        }
        for key, expected in fixed.items():
            if flags.get(key) != expected:
                raise ValueError("Sandbox requirement missing: " + key)
        for key in ("--memory", "--memory-swap"):
            value = flags.get(key, [])
            if len(value) != 1 or not re.fullmatch(r"[0-9]+m", value[0]) or not 128 <= int(value[0][:-1]) <= policy["maxMemoryMb"]:
                raise ValueError("Invalid memory limit")
        if flags["--memory"] != flags["--memory-swap"]:
            raise ValueError("Swap must remain bounded")
        cpu = flags.get("--cpus", [])
        if len(cpu) != 1 or not 0 < float(cpu[0]) <= policy["maxCpus"]:
            raise ValueError("Invalid CPU limit")
        labels = flags.get("--label", [])
        if len(labels) != 3 or labels[0] != "app=juno" or labels[1] != "juno.agent=" + name.removeprefix("juno-agent-") or not re.fullmatch(r"juno.user=[A-Za-z0-9_-]{1,120}", labels[2]):
            raise ValueError("Invalid ownership labels")
        return None
    raise ValueError("Operation is not permitted")


class Missing(Exception):
    """The container does not exist (Docker said so, in so many words)."""


ENVIRONMENT = {"PATH": "/usr/bin:/bin", "HOME": "/root"}


def check_namespace(target):
    """Fails closed: a container that cannot be inspected is refused rather
    than operated on unchecked. Missing (exit 3) and every other failure
    (exit 1) are told apart, so the provider never recreates a computer
    because the daemon hiccuped."""
    inspected = subprocess.run([DOCKER, "inspect", "--type", "container", "-f", '{{index .Config.Labels "app"}}', target],
                               env=ENVIRONMENT, capture_output=True, text=True)
    if inspected.returncode != 0:
        if re.search(r"no such (container|object)", inspected.stderr, re.IGNORECASE):
            raise Missing()
        raise ValueError("Container could not be inspected")
    if inspected.stdout.strip() != "juno":
        raise ValueError("Container is outside the Juno namespace")


def egress_map(*arguments):
    """Runs the address-map helper; True when it succeeded."""
    try:
        return subprocess.run(EGRESS_MAP_HELPER + list(arguments), env=EGRESS_MAP_ENV, capture_output=True,
                              timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def run_docker(argv):
    return subprocess.run([DOCKER] + argv, env=ENVIRONMENT).returncode


def dispatch(argv):
    """start, stop and rm -f run as a child between address-map updates (D19);
    everything else replaces this process with docker, as before."""
    operation = argv[0]
    if operation == "start":
        # A computer that stopped on its own must not leave its address to the
        # next computer that gets it: rebuild before, or refuse to start.
        if not egress_map("rebuild"):
            raise ValueError("The egress address map could not be updated")
        code = run_docker(argv)
        if not egress_map("rebuild"):
            print("computer broker: the egress address map was not rebuilt after start", file=sys.stderr)
        return code
    if operation in ("stop", "rm"):
        name = argv[-1]
        if not egress_map("release", name):
            print("computer broker: the egress address map could not release the computer", file=sys.stderr)
        code = run_docker(argv)
        if not egress_map("rebuild"):
            print("computer broker: the egress address map was not rebuilt", file=sys.stderr)
        return code
    os.execve(DOCKER, [DOCKER] + argv, ENVIRONMENT)
    return 1  # not reached


def main():
    # sudo's environment reset and this fixed environment prevent DOCKER_HOST,
    # DOCKER_CONFIG, PATH or plugin injection from selecting a different daemon.
    with open(CONFIG, encoding="utf-8") as file:
        policy = json.load(file)
    argv = sys.argv[1:]
    target = validate(argv, policy)
    if target:
        check_namespace(target)
    return dispatch(argv)


def run_cli():
    """The broker's exit status: docker's own, 3 for a missing container, 1 for a refusal."""
    try:
        return main()
    except Missing:
        print("computer broker refused request: missing (No such container)", file=sys.stderr)
        return EXIT_MISSING
    except (ValueError, IndexError, KeyError, OSError) as error:
        print("computer broker refused request: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run_cli())
