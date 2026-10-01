# An agent's computer: an X display (Xvfb) with a bare window manager (xfwm4) and
# headful Chromium, a shell and a home directory, in one unprivileged container. One
# container and two named volumes (/home/agent, /home/browser) per agent, never shared.
# Built on the Juno VM by setup-vm.sh (linux/amd64) and on a developer's Mac for the
# local smoke test (arm64).
#
# The container is the sandbox: agent uid 1000, browser uid 1001, every capability dropped,
# no-new-privileges, read-only root filesystem, firewalled network (firewall.sh).
# Chromium therefore runs with --no-sandbox.
#
# What the uid split does and does not do. The agent's shell (1000) cannot read the
# browser's profile or the CDP token: /home/browser and /run/juno are 0700 uid 1001.
# The agent DOES drive the shared display (xdotool, scrot), so anything the browser
# window itself can show or do is reachable by GUI input; that is the approved
# takeover/browser-control surface, and the profile is treated as reachable through
# it (docs/rework/SECURITY_REVIEW_2026-10-02.md). What must not exist on that display
# is any OTHER program running as 1001: no desktop session, panel, launcher, terminal,
# file manager or editor, since GUI input to those would be a shell as the browser
# user. And the browser is not in the agent's group: it writes downloads into a
# directory it owns, and nowhere else under /home/agent.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/browser \
    DISPLAY=:0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc xdotool scrot x11-utils dbus-x11 \
      xfwm4 \
      chromium ca-certificates tini \
      python3 python3-websockets curl git jq unzip zip procps less nano \
      nodejs npm \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash agent \
 && useradd --create-home --uid 1001 --shell /bin/bash browser \
 && chmod 0700 /home/browser \
 && mkdir -p /home/agent/work/downloads \
 && chown agent:agent /home/agent/work \
 && chown browser:agent /home/agent/work/downloads \
 && chmod 0711 /home/agent /home/agent/work \
 && chmod 2770 /home/agent/work/downloads

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

LABEL juno.security="pipe-v3"
USER 1001
WORKDIR /home/browser
EXPOSE 5900 9222
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/juno/entrypoint.sh"]
