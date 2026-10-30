#!/bin/bash
# One-time, idempotent setup of agent computers on the Juno VM. The owner runs it
# after deploying the release that contains it:
#   ssh <vm> 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
# Re-run it after changing the Dockerfile to rebuild the image.
#
# Owner-tunable (docs/OPEN_DECISIONS.md, "owner to confirm"):
#   JUNO_EGRESS_MAX_MB_PER_HOUR   per computer, both directions, rolling hour (1024)
#   JUNO_EGRESS_LOG_DAYS          days of the egress log logrotate keeps (14)
#   JUNO_COMPUTER_BROWSER_SANDBOX auto (default): Chromium's own sandbox comes on
#                                 only if this kernel allows user namespaces in a
#                                 container AND the agent launcher's ban holds
#                                 under that profile (both probed below); off:
#                                 never (Docker's default profile, as pipe-v3)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd -P)"
RUN_USER="${SUDO_USER:-liammgnr}"
# The tag `src/lib/env.ts` defaults to (`agentComputer.image`). Keep them equal.
IMAGE="${COMPUTER_DOCKER_IMAGE:-juno-computer:1}"
NET=juno-computers
SUBNET=172.30.0.0/24
BRIDGE=br-juno
MAX_MB_PER_HOUR="${JUNO_EGRESS_MAX_MB_PER_HOUR:-1024}"
LOG_DAYS="${JUNO_EGRESS_LOG_DAYS:-14}"
BROWSER_SANDBOX="${JUNO_COMPUTER_BROWSER_SANDBOX:-auto}"
SECCOMP=/etc/juno/computer-seccomp.json
[[ "$MAX_MB_PER_HOUR" =~ ^[1-9][0-9]{0,6}$ ]] || { echo "JUNO_EGRESS_MAX_MB_PER_HOUR must be a positive whole number" >&2; exit 1; }
[[ "$LOG_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "JUNO_EGRESS_LOG_DAYS must be a positive whole number" >&2; exit 1; }
[[ "$BROWSER_SANDBOX" =~ ^(auto|off)$ ]] || { echo "JUNO_COMPUTER_BROWSER_SANDBOX is auto or off" >&2; exit 1; }

write_policy() {  # <browserSandbox true|false>
  python3 - "$IMAGE" "$NET" "$1" "$SECCOMP" <<'PYCONFIG'
import json, sys
policy = {'image': sys.argv[1], 'network': sys.argv[2], 'maxMemoryMb': 2048, 'maxCpus': 2,
          'browserSandbox': sys.argv[3] == 'true'}
if policy['browserSandbox']:
    policy['seccompProfile'] = sys.argv[4]
with open('/etc/juno/computer-broker.json.part', 'w') as file:
    json.dump(policy, file)
PYCONFIG
  chmod 0644 /etc/juno/computer-broker.json.part
  mv -f /etc/juno/computer-broker.json.part /etc/juno/computer-broker.json
}

echo "==> Docker"
systemctl enable --now docker
# The application user must never be root-equivalent through Docker.
if id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
  gpasswd -d "$RUN_USER" docker
fi
install -d -m 0755 /etc/juno
install -o root -g root -m 0755 "$HERE/docker-broker.py" /usr/local/sbin/juno-computer-docker-broker
# The broker runs the address-map helper around every start, stop and remove.
install -o root -g root -m 0755 "$HERE/egress-map.py" /usr/local/sbin/juno-computers-egress-map
# Until the image is built and probed below, the browser sandbox stays off
# (Docker's default seccomp profile), exactly as before.
[ -f /etc/juno/computer-broker.json ] || write_policy false
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/juno-computer-docker-broker *\n' "$RUN_USER" > /etc/sudoers.d/juno-computers
chmod 0440 /etc/sudoers.d/juno-computers
visudo -cf /etc/sudoers.d/juno-computers

echo "==> Network $NET ($SUBNET, bridge $BRIDGE, no container-to-container traffic)"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create \
  --driver bridge --subnet "$SUBNET" \
  -o com.docker.network.bridge.name="$BRIDGE" \
  -o com.docker.network.bridge.enable_icc=false \
  "$NET"

echo "==> Egress address map (the proxy names every connection after its computer)"
install -o root -g root -m 0644 "$HERE/juno-computers-egress-map.service" /etc/systemd/system/juno-computers-egress-map.service
systemctl daemon-reload
systemctl enable juno-computers-egress-map.service
systemctl restart juno-computers-egress-map.service

echo "==> Pinned public egress proxy (log: /var/log/juno-computers-egress/egress.jsonl, $LOG_DAYS days; budget: $MAX_MB_PER_HOUR MB per computer per hour)"
install -o root -g root -m 0755 "$HERE/egress-proxy.py" /usr/local/sbin/juno-computers-egress-proxy
sed "s/@MAX_MB_PER_HOUR@/$MAX_MB_PER_HOUR/" "$HERE/juno-computers-egress.service" > /etc/systemd/system/juno-computers-egress.service
chmod 0644 /etc/systemd/system/juno-computers-egress.service
sed "s/@LOG_DAYS@/$LOG_DAYS/g" "$HERE/juno-computers-egress.logrotate" > /etc/logrotate.d/juno-computers-egress
chmod 0644 /etc/logrotate.d/juno-computers-egress
systemctl daemon-reload
systemctl enable juno-computers-egress.service
systemctl restart juno-computers-egress.service

echo "==> Firewall (no DNS from computers: port 53 is rejected)"
install -m 0755 "$HERE/firewall.sh" /usr/local/sbin/juno-computers-firewall
install -o root -g root -m 0644 "$HERE/juno-computers-firewall.service" /etc/systemd/system/juno-computers-firewall.service
systemctl daemon-reload
systemctl enable juno-computers-firewall.service
systemctl restart juno-computers-firewall.service

echo "==> Image $IMAGE"
docker build --pull -t "$IMAGE" "$HERE"

echo "==> Chromium's own sandbox (COMPUTERS_2026-10.md D13)"
# On only when BOTH hold on this host, each checked in a throwaway container of
# the new image under the permissive profile: the browser uid may create a user
# namespace (the kernel, and AppArmor where present, allow it), and the agent
# uid, started through its launcher, may not (the launcher's ban holds). Any
# other outcome keeps Docker's default profile: the sandbox is off, exactly as
# pipe-v3, and the provider reports it so.
probe() {  # <uid> <entrypoint> [args...]
  local uid=$1 entrypoint=$2; shift 2
  docker run --rm --network none --user "$uid" --cap-drop ALL --security-opt no-new-privileges \
    --security-opt "seccomp=$HERE/seccomp-chromium.json" --read-only --entrypoint "$entrypoint" "$IMAGE" "$@"
}
sandbox=false
if [ "$BROWSER_SANDBOX" = auto ]; then
  if probe 1001 unshare --user --map-root-user true >/dev/null 2>&1; then
    if ban=$(probe 1000 /opt/juno/agent-exec run -- unshare -Ur true 2>&1); then
      echo "    the agent could create a user namespace under the permissive profile: the sandbox stays OFF" >&2
    elif printf '%s' "$ban" | grep -q "Operation not permitted"; then
      sandbox=true
    else
      echo "    the launcher's ban could not be confirmed ($ban): the sandbox stays off" >&2
    fi
  else
    echo "    this kernel (or AppArmor) does not allow user namespaces in a container: the sandbox stays off"
  fi
fi
if [ "$sandbox" = true ]; then
  install -o root -g root -m 0644 "$HERE/seccomp-chromium.json" "$SECCOMP"
  write_policy true
  echo "    on: computers are created with $SECCOMP"
else
  write_policy false
  rm -f "$SECCOMP"
  echo "    off: Docker's default seccomp profile, Chromium with --no-sandbox"
fi

echo
echo "Image and narrow Docker broker installed. Restart the application login/session to drop its old docker group."
echo "A computer made from an older image is recreated on its volumes at its next wake (files and sign-ins kept)."
echo "Turn them on:  cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload   (value: docker)"
