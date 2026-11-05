"""Chromium's processes inside an agent's computer, as the browser uid (1001) sees them.

Run inside the computer with `python3 -c <this file's text>` by both real-container
suites (tests/test_computer_boundary.py and tests/computer-real-e2e.test.ts), so they
find the browser the same way. Prints one JSON object:

  self       this process's user namespace (an exec as 1001 shares the gate's: the gate
             is non-dumpable, so its own /proc links cannot be read)
  browser    the arguments of each Chromium process the CDP gate started (its direct
             children; there is one)
  renderers  how many renderer processes run
  rendererNamespaces  the user namespaces they run in (those readable)

A process is Chromium's by the name of its binary, whatever the image calls it: the
Debian package's /usr/lib/chromium/chromium (the image deploy/agent-computers builds)
or Chrome for Testing's .../chrome (a local build where no Debian mirror is reachable).
Never by a pattern over the whole command line, which would also match this probe's.
A process the zygote forks sets its title as one space-separated string, so the
command line is split on NULs and spaces alike.
"""
import json
import os

BROWSER_BINARIES = ("chrome", "chromium")
GATE = "/opt/juno/cdp-gate.py"
ME = str(os.getpid())


def arguments(pid):
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as file:
            return file.read().replace(b"\0", b" ").decode("utf-8", "replace").split()
    except OSError:
        return []


def status(pid):
    fields = {}
    try:
        with open("/proc/%s/status" % pid) as file:
            for line in file:
                key, _, value = line.partition(":")
                fields[key] = value.split()
    except OSError:
        pass
    return fields


def user_namespace(pid):
    try:
        return os.readlink("/proc/%s/ns/user" % pid)
    except OSError:
        return None


def is_chromium(args):
    return bool(args) and os.path.basename(args[0]) in BROWSER_BINARIES


processes = {}
for pid in os.listdir("/proc"):
    if pid.isdigit() and pid != ME:
        fields = status(pid)
        if fields.get("Uid", [None, None])[1:2] == ["1001"]:  # effective uid, as `pgrep -u` matches
            processes[pid] = (arguments(pid), (fields.get("PPid") or [None])[0])

gates = [pid for pid, (args, _) in processes.items() if GATE in args]
browser = [args for pid, (args, parent) in processes.items()
           if parent in gates and is_chromium(args) and not any(arg.startswith("--type=") for arg in args)]
renderers = [pid for pid, (args, _) in processes.items() if is_chromium(args) and "--type=renderer" in args]
print(json.dumps({
    "self": user_namespace("self"),
    "gates": len(gates),
    "browser": browser,
    "renderers": len(renderers),
    "rendererNamespaces": sorted({user_namespace(pid) for pid in renderers} - {None}),
}))
