# An agent's computer: a full Linux desktop (Xvfb + XFCE), headful Chromium, a shell
# and a home directory, in one unprivileged container. One container and one named
# volume (/home/agent) per agent, never shared. Built on the Juno VM by setup-vm.sh
# (linux/amd64) and on a developer's Mac for the local smoke test (arm64).
#
# The container is the sandbox: agent uid 1000, browser uid 1001, every capability dropped,
# no-new-privileges, read-only root filesystem, firewalled network (firewall.sh).
# Chromium therefore runs with --no-sandbox.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/browser \
    DISPLAY=:0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc xdotool scrot x11-utils dbus-x11 \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar mousepad \
      chromium ca-certificates tini \
      python3 python3-websockets curl git jq unzip zip procps less nano \
      nodejs npm \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash agent \
 && useradd --create-home --uid 1001 --groups agent --shell /bin/bash browser \
 && chmod 0700 /home/browser \
 && mkdir -p /home/agent/work/downloads \
 && chown -R agent:agent /home/agent/work \
 && chmod 0770 /home/agent/work /home/agent/work/downloads

ENV HTTP_PROXY=http://172.30.0.1:3128 \
    HTTPS_PROXY=http://172.30.0.1:3128 \
    http_proxy=http://172.30.0.1:3128 \
    https_proxy=http://172.30.0.1:3128

# Chromium never offers to save a password, card or address: the person types
# secrets during a takeover, and they must not land in a store the agent's shell
# could read.
COPY chrome-policies.json /etc/chromium/policies/managed/juno.json
COPY cdp-gate.py entrypoint.sh /opt/juno/
RUN chmod 0644 /etc/chromium/policies/managed/juno.json /opt/juno/cdp-gate.py \
 && chmod 0755 /opt/juno/entrypoint.sh

LABEL juno.security="pipe-v2"
USER 1001
WORKDIR /home/browser
EXPOSE 5900 9222
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/juno/entrypoint.sh"]
