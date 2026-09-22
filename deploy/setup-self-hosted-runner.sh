#!/usr/bin/env bash
# Registers the production VM as the "juno-vm" self-hosted GitHub Actions
# runner that .github/workflows/deploy.yml targets, and installs it as a
# systemd service so it survives reboots.
#
# Run it ON the VM, as the deploy user (the one that owns ~/juno and the PM2
# processes — never root), straight from a local clone:
#
#   ssh -i chatliamsdev.pem liammgnr@20.91.138.96 'bash -s' -- <TOKEN> \
#     < deploy/setup-self-hosted-runner.sh
#
# <TOKEN> is the one shown on GitHub → Settings → Actions → Runners → New
# self-hosted runner (the `--token` value in its "Configure" block). It expires
# an hour after that page is opened. Safe to re-run: an existing registration is
# replaced rather than duplicated.
set -Eeuo pipefail

TOKEN="${1:-}"
REPO_URL="https://github.com/LiamMagnier/juno"
RUNNER_NAME="juno-vm"
RUNNER_LABELS="juno-vm"
RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
RUNNER_DIR="$HOME/actions-runner"
SWAP_SIZE="4G"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$TOKEN" ] || die "usage: setup-self-hosted-runner.sh <registration-token>"
[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root — the runner inherits this user's pm2, ~/juno and sudo rights"
sudo -n true 2>/dev/null || die "$USER needs passwordless sudo (deploy.yml already relies on it for nginx and svc.sh needs it here)"
[ "$(uname -m)" = "x86_64" ] || die "this installs the linux-x64 runner, but this machine is $(uname -m)"

say "Docker (the migrations job runs postgres:16 as a service container)"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
fi
sudo systemctl enable --now docker
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group (the runner service picks it up when it starts below)."
fi
sg docker -c 'docker run --rm hello-world >/dev/null' || die "docker is installed but $USER can't run containers"
echo "docker OK for $USER"

say "Memory (Next build + tests now run beside the live app)"
if [ -z "$(swapon --show --noheadings)" ]; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "$SWAP_SIZE" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
  fi
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "Added a $SWAP_SIZE /swapfile."
fi
free -h

say "Download runner v$RUNNER_VERSION"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
tarball="actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
if [ ! -x ./config.sh ] || [ "$(cat .juno-runner-version 2>/dev/null)" != "$RUNNER_VERSION" ]; then
  curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$tarball"
  echo "$RUNNER_SHA256  $tarball" | sha256sum -c - \
    || die "checksum mismatch — re-copy the hash from GitHub's 'New self-hosted runner' page into RUNNER_SHA256"
  tar xzf "$tarball"
  rm -f "$tarball"
  echo "$RUNNER_VERSION" > .juno-runner-version
fi
sudo ./bin/installdependencies.sh >/dev/null

say "Register as '$RUNNER_NAME' with label '$RUNNER_LABELS'"
if [ -f .runner ]; then
  sudo ./svc.sh stop >/dev/null 2>&1 || true
  sudo ./svc.sh uninstall >/dev/null 2>&1 || true
  rm -f .runner .credentials .credentials_rsaparams
fi
./config.sh --unattended --replace \
  --url "$REPO_URL" --token "$TOKEN" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work

say "Install as a service (starts now and on every boot)"
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
sudo ./svc.sh status | head -5 || true

say "Pre-flight for deploy.yml"
if ss -ltn 2>/dev/null | grep -q ':5432 '; then
  warn "something already listens on :5432 — the migrations job maps postgres:16 to host port 5432 and will fail to start"
fi
avail_kb="$(df --output=avail -k "$HOME" | tail -1)"
if [ "$avail_kb" -lt 10485760 ]; then
  warn "only $((avail_kb / 1024 / 1024))G free in $HOME — each run checks out, installs and builds the app (several GB)"
fi
# build-and-deploy still ships over SSH to VM_HOST, which is now this machine.
if ! timeout 5 bash -c '</dev/tcp/20.91.138.96/22' 2>/dev/null; then
  warn "this VM can't reach its own public IP on :22 — the deploy job's SSH hop to VM_HOST would fail; allow it in the Azure NSG"
fi

say "Done. GitHub → Settings → Actions → Runners should show '$RUNNER_NAME' as Idle."
