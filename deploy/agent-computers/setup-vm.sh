#!/bin/bash
# One-time, idempotent setup of agent computers on the Juno VM. The owner runs it
# after deploying the release that contains it:
#   ssh <vm> 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
# Re-run it after changing the Dockerfile to rebuild the image.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"
RUN_USER="${SUDO_USER:-liammgnr}"
IMAGE="${COMPUTER_DOCKER_IMAGE:-juno-computer:1}"
NET=juno-computers
SUBNET=172.30.0.0/24
BRIDGE=br-juno

echo "==> Docker"
systemctl enable --now docker
id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$RUN_USER"

echo "==> Network $NET ($SUBNET, bridge $BRIDGE, no container-to-container traffic)"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create \
  --driver bridge --subnet "$SUBNET" \
  -o com.docker.network.bridge.name="$BRIDGE" \
  -o com.docker.network.bridge.enable_icc=false \
  "$NET"

echo "==> Firewall"
install -m 0755 "$HERE/firewall.sh" /usr/local/sbin/juno-computers-firewall
cat > /etc/systemd/system/juno-computers-firewall.service <<'UNIT'
[Unit]
Description=Firewall for Juno agent computers
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/juno-computers-firewall

[Install]
WantedBy=multi-user.target docker.service
UNIT
systemctl daemon-reload
systemctl enable juno-computers-firewall.service
systemctl restart juno-computers-firewall.service

echo "==> Image $IMAGE"
docker build --pull -t "$IMAGE" "$HERE"

echo
echo "Agent computers are ready on this server."
echo "Turn them on:  cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload   (value: docker)"
