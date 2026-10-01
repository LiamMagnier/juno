#!/bin/bash
# Keeps agent computers off private networks, the cloud metadata and wire-server
# endpoints, and the host itself. Idempotent: run at boot and whenever Docker starts.
set -euo pipefail
BRIDGE=br-juno
CHAIN=JUNO-COMPUTERS

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Computers have no direct Internet egress. Public DNS is the sole forwarding
# exception; HTTP and HTTPS go through the host proxy's validated/pinned sockets.
for resolver in 1.1.1.1 9.9.9.9; do
  iptables -A "$CHAIN" -d "$resolver" -p udp --dport 53 -j RETURN
  iptables -A "$CHAIN" -d "$resolver" -p tcp --dport 53 -j RETURN
done
iptables -A "$CHAIN" -j DROP

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

# The only new connection to the host is the egress proxy. Insert after the
# blanket DROP above so this exception is at the front on every re-run.
iptables -C INPUT -i "$BRIDGE" -d 172.30.0.1 -p tcp --dport 3128 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -d 172.30.0.1 -p tcp --dport 3128 -j ACCEPT

# The network is created without IPv6; refuse anything that appears anyway.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N DOCKER-USER 2>/dev/null || true
  ip6tables -C DOCKER-USER -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP
  ip6tables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I INPUT 1 -i "$BRIDGE" -j DROP
fi
echo "juno-computers firewall in place"
