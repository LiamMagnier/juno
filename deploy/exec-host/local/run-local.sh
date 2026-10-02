#!/bin/bash
# juno-exec on Docker Desktop, for development and the acceptance tests only.
#
#   bash deploy/exec-host/local/run-local.sh            # port 3178 by default
#   JUNO_EXEC_PORT=3177 JUNO_EXEC_DATA=/some/dir bash deploy/exec-host/local/run-local.sh
#
# Builds the sandbox image (cached after the first time), pins its image id in a
# developer broker policy, generates a token file once, and runs the service in
# the foreground on 127.0.0.1. The broker runs as a child process with the same
# argv validation as on the execution host (developer mode: not root, Docker
# Desktop's own socket). Point the web side at it with
#   CODE_INTERPRETER_URL=http://127.0.0.1:<port>
#   CODE_INTERPRETER_TOKEN=<contents of $JUNO_EXEC_DATA/token>
# Never use this profile on a shared host: it has no TLS and no firewall.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
PORT="${JUNO_EXEC_PORT:-3178}"
DATA="${JUNO_EXEC_DATA:-$HOME/.cache/juno-exec-dev}"
case "$PORT" in 317[0-9]) ;; *) echo "juno-exec local: use a port in 3170-3179" >&2; exit 2 ;; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "juno-exec local: port $PORT is already in use" >&2
  exit 2
fi
mkdir -p "$DATA/sessions"
DATA="$(cd "$DATA" && pwd -P)"
docker build -q -t juno-exec:dev "$HERE/../image" >/dev/null
IMAGE="$(docker image inspect juno-exec:dev --format '{{.Id}}')"
if [ ! -s "$DATA/token" ]; then
  (umask 077 && openssl rand -hex 32 > "$DATA/token")
fi
cat > "$DATA/policy.json" <<JSON
{"image": "$IMAGE", "sessionsRoot": "$DATA/sessions", "runUser": "1000:1000", "memoryMb": 1536, "cpus": "1",
 "pidsLimit": 256, "tmpfsSize": "256m", "runtime": null, "maxSkillMounts": 8}
JSON
export JUNO_EXEC_TOKEN_FILE="$DATA/token" JUNO_EXEC_POLICY="$DATA/policy.json" JUNO_EXEC_DATA="$DATA"
export JUNO_EXEC_PORT="$PORT" JUNO_EXEC_HOST=127.0.0.1 JUNO_EXEC_DOCKER="$(command -v docker)"
unset JUNO_EXEC_BROKER_SOCKET
exec python3 "$HERE/../juno-exec.py"
