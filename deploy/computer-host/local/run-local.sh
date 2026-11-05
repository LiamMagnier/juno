#!/bin/bash
# The computer host on this machine, for development and the acceptance tests only.
#
#   bash deploy/computer-host/local/run-local.sh            # plain http on 127.0.0.1:8750
#   bash deploy/computer-host/local/run-local.sh --nginx    # also TLS on 127.0.0.1:8443
#
# Runs the host service in the foreground on 127.0.0.1 with the broker as a child
# process in developer mode: the same validate() and namespace checks
# (deploy/agent-computers/docker-broker.py, host mode), the local Docker socket. It needs
# what deploy/agent-computers/setup-vm.sh (or the test fixture) puts on a machine: the
# juno-computers network, the egress proxy and the image (docker build -t juno-computer:1
# deploy/agent-computers). JUNO_EGRESS_MAP names the egress address map the broker
# updates around start, stop and remove; without it the hooks are skipped (development
# only, and said so).
#
# --nginx also serves the generated nginx config (setup.sh --print-nginx, the production
# file) in the official nginx image (docker run --network host) on 127.0.0.1:8443, with a
# private CA that can sign only `localhost` (private-tls.sh, the production default), so
# the tested path is the production path: TLS, the tunnel upgrade, the exec timeouts.
# The nginx container is removed when this script stops.
#
# The token (64 hex) is generated once into $JUNO_COMPUTER_HOST_DATA/token (0600) and only
# its hash is in the tokens file, namespace `dev`. Point the app at it with
#   COMPUTER_PROVIDER=remote
#   COMPUTER_HOST_URL=http://127.0.0.1:8750        (or https://localhost:8443 with --nginx)
#   COMPUTER_HOST_TOKEN=<contents of $JUNO_COMPUTER_HOST_DATA/token>
#   NODE_EXTRA_CA_CERTS=$JUNO_COMPUTER_HOST_DATA/tls/ca.pem   (--nginx; app, runner, relay)
#   RELAY_COMPUTER_HOSTS=<the same URL>                        (the relay)
# Never use this profile on a shared host: no firewall, no systemd sandboxing.
#
# Environment: JUNO_COMPUTER_HOST_DATA (default ~/.cache/juno-computer-host-dev),
# JUNO_COMPUTER_HOST_PYTHON (a python3 with websockets 10.4 to 14.x; default python3),
# JUNO_COMPUTER_HOST_API_PORT (8750), JUNO_COMPUTER_HOST_TUNNEL_PORT (8751),
# JUNO_COMPUTER_HOST_TLS_PORT (8443), COMPUTER_MEMORY_MB (1024 here),
# COMPUTER_MIN_FREE_MEMORY_MB (512), COMPUTER_MIN_FREE_DISK_MB (2048),
# JUNO_COMPUTER_HOST_MAX_RUNNING (2), JUNO_COMPUTER_SECCOMP_PROFILE (an absolute profile
# path turns Chromium's own sandbox on, as setup-vm.sh would after its probe).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
HOST_DIR="$(cd "$HERE/.." && pwd -P)"
NGINX=0
case "${1:-}" in
  "") ;;
  --nginx) NGINX=1 ;;
  *) echo "usage: run-local.sh [--nginx]" >&2; exit 2 ;;
esac
DATA="${JUNO_COMPUTER_HOST_DATA:-$HOME/.cache/juno-computer-host-dev}"
PYTHON="${JUNO_COMPUTER_HOST_PYTHON:-python3}"
API_PORT="${JUNO_COMPUTER_HOST_API_PORT:-8750}"
TUNNEL_PORT="${JUNO_COMPUTER_HOST_TUNNEL_PORT:-8751}"
TLS_PORT="${JUNO_COMPUTER_HOST_TLS_PORT:-8443}"
NGINX_NAME=juno-computer-host-nginx
NGINX_IMAGE="${JUNO_COMPUTER_HOST_NGINX_IMAGE:-nginx:1.27-alpine}"

"$PYTHON" - <<'PY'
import sys
try:
    import websockets
except ImportError:
    sys.exit("run-local: this python has no websockets; set JUNO_COMPUTER_HOST_PYTHON to a venv with websockets==10.4")
version = tuple(int(part) for part in websockets.__version__.split(".")[:2])
if not (10, 4) <= version < (15, 0):
    sys.exit("run-local: websockets %s is outside [10.4, 15)" % websockets.__version__)
