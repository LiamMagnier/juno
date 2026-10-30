#!/bin/bash
# Keeps agent computers off private networks, the cloud metadata and wire-server
# endpoints, and the host itself. Idempotent: run at boot and whenever Docker starts.
set -euo pipefail
BRIDGE=br-juno
CHAIN=JUNO-COMPUTERS

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Computers have no direct Internet egress and no DNS (pipe-v4): HTTP and HTTPS
# go through the host proxy's validated, pinned sockets, which resolve names on
# the host. The public-resolver exception that used to be here was a tunnel out.
# Port 53 is rejected rather than dropped, so a lookup (Docker's resolver
# forwards to the RFC 5737 address 192.0.2.53 the create argv pins) fails at once
# instead of hanging a tool for its whole timeout.
iptables -A "$CHAIN" -p udp --dport 53 -j REJECT --reject-with icmp-port-unreachable
iptables -A "$CHAIN" -p tcp --dport 53 -j REJECT --reject-with tcp-reset
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
