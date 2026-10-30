#!/usr/bin/python3 -I
"""Disconnect the agent's X clients at take over (pipe-v4, COMPUTERS_2026-10.md D3).

    python3 -I /opt/juno/x-clients.py close-uid 1000     (run as the browser uid)
    python3 -I /opt/juno/x-clients.py release-all        (every held key and button)
    python3 -I /opt/juno/x-clients.py list               (diagnostics: pid, uid)

Asks the X server which clients are connected and which process each one is
(the X-Resource extension's QueryClientIds; Xvfb fills the PID from the Unix
socket's peer credentials, so a renamed or copied program cannot hide), and
calls XKillClient on every client whose process belongs to the given uid. A
stopped `xdotool type` that is resumed at hand back finds its connection gone
and exits: it can never finish typing into the field the person left focused.

Prints one JSON line: {"closed": n, "kept": n, "withoutPid": n}. Exit codes:
0 done; 4 the server does not report client PIDs; 2 usage; 1 any other failure.

release-all asks the server which keys and pointer buttons are down and sends
a release (XTEST) for each. A typer stopped between a key's press and its
release leaves that key down, and the server's autorepeat would go on typing
it into the person's session; a chord or drag cut half way would leave a
modifier or button held. Prints {"keys": n, "buttons": n}.
"""
import json
import os
import sys

LOCAL_CLIENT_PID_MASK = 1 << 1


def uid_of(pid):
    try:
        with open("/proc/%d/status" % pid) as status:
            for line in status:
                if line.startswith("Uid:"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        return None
    return None


def client_pids(display):
    """[(client resource base, pid or None)] for every client but this one."""
    if display.query_extension("X-Resource") is None:
        raise LookupError("X-Resource")
    reply = display.res_query_client_ids([{"client": 0, "mask": LOCAL_CLIENT_PID_MASK}])
    found = {}
    for entry in reply.ids:
        spec = entry.spec
        if spec.mask & LOCAL_CLIENT_PID_MASK and entry.value:
            found[spec.client] = int(entry.value[0])
    clients = display.res_query_clients().clients
    own = display.display.info.resource_id_base
    return [(client.resource_base, found.get(client.resource_base))
            for client in clients if client.resource_base != own]


def release_all(display):
    from Xlib import X
    from Xlib.ext import xtest

    keymap = display.query_keymap()
    keys = 0
    for index, byte in enumerate(keymap):
        for bit in range(8):
            if byte & (1 << bit):
                xtest.fake_input(display, X.KeyRelease, index * 8 + bit)
                keys += 1
    mask = display.screen().root.query_pointer().mask
    buttons = 0
    for number, flag in ((1, X.Button1Mask), (2, X.Button2Mask), (3, X.Button3Mask), (4, X.Button4Mask), (5, X.Button5Mask)):
        if mask & flag:
            xtest.fake_input(display, X.ButtonRelease, number)
            buttons += 1
    display.sync()
    return {"keys": keys, "buttons": buttons}


def main(argv):
    usage = (len(argv) < 2 or argv[1] not in ("close-uid", "list", "release-all")
             or (argv[1] == "close-uid" and len(argv) != 3) or (argv[1] != "close-uid" and len(argv) != 2))
    if usage:
        sys.stderr.write(__doc__)
        return 2
    from Xlib import display as xdisplay  # python3-xlib
    from Xlib.protocol import request

    display = xdisplay.Display(os.environ.get("DISPLAY", ":0"))
    if argv[1] == "release-all":
        if display.query_extension("XTEST") is None:
            sys.stderr.write("x-clients: the X server has no XTEST\n")
            return 1
        print(json.dumps(release_all(display)))
        display.close()
        return 0
    try:
        pairs = client_pids(display)
    except LookupError:
        sys.stderr.write("x-clients: the X server does not report client PIDs\n")
        return 4
    if argv[1] == "list":
        print(json.dumps([{"pid": pid, "uid": uid_of(pid) if pid else None} for _, pid in pairs]))
        return 0
    target = int(argv[2])
    closed = kept = without = 0
    for base, pid in pairs:
        if pid is None:
            without += 1
            continue
        if uid_of(pid) == target:
            # XKillClient: the server closes that client's connection.
            request.KillClient(display=display.display, resource=base)
            closed += 1
        else:
            kept += 1
    display.sync()
    display.close()
    print(json.dumps({"closed": closed, "kept": kept, "withoutPid": without}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # a connection refused, a protocol error
        sys.stderr.write("x-clients: %s\n" % type(error).__name__)
        sys.exit(1)
