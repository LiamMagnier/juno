#!/usr/bin/python3
"""Root-owned, narrow sudo broker. Never exposes the Docker socket to Juno.

Only agent container lifecycle and exec are permitted. Creation accepts the
fixed sandbox mounts/network/security controls and bounded resource values.
The policy file and this executable must be writable only by root.
"""
import json
import os
import re
import subprocess
import sys

CONFIG = "/etc/juno/computer-broker.json"
DOCKER = "/usr/bin/docker"
NAME = re.compile(r"juno-agent-[A-Za-z0-9_-]{1,120}\Z")


def validate(argv, policy):
    if not argv:
        raise ValueError("Missing operation")
    operation = argv[0]
    if operation == "image" and argv[1:] == ["inspect", "--format", '{{index .Config.Labels "juno.security"}}', policy["image"]]:
        return None
    if operation == "volume" and len(argv) in (3, 4):
        if argv[1] == "create" and len(argv) == 3 and NAME.fullmatch(argv[2]):
            return None
        if argv[1:3] == ["rm", "-f"] and len(argv) == 4 and NAME.fullmatch(argv[3]):
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
        while argv[index:index + 1] == ["-e"]:
            if argv[index + 1] not in {"DISPLAY=:0", "HOME=/home/agent"}:
                raise ValueError("Exec environment is not permitted")
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
            "--tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=64m", "/var/tmp:rw,nosuid,nodev,size=256m"],
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
        inspected = subprocess.run([DOCKER, "inspect", "-f", '{{index .Config.Labels "app"}}', target],
                                   env=environment, capture_output=True, text=True)
        if inspected.returncode == 0 and inspected.stdout.strip() != "juno":
            raise ValueError("Container is outside the Juno namespace")
    os.execve(DOCKER, [DOCKER] + argv, environment)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, IndexError, KeyError, OSError) as error:
        print("computer broker refused request: " + str(error), file=sys.stderr)
        sys.exit(1)
