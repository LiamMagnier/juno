#!/bin/bash
# Keeps agent computers off private networks, the cloud metadata and wire-server
# endpoints, and the host itself. Idempotent: run at boot and whenever Docker starts.
set -euo pipefail
BRIDGE=br-juno
CHAIN=JUNO-COMPUTERS

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 \
           127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4 168.63.129.16/32; do
  iptables -A "$CHAIN" -d "$net" -j DROP
done
iptables -A "$CHAIN" -j RETURN

iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null \
  || iptables -I DOCKER-USER 1 -i "$BRIDGE" -j "$CHAIN"

# A computer may answer the host (Juno connects to its CDP and VNC ports) but never
# open a connection to the host: that is where the app, the relay and the database
# credentials live.
iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -j DROP
iptables -C INPUT -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# The network is created without IPv6; refuse anything that appears anyway.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N DOCKER-USER 2>/dev/null || true
  ip6tables -C DOCKER-USER -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP
  ip6tables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I INPUT 1 -i "$BRIDGE" -j DROP
fi
echo "juno-computers firewall in place"
