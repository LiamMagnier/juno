#!/bin/bash
# The computer host smoke: run it on the host (or from the web VM) BEFORE allowlisting
# anyone, and after every --rebuild-image or --renew-tls. It drives one throwaway
# computer through the host's API and tunnels exactly as the app would, then removes it.
#
#   bash smoke.sh --token-file <file holding the token> [--url https://<host name>] [--ca <ca.pem>]
#
# Default URL: http://127.0.0.1:8750 (on the host itself, behind nginx). With --url
# https://<host name> it goes through nginx and TLS (pass --ca with the private CA when
# the host uses the default private TLS). Needs python3 with websockets 10.4 to 14.x
# (setup.sh installs python3-websockets). The token is read from the file, never from
# the command line. Exit status 0 only if every step passed; the computer is removed
# whatever happened.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
URL=http://127.0.0.1:8750 TOKEN_FILE="" CA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --ca) CA="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -r "$TOKEN_FILE" ] || { echo "smoke: --token-file must name a readable file holding the token" >&2; exit 2; }
exec "${JUNO_COMPUTER_HOST_PYTHON:-python3}" -I - "$URL" "$TOKEN_FILE" "$CA" <<'PY'
import asyncio, json, os, secrets, ssl, sys, time, urllib.error, urllib.request

url, token_file, ca = sys.argv[1:]
token = open(token_file).read().strip()
context = ssl.create_default_context(cafile=ca or None) if url.startswith("https:") else None
agent = "smoke" + secrets.token_hex(6)
name = "juno-agent-" + agent
failures = []


def call(method, path, body=None, raw=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else (b"" if method != "GET" else None))
    request = urllib.request.Request(url + path, data=data, method=method, headers={"Authorization": "Bearer " + token,
                                     "Content-Type": "application/octet-stream" if raw is not None else "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            payload = response.read()
            return response.status, payload
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def step(label, check):
    started = time.monotonic()
    try:
        note = check()
        print("ok   %-44s %5d ms %s" % (label, (time.monotonic() - started) * 1000, note or ""))
    except Exception as error:  # every step is reported, then the computer is removed
        failures.append(label)
        print("FAIL %-44s %s" % (label, error))


def expect(status, payload, wanted=200):
    if status != wanted:
        raise AssertionError("HTTP %d %s" % (status, payload[:200]))
    return json.loads(payload or b"null") if payload[:1] in (b"{", b"[", b"n") else payload


def health():
    data = expect(*call("GET", "/v1/health"))
    image = data.get("image") or {}
    if not image.get("current"):
        raise AssertionError("the image is missing or does not carry pipe-v4")
    return "image %s, %s days old, %s running, tls %s, source %s" % (image.get("id", "")[:19], image.get("ageDays"),
                                                                    data.get("running"), (data.get("tls") or {}).get("notAfter"), data.get("source"))


async def tunnel(port, cdp=None):
    import websockets.legacy.client as client
    ticket = expect(*call("POST", "/v1/computers/%s/tickets" % name, {"port": port}))["ticket"]
    headers = [("X-Juno-Tunnel-Ticket", ticket)] + ([("X-Juno-Cdp-Token", cdp)] if cdp else [])
    ws_url = url.replace("https:", "wss:").replace("http:", "ws:") + "/v1/tunnel"
    async with client.connect(ws_url, extra_headers=headers, ssl=context, max_size=64 << 20, open_timeout=20) as ws:
        if port == 9222:
            await ws.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
            return json.loads(await asyncio.wait_for(ws.recv(), 15))["result"]["product"]
        banner = await asyncio.wait_for(ws.recv(), 15)
        if not banner.startswith(b"RFB 003."):
            raise AssertionError("no RFB banner")
        return banner.decode().strip()


cdp_token = secrets.token_urlsafe(24)
step("health", health)
step("available", lambda: expect(*call("GET", "/v1/available")) == {"ok": True} or (_ for _ in ()).throw(AssertionError("not available")))
step("create", lambda: expect(*call("POST", "/v1/computers", {"agentId": agent, "userRef": "u_" + "0" * 32}))["name"])
step("start", lambda: expect(*call("POST", "/v1/computers/%s/start" % name)) and None)
step("provision the CDP token", lambda: expect(*call("PUT", "/v1/computers/%s/cdp-token" % name, raw=cdp_token.encode())) and None)
step("state is running", lambda: expect(*call("GET", "/v1/computers/%s/state" % name))["state"] == "running" or (_ for _ in ()).throw(AssertionError("not running")))
step("CDP through the tunnel", lambda: asyncio.run(tunnel(9222, cdp_token)))
step("exec", lambda: expect(*call("POST", "/v1/computers/%s/exec" % name, {"command": "echo smoke-ok", "timeoutSeconds": 30}))["stdout"].strip())
step("file round trip", lambda: (expect(*call("PUT", "/v1/computers/%s/files/content?path=/home/agent/work/smoke.txt" % name, raw=b"smoke-bytes")),
                                 expect(*call("GET", "/v1/computers/%s/files/content?path=/home/agent/work/smoke.txt" % name)))[1].decode())
step("screenshot", lambda: "%d bytes of PNG" % len(expect(*call("GET", "/v1/computers/%s/screenshot" % name))))
step("browser sandbox", lambda: expect(*call("GET", "/v1/computers/%s/browser-sandbox" % name))["state"])
step("VNC through the tunnel", lambda: (expect(*call("PUT", "/v1/computers/%s/vnc" % name, {"controlPassword": "Smoke123", "viewPassword": "Smoke456"})),
                                        asyncio.run(tunnel(5900)))[1])
step("freeze and thaw", lambda: (expect(*call("POST", "/v1/computers/%s/freeze" % name)), expect(*call("POST", "/v1/computers/%s/thaw" % name))) and None)
step("pause and unpause", lambda: (expect(*call("POST", "/v1/computers/%s/pause" % name)), expect(*call("POST", "/v1/computers/%s/unpause" % name))) and None)
step("stop", lambda: expect(*call("POST", "/v1/computers/%s/stop" % name)) and None)
status, payload = call("DELETE", "/v1/computers/%s?volumes=1" % name)
print(("ok   " if status == 200 else "FAIL ") + "remove the smoke computer and its volumes (HTTP %d)" % status)
if status != 200:
    failures.append("remove")
print("smoke: %s" % ("every step passed" if not failures else "FAILED: " + ", ".join(failures)))
sys.exit(1 if failures else 0)
PY