PY
docker network inspect juno-computers >/dev/null 2>&1 || { echo "run-local: no juno-computers network (setup-vm.sh or the test fixture creates it)" >&2; exit 2; }
docker image inspect juno-computer:1 >/dev/null 2>&1 || { echo "run-local: build the image first: docker build -t juno-computer:1 deploy/agent-computers" >&2; exit 2; }

mkdir -p "$DATA"
DATA="$(cd "$DATA" && pwd -P)"
chmod 0700 "$DATA"
if [ ! -s "$DATA/token" ]; then
  (umask 077 && openssl rand -hex 32 > "$DATA/token")
fi
"$PYTHON" - "$DATA" <<'PY'
import hashlib, json, os, sys
data = sys.argv[1]
token = open(os.path.join(data, "token")).read().strip()
with open(os.path.join(data, "tokens.json"), "w") as file:
    json.dump([{"id": "dev-1", "sha256": hashlib.sha256(token.encode()).hexdigest(), "namespace": "dev"}], file)
PY
chmod 0600 "$DATA/tokens.json"

SECCOMP="${JUNO_COMPUTER_SECCOMP_PROFILE:-}"
"$PYTHON" - "$DATA" "$SECCOMP" <<'PY'
import json, os, sys
data, seccomp = sys.argv[1:]
policy = {"image": "juno-computer:1", "network": "juno-computers", "maxMemoryMb": 2048, "maxCpus": 2,
          "browserSandbox": bool(seccomp)}
if seccomp:
    policy["seccompProfile"] = seccomp
json.dump(policy, open(os.path.join(data, "broker-policy.json"), "w"))
PY

TLS_CERT=null
if [ "$NGINX" = 1 ]; then
  bash "$HOST_DIR/private-tls.sh" localhost "$DATA/tls" >/dev/null
  TLS_CERT="\"$DATA/tls/cert.pem\""
fi
EGRESS_MAP="${JUNO_EGRESS_MAP:-none}"
[ "$EGRESS_MAP" = none ] && echo "run-local: JUNO_EGRESS_MAP is not set; the egress-map hooks are skipped (development only)" >&2
cat > "$DATA/config.json" <<JSON
{"image": "juno-computer:1", "network": "juno-computers", "memoryMb": ${COMPUTER_MEMORY_MB:-1024}, "cpus": 2,
 "minFreeMemMb": ${COMPUTER_MIN_FREE_MEMORY_MB:-512}, "minFreeDiskMb": ${COMPUTER_MIN_FREE_DISK_MB:-2048},
 "maxRunning": ${JUNO_COMPUTER_HOST_MAX_RUNNING:-2}, "apiPort": $API_PORT, "tunnelPort": $TUNNEL_PORT,
 "tokensFile": "$DATA/tokens.json", "brokerPolicy": "$DATA/broker-policy.json", "dockerRoot": "/",
 "developerBroker": {"policy": "$DATA/broker-policy.json", "egressMap": "$EGRESS_MAP", "docker": "$(command -v docker)"},
 "tlsCertificate": $TLS_CERT}
JSON

cleanup() {
  [ "$NGINX" = 1 ] && docker rm -f "$NGINX_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$NGINX" = 1 ]; then
  bash "$HOST_DIR/setup.sh" --print-nginx --domain localhost --cert /etc/juno-tls/cert.pem --key /etc/juno-tls/key.pem \
    --listen "127.0.0.1:$TLS_PORT" --api-port "$API_PORT" --tunnel-port "$TUNNEL_PORT" \
    --access-log /var/log/nginx/access.log --error-log /var/log/nginx/error.log > "$DATA/nginx.conf"
  docker rm -f "$NGINX_NAME" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NGINX_NAME" --network host \
    -v "$DATA/nginx.conf:/etc/nginx/conf.d/default.conf:ro" -v "$DATA/tls:/etc/juno-tls:ro" "$NGINX_IMAGE" >/dev/null
  echo "run-local: nginx (TLS) on https://localhost:$TLS_PORT, CA $DATA/tls/ca.pem" >&2
fi
echo "run-local: host on http://127.0.0.1:$API_PORT (tunnels :$TUNNEL_PORT), token in $DATA/token, namespace dev" >&2
# A clean environment: nothing of the developer's shell (an .env with the
# database URL or provider keys) reaches the host, which refuses to start with
# any app secret anyway.
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 "$PYTHON" -I "$HOST_DIR/juno-computer-host.py" --config "$DATA/config.json"
