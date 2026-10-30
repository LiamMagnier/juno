#!/usr/bin/python3 -I
"""/opt/juno/agent-exec: the only way an agent (uid 1000) command starts in a computer.

The broker (docker-broker.py) refuses every `docker exec --user 1000` whose
command does not begin with this file, so every process the agent's uid ever
runs descends from one of these modes, and carries what they install:

  agent-exec run -- <argv...>     model-driven work: the shell, the five input
                                  methods, the agent's own file writes. Refused
                                  with exit 75 ("frozen") while a person has
                                  control (the marker /run/juno-state/frozen,
                                  which only the browser uid can write).
  agent-exec helper -- <argv...>  the provider's own reads (realpath, stat,
                                  find, head, du, the screenshot) and a file the
                                  person uploads. No frozen check, so the
                                  person's file browser works while they drive.
  agent-exec freeze               SIGSTOP every uid-1000 process but this one,
                                  until a /proc scan finds none running.
  agent-exec thaw                 SIGCONT every uid-1000 process.

In every mode, before anything else runs:
  1. A seccomp filter is stacked on top of the container's profile: unshare and
     setns fail with EPERM, clone with any CLONE_NEW* flag fails with EPERM, and
     clone3 fails with ENOSYS (libc then falls back to clone, which is checked).
     Filters are inherited by every child and survive execve, so nothing the
     agent starts can create a user namespace, the way into every capability.
     That ban is what lets Chromium's own sandbox (which needs user namespaces
     for the browser uid) be switched on safely; see COMPUTERS_2026-10.md D13.
     System calls of another ABI (32-bit x86, x32) kill the process.
  2. The environment is replaced by a fixed one. Nothing passes through, so no
     BASH_ENV, ENV, LD_PRELOAD, PYTHON* or exported bash function survives, and
     ~/.local/bin is LAST on PATH, so a planted ~/.local/bin/ls never shadows
     /usr/bin/ls.

The interpreter runs isolated (-I): no PYTHON* variables, no user site-packages
under the agent-writable ~/.local, no script directory on sys.path. So nothing
the agent can write runs before the filter is in place.
"""
import errno
import os
import signal
import sys
import time

AGENT_UID = 1000
FROZEN = "/run/juno-state/frozen"
PROXY = "http://172.30.0.1:3128"
ENVIRONMENT = {
    "HOME": "/home/agent",
    "USER": "agent",
    "LOGNAME": "agent",
    "PATH": "/usr/local/bin:/usr/bin:/bin:/home/agent/.local/bin",
    "LANG": "C.UTF-8",
    "DISPLAY": ":0",
    "TERM": "dumb",
    "HTTP_PROXY": PROXY,
    "HTTPS_PROXY": PROXY,
    "http_proxy": PROXY,
    "https_proxy": PROXY,
    # Debian marks its Python externally managed, which also blocks
    # `pip install --user`. The root filesystem is read-only and there is no
    # root here, so only the agent's own ~/.local is ever written.
    "PIP_BREAK_SYSTEM_PACKAGES": "1",
    "NPM_CONFIG_PREFIX": "/home/agent/.local",
}
# CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER,
# CLONE_NEWPID, CLONE_NEWNET (linux/sched.h).
NAMESPACE_FLAGS = (0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000)
EX_FROZEN = 75
FREEZE_ROUNDS = 10
FREEZE_PAUSE_SECONDS = 0.05


def refuse(message, code=126):
    sys.stderr.write("agent-exec: %s\n" % message)
    sys.stderr.flush()
    os._exit(code)


def ban_namespaces():
    """The stacked filter. Default allow: the container's own profile still
    applies underneath, and the stricter answer of the two always wins."""
    import seccomp  # python3-seccomp, root-owned in the read-only image

    rules = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
    for name in ("unshare", "setns"):
        rules.add_rule(seccomp.ERRNO(errno.EPERM), name)
    # The flags are clone's first argument on x86_64 and aarch64.
    for flag in NAMESPACE_FLAGS:
        rules.add_rule(seccomp.ERRNO(errno.EPERM), "clone", seccomp.Arg(0, seccomp.MASKED_EQ, flag, flag))
    # clone3 passes its flags in memory, which seccomp cannot read.
    rules.add_rule(seccomp.ERRNO(errno.ENOSYS), "clone3")
    rules.load()


def agent_tasks_not_stopped(own_pid):
    """Every uid-1000 thread in this container that is not stopped (T, t) or
    gone (Z, X), other than this process."""
    running = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == own_pid:
            continue
        try:
            tasks = os.listdir("/proc/%s/task" % pid)
        except OSError:
            continue
        for tid in tasks:
            try:
                with open("/proc/%s/task/%s/status" % (pid, tid)) as status:
                    fields = dict(line.split(":", 1) for line in status if ":" in line)
            except OSError:
                continue  # it ended between the listing and the read
            real_uid = int(fields.get("Uid", "-1").split()[0])
            state = fields.get("State", "?").split()[0]
            if real_uid == AGENT_UID and state not in ("T", "t", "Z", "X"):
                running.append(int(tid))
    return running


def freeze():
    """kill(-1, SIGSTOP) signals every process this uid may signal except the
    caller (and the namespace's init, which is the browser's). The kernel walks
    the set under the task-list lock; a fork caught in progress hands the
    signal to its child or is restarted. The scan is what this relies on: it
    repeats until no uid-1000 task outside state T is left, or gives up."""
    own = os.getpid()
    for _ in range(FREEZE_ROUNDS):
        try:
            os.kill(-1, signal.SIGSTOP)
        except ProcessLookupError:
            pass  # nothing of this uid is running
        time.sleep(FREEZE_PAUSE_SECONDS)
        left = agent_tasks_not_stopped(own)
        if not left:
            return 0
    sys.stderr.write("agent-exec: %d task(s) still running after the freeze\n" % len(left))
    return 3


def thaw():
    try:
        os.kill(-1, signal.SIGCONT)
    except ProcessLookupError:
        pass
    return 0


def main(argv):
    if os.getuid() != AGENT_UID or os.geteuid() != AGENT_UID:
        refuse("runs only as the agent user")
    mode = argv[1] if len(argv) > 1 else ""
    if mode in ("run", "helper"):
        if len(argv) < 4 or argv[2] != "--" or not argv[3]:
            refuse("usage: agent-exec %s -- <command> [args...]" % mode, 64)
    elif mode not in ("freeze", "thaw") or len(argv) != 2:
        refuse("usage: agent-exec run|helper -- <command> [args...] | freeze | thaw", 64)
    try:
        ban_namespaces()
    except Exception as error:  # never run anything without the ban
        refuse("could not install the namespace ban (%s)" % type(error).__name__)
    if mode == "freeze":
        return freeze()
    if mode == "thaw":
        return thaw()
    if mode == "run" and os.path.lexists(FROZEN):
        sys.stderr.write("frozen\n")
        return EX_FROZEN
    try:
        # Without --workdir, docker exec starts in the image's WORKDIR (the
        # browser's home, which this uid cannot enter): start at home instead.
        if not (os.getcwd() + "/").startswith("/home/agent/"):
            os.chdir("/home/agent")
    except OSError:
        os.chdir("/home/agent")
    try:
        os.execvpe(argv[3], argv[3:], ENVIRONMENT)
    except OSError as error:
        refuse("%s: %s" % (argv[3], os.strerror(error.errno or errno.ENOENT)), 127 if error.errno == errno.ENOENT else 126)
    return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv))
