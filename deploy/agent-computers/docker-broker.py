#!/usr/bin/python3
"""Root-owned, narrow sudo broker. Never exposes the Docker socket to Juno.

Only agent container lifecycle and exec are permitted. Creation accepts the
fixed sandbox mounts/network/security controls and bounded resource values.
The policy file and this executable must be writable only by root.
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


def validate(argv, policy):
    if not argv:
        raise ValueError("Missing operation")
    operation = argv[0]
    if operation == "image" and argv[1:] == ["inspect", "--format", '{{index .Config.Labels "juno.security"}}', policy["image"]]:
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
        formats = {"{{.State.Status}}", '{{(index .NetworkSettings.Networks "' + policy["network"] + '").IPAddress}}'}
        if argv[2] in formats:
            return argv[3]
    if operation == "exec":
        index = 1
        if index < len(argv) and argv[index] == "-i":
            index += 1
        if argv[index:index + 2] not in (["--user", "1000"], ["--user", "1001"]):
            raise ValueError("Exec requires an unprivileged numeric user")
        index += 2
        while argv[index:index + 1] in (["-e"], ["--workdir"]):
            if argv[index] == "-e" and argv[index + 1] not in {"DISPLAY=:0", "HOME=/home/agent"}:
                raise ValueError("Exec environment is not permitted")
            if argv[index] == "--workdir" and not agent_workdir(argv[index + 1]):
                raise ValueError("Exec working directory must stay inside /home/agent")
            index += 2
        if index + 1 < len(argv) and NAME.fullmatch(argv[index]):
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
            "--dns": ["1.1.1.1", "9.9.9.9"], "--pids-limit": ["2048"], "--shm-size": ["1g"],
            "--cap-drop": ["ALL"], "--security-opt": ["no-new-privileges"], "--read-only": [True],
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m",
                        "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700", "/var/tmp:rw,nosuid,nodev,size=256m"],
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


def main():
    # sudo's environment reset and this fixed environment prevent DOCKER_HOST,
    # DOCKER_CONFIG, PATH or plugin injection from selecting a different daemon.
    with open(CONFIG, encoding="utf-8") as file:
        policy = json.load(file)
    argv = sys.argv[1:]
    target = validate(argv, policy)
    environment = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
    if target:
        # Fails closed: a container that cannot be inspected (missing, or a
        # daemon error) is refused rather than operated on unchecked. Every
        # provider call that can meet a missing container tolerates the refusal.
        inspected = subprocess.run([DOCKER, "inspect", "--type", "container", "-f", '{{index .Config.Labels "app"}}', target],
                                   env=environment, capture_output=True, text=True)
        if inspected.returncode != 0 or inspected.stdout.strip() != "juno":
            raise ValueError("Container is missing or outside the Juno namespace")
    os.execve(DOCKER, [DOCKER] + argv, environment)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, IndexError, KeyError, OSError) as error:
        print("computer broker refused request: " + str(error), file=sys.stderr)
        sys.exit(1)
