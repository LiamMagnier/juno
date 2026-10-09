#!/usr/bin/env bash
# Build Juno on this Mac and ship it to production — no GitHub Actions minutes.
#
# This is deploy.yml's `test` + `runner` + `build-and-deploy` jobs, run from a
# laptop instead of a GitHub runner:
#   1. `git archive` of the commit to deploy (origin/main unless told otherwise)
#   2. checks + build inside a linux/amd64 Docker container, so every native
#      module (Prisma's engine, esbuild, …) is the Linux one the VM needs —
#      a build made on macOS directly would ship Mac binaries and crash there
#   3. the same immutable release transaction on the VM: checksum-verified
#      source + build artifact, `deploy/deploy.sh`, migrations, PM2 reload,
#      health check with automatic rollback, then the production smoke tests
#
# The 892 MB VM never builds anything; it only unpacks what this Mac built.
#
# Usage (from anywhere inside the repo):
#   deploy/deploy-from-mac.sh                 # deploy origin/main
#   deploy/deploy-from-mac.sh some-branch     # deploy a branch, tag or SHA
#   deploy/deploy-from-mac.sh REF --skip-checks="why this cannot wait"
#       EMERGENCY ONLY. Skips the test/lint/contract gates (scripts/local-gates.sh)
#       but still runs the migration replay, the security check and `next build`
#       (which typechecks), and records who, what and why on this Mac and on the VM.
#       SKIP_CHECKS in the environment is ignored; a push never takes this path.
#
# Needs, once:
#   - Docker Desktop, running. Settings → Resources → Memory: 8 GB (the
#     typecheck peaks near 2.6 GB and `next build` is given 4 GB). On Apple
#     Silicon, also Settings → General → "Use Rosetta for x86_64/amd64
#     emulation on Apple Silicon" — several times faster than without.
#   - The VM's SSH key. Defaults below; override with JUNO_SSH_KEY / JUNO_VM.
set -Eeuo pipefail

VM="${JUNO_VM:-liammgnr@20.91.138.96}"
KEY="${JUNO_SSH_KEY:-$HOME/Developer/KEY/chatliamsdev.pem}"
PUBLIC_URL="${JUNO_PUBLIC_URL:-https://chat.liams.dev}"
IMAGE="node:24-bookworm"
# Where the container builds. Next bakes this absolute path into .next and
# deploy.sh rewrites it, as plain text, to the release directory — so it must
# be a path that occurs nowhere else in the build. `/app` was not: it is also
# the start of "/app-auth", "/apple-icon.png" and a user-agent regex, and the
# rewrite broke every request on the new release.
BUILD_ROOT="/opt/juno-release-build"
REF="origin/main"
# The gate bypass is a flag with a reason, never an inherited variable: a
# leftover `export SKIP_CHECKS=1` used to skip every gate of the next deploy
# with nothing on screen but one word in a banner.
if [ -n "${SKIP_CHECKS:-}" ]; then
  printf '\033[1;33m[warn] SKIP_CHECKS in the environment is ignored; the gates will run. Use --skip-checks="<reason>" for an emergency.\033[0m\n' >&2
fi
SKIP_CHECKS=0
SKIP_REASON=""

for arg in "$@"; do
  case "$arg" in
    --skip-checks)
      echo "--skip-checks needs a reason: --skip-checks=\"why this cannot wait for green gates\"" >&2
      exit 2 ;;
    --skip-checks=*)
      SKIP_CHECKS=1
      SKIP_REASON="${arg#--skip-checks=}" ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done
if [ "$SKIP_CHECKS" = 1 ]; then
  # One printable line of at least 12 characters: it goes into two logs.
  if [ "${#SKIP_REASON}" -lt 12 ] || [ "${#SKIP_REASON}" -gt 300 ] || printf '%s' "$SKIP_REASON" | LC_ALL=C grep -q '[^ -~]'; then
    echo "--skip-checks reason must be one printable line of 12 to 300 characters" >&2
    exit 2
  fi
fi

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }
elapsed() { local s=$((SECONDS - $1)); printf '%dm%02ds' $((s / 60)) $((s % 60)); }

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15)
vm() { ssh "${SSH_OPTS[@]}" "$VM" "$@"; }

# —— Preflight ——————————————————————————————————————————————————————————————
say "Preflight"
cd "$(git rev-parse --show-toplevel)" || die "run this from inside the juno repository"
[ -f deploy/deploy.sh ] || die "this doesn't look like the juno repository"
[ -r "$KEY" ] || die "SSH key not found at $KEY (set JUNO_SSH_KEY=/path/to/chatliamsdev.pem)"
[ "$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY")" = "400" ] || chmod 400 "$KEY"
command -v docker >/dev/null 2>&1 || die "Docker isn't installed — install Docker Desktop for Mac"
docker info >/dev/null 2>&1 || die "Docker isn't running — open Docker Desktop and wait for it to say 'Engine running'"
docker_mem_gb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
[ "$docker_mem_gb" -ge 6 ] || warn "Docker Desktop has ${docker_mem_gb} GB of memory; give it 8 GB (Settings → Resources) or the typecheck/build may be killed"
[ "$(uname -m)" = "arm64" ] && echo "Apple Silicon: the build runs as linux/amd64 under emulation (turn on Rosetta in Docker Desktop for speed)."
vm true || die "can't SSH to $VM with $KEY"
echo "Docker ${docker_mem_gb} GB · SSH to $VM OK"

say "What to deploy"
git fetch --quiet origin
SHA="$(git rev-parse --verify "$REF^{commit}")" || die "unknown ref: $REF"
git log -1 --format='%h  %an, %cr%n    %s' "$SHA"
if ! git branch -r --contains "$SHA" 2>/dev/null | grep -q .; then
  warn "$SHA is not on GitHub yet — you are deploying something nobody else can see. Push it first unless that's intended."
fi
if [ "$REF" = "origin/main" ] && [ -n "$(git log --oneline origin/main..HEAD 2>/dev/null)" ]; then
  warn "your local branch has commits that aren't on origin/main; they are NOT in this deploy (git push first to include them)"
fi
GATES_BYPASS_B64=""
if [ "$SKIP_CHECKS" = 1 ]; then
  # Recorded before anything is built, so an abandoned emergency deploy is in
  # the log too. The VM gets the same line in ~/juno/deploy-bypass.log.
  BYPASS_LINE="$(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA ref=$REF operator=$(git config user.email 2>/dev/null || whoami)@$(hostname -s) reason=$SKIP_REASON"
  BYPASS_LOG="${JUNO_BYPASS_LOG:-$HOME/.juno/deploy-bypass.log}"
  mkdir -p "$(dirname "$BYPASS_LOG")" && chmod 700 "$(dirname "$BYPASS_LOG")"
  printf '%s\n' "$BYPASS_LINE" >> "$BYPASS_LOG" || die "could not record the gate bypass in $BYPASS_LOG"
  GATES_BYPASS_B64="$(printf '%s' "$BYPASS_LINE" | base64 | tr -d '\n')"
  printf '\n\033[1;41;37m EMERGENCY DEPLOY: test, lint and contract gates are SKIPPED \033[0m\n' >&2
  printf '\033[1;31m%s\033[0m\n' "Reason: $SKIP_REASON" >&2
  printf '\033[1;31m%s\033[0m\n\n' "Still run: migration replay, security check, next build (typecheck + lint). Logged in $BYPASS_LOG and on the VM." >&2
fi
live_sha="$(curl -fsS -m 10 "$PUBLIC_URL/api/health" 2>/dev/null | sed -n 's/.*"version":"\([0-9a-f]*\)".*/\1/p' || true)"
echo "Live now: ${live_sha:-unknown}"
[ "$live_sha" != "$SHA" ] || warn "that commit is already live — deploying it again anyway"

WORK="$(mktemp -d /tmp/juno-deploy.XXXXXX)"
# The VM upload directory, while removing it is this script's job: from the
# preflight that creates it until the release transaction, whose own cleanup
# removes it, takes it over. An upload that fails or is interrupted goes at
# once, rather than an hour later when the next preflight finds it abandoned.
VM_UPLOAD_OWNED=''
on_exit() {
  rm -rf "$WORK"
  [ -z "$VM_UPLOAD_OWNED" ] || vm "rm -rf -- '$VM_UPLOAD_OWNED'" >/dev/null 2>&1 || true
}
trap on_exit EXIT
# Everything this run leaves on the VM is named for it, and WORK's random tail
# keeps two deploys started in the same second apart.
RUN_ID="mac-$(date +%Y%m%d%H%M%S)-${WORK##*.}"
ARCHIVE="juno-$SHA.tar.gz"
ARTIFACT="juno-$SHA.build.tar.gz"
UPLOAD_DIR="/tmp/juno-upload-$RUN_ID"

say "Shared migration gate on isolated local Postgres"
bash scripts/local-gates.sh --migrations-only "$SHA"

# —— Production env for the build ———————————————————————————————————————————
# Next.js bakes NEXT_PUBLIC_* values into the build, so it has to see the real
# production env. The VM's ~/juno/.env is exactly the env the app runs with.
say "Production env (read from the VM, never written into the repo)"
vm 'cat ~/juno/.env' > "$WORK/prod.env" || die "couldn't read ~/juno/.env on the VM"
chmod 600 "$WORK/prod.env"
missing=0
for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS; do
  grep -Eq "^${name}=.+$" "$WORK/prod.env" || { warn "production .env is missing $name"; missing=1; }
done
[ "$missing" -eq 0 ] || die "refusing to build against an incomplete production env"
{ grep -v '^GIT_SHA=' "$WORK/prod.env"; printf 'GIT_SHA=%s\n' "$SHA"; } > "$WORK/build.env"
echo "$(grep -c '=' "$WORK/prod.env") keys"

# —— Build ——————————————————————————————————————————————————————————————————
say "Source archive of ${SHA:0:12}"
git archive --format=tar "$SHA" | gzip -1 > "$WORK/$ARCHIVE"
# The container builds from that archive, which has no .git, so the secret scan
# (scripts/check-tracked-secrets.mjs) gets the commit's file list from here.
git ls-tree -r -z --name-only "$SHA" > "$WORK/tracked-files"
shasum -a 256 "$WORK/$ARCHIVE" | cut -d' ' -f1 > "$WORK/$ARCHIVE.sha256"

say "Checks and build in a linux/amd64 container ($([ "$SKIP_CHECKS" = 1 ] && echo 'EMERGENCY: gates SKIPPED except security' || echo 'with checks'))"
build_start=$SECONDS
# Everything the container prints goes to stderr (your terminal); the build
# artifact is the only thing on stdout. node_modules stays inside the
# container rather than on a bind mount, which on macOS is many times slower.
# The production env is copied in only AFTER the checks, so no test can ever
# see the production database URL.
docker run --rm -i --platform linux/amd64 \
  -v juno-npm-cache:/root/.npm \
  -v "$WORK/build.env:/run/juno-build.env:ro" \
  -v "$WORK/tracked-files:/run/juno-tracked-files:ro" -e JUNO_TRACKED_FILES=/run/juno-tracked-files \
  -e JUNO_EMERGENCY_SKIP_GATES="$SKIP_CHECKS" -e CI=1 -e BUILD_ROOT="$BUILD_ROOT" \
  "$IMAGE" bash -c '
    set -Eeuo pipefail
    exec 3>&1 1>&2
    step() { printf "\n\033[1;36m--> %s\033[0m\n" "$*"; }
    mkdir -p "$BUILD_ROOT" && cd "$BUILD_ROOT" && gzip -cd | tar -x
    step "npm ci"
    npm ci --no-audit --no-fund
    step "vendored runner core"
    npm ci --prefix runner/agent-core --no-audit --no-fund
    npm run build --prefix runner/agent-core
    step "Code env server dependencies"
    npm ci --prefix runner/env-server --no-audit --no-fund
    step "relay dependencies"
    npm ci --prefix relay --no-audit --no-fund
    if [ "${JUNO_EMERGENCY_SKIP_GATES:-0}" = "1" ]; then
      step "EMERGENCY: shared gates skipped; the security check still runs"
      npm run security:check
    else
      step "shared local gates"
      bash scripts/local-gates.sh --without-migrations
    fi
    step "next build"
    cp /run/juno-build.env .env
    npm run build
    rm -f .env
    step "voice relay"
    npm ci --prefix relay --no-audit --no-fund
    npm test --prefix relay
    npm run build --prefix relay
    step "packaging"
    tar --exclude=.next/cache --exclude=node_modules/.cache \
        --exclude=relay/node_modules/.cache --exclude=runner/agent-core/node_modules/.cache \
        -czf - .next node_modules relay/node_modules relay/dist \
        runner/agent-core/node_modules runner/agent-core/dist >&3
  ' < "$WORK/$ARCHIVE" > "$WORK/$ARTIFACT" || die "build failed — nothing was sent to the server"
shasum -a 256 "$WORK/$ARTIFACT" | cut -d' ' -f1 > "$WORK/$ARTIFACT.sha256"
echo "Built in $(elapsed "$build_start"): $(du -h "$WORK/$ARTIFACT" | cut -f1) artifact"

# —— Ship ———————————————————————————————————————————————————————————————————
say "Freeing space on the VM"
# Under the lock deploy.sh holds for a whole release transaction, so it is
# refused, with the holder named, while another deploy is running. It creates
# UPLOAD_DIR last; see deploy/vm-preflight.sh.
vm "UPLOAD_DIR='$UPLOAD_DIR' bash -s" < deploy/vm-preflight.sh \
  || die "the VM preflight did not complete (see above) — nothing was uploaded"
VM_UPLOAD_OWNED="$UPLOAD_DIR"

say "Uploading to the VM"
upload_start=$SECONDS
scp "${SSH_OPTS[@]}" "$WORK/$ARCHIVE" "$WORK/$ARCHIVE.sha256" "$WORK/$ARTIFACT" "$WORK/$ARTIFACT.sha256" "$VM:$UPLOAD_DIR/"
echo "Uploaded in $(elapsed "$upload_start")"

# —— Release transaction (same as deploy.yml) ——————————————————————————————————
say "Activating ${SHA:0:12} (deploy.sh: migrate, reload, health check, auto-rollback)"
VM_UPLOAD_OWNED=''
vm "GIT_SHA_TO_DEPLOY='$SHA' RUN_ID='$RUN_ID' UPLOAD_DIR='$UPLOAD_DIR' JUNO_BUILD_ROOT='$BUILD_ROOT' GATES_BYPASS_B64='$GATES_BYPASS_B64' bash -s" <<'REMOTE'
set -euo pipefail
LIVE_ROOT="$HOME/juno"
if [ -n "$GATES_BYPASS_B64" ]; then
  # An emergency deploy leaves a line on the server it changed, beside the
  # releases, whoever later asks why this release did not pass its gates.
  printf '%s\n' "$(printf '%s' "$GATES_BYPASS_B64" | base64 -d)" >> "$LIVE_ROOT/deploy-bypass.log"
  chmod 600 "$LIVE_ROOT/deploy-bypass.log"
fi
ARCHIVE="$UPLOAD_DIR/juno-${GIT_SHA_TO_DEPLOY}.tar.gz"
BUILD_ARTIFACT="$UPLOAD_DIR/juno-${GIT_SHA_TO_DEPLOY}.build.tar.gz"
INCOMING_ENV="$LIVE_ROOT/.env.incoming-${RUN_ID}"
SOURCE_STAGE="$HOME/.juno-source-${RUN_ID}"
cleanup() {
  rm -rf -- "$UPLOAD_DIR"
  rm -f -- "$INCOMING_ENV"
  [ ! -d "$SOURCE_STAGE" ] || rm -rf -- "$SOURCE_STAGE"
}
trap cleanup EXIT
[ -d "$LIVE_ROOT" ] || { echo "Live root $LIVE_ROOT is missing." >&2; exit 1; }
[ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$(cat "$ARCHIVE.sha256")" ] || { echo "Source archive checksum mismatch." >&2; exit 1; }
build_sha256="$(cat "$BUILD_ARTIFACT.sha256")"
[ "$(sha256sum "$BUILD_ARTIFACT" | cut -d' ' -f1)" = "$build_sha256" ] || { echo "Build artifact checksum mismatch." >&2; exit 1; }
[ "$(gzip -cd "$ARCHIVE" | git get-tar-commit-id)" = "$GIT_SHA_TO_DEPLOY" ] || { echo "Source archive is not commit $GIT_SHA_TO_DEPLOY." >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" = "24" ] || { echo "The VM is not on Node 24 ($(node --version))." >&2; exit 1; }
mkdir "$SOURCE_STAGE"
tar -xzf "$ARCHIVE" -C "$SOURCE_STAGE" --no-same-owner
[ -f "$SOURCE_STAGE/deploy/deploy.sh" ] || { echo "Source archive is missing deploy/deploy.sh." >&2; exit 1; }
install -m 600 "$LIVE_ROOT/.env" "$INCOMING_ENV"
JUNO_APP_HOME="$SOURCE_STAGE" \
  JUNO_RELEASES_DIR="$LIVE_ROOT/releases" \
  JUNO_CURRENT_LINK="$LIVE_ROOT/current" \
  JUNO_PREVIOUS_LINK="$LIVE_ROOT/previous" \
  JUNO_INITIAL_RELEASE_TARGET="$LIVE_ROOT" \
  JUNO_PERSISTENT_DATA_ROOT="$LIVE_ROOT" \
  JUNO_ENV_FILE="$INCOMING_ENV" \
  JUNO_DEPLOY_REF="$GIT_SHA_TO_DEPLOY" \
  JUNO_DEPLOY_ARCHIVE="$ARCHIVE" \
  JUNO_BUILD_ARTIFACT="$BUILD_ARTIFACT" \
  JUNO_BUILD_ARTIFACT_SHA256="$build_sha256" \
  bash "$SOURCE_STAGE/deploy/deploy.sh"
sudo nginx -t
REMOTE

# —— Verify from outside, then smoke-test; roll back if either fails ————————————
rollback() {
  warn "$1 — rolling back to the previous release"
  vm "GIT_SHA_TO_DEPLOY='$SHA' bash -s" <<'ROLLBACK' || die "ROLLBACK FAILED — check the VM by hand: pm2 status, ls -l ~/juno/current ~/juno/previous"
set -euo pipefail
LIVE_ROOT="$HOME/juno"
current_sha="$(cat "$(readlink -f -- "$LIVE_ROOT/current")/.juno-release-sha" 2>/dev/null || true)"
if [ "$current_sha" != "$GIT_SHA_TO_DEPLOY" ]; then
  echo "The new release isn't active; leaving the current one untouched."
  exit 0
fi
JUNO_APP_HOME="$LIVE_ROOT/current" \
  JUNO_RELEASES_DIR="$LIVE_ROOT/releases" \
  JUNO_CURRENT_LINK="$LIVE_ROOT/current" \
  JUNO_PREVIOUS_LINK="$LIVE_ROOT/previous" \
  JUNO_INITIAL_RELEASE_TARGET="$LIVE_ROOT" \
  JUNO_PERSISTENT_DATA_ROOT="$LIVE_ROOT" \
  JUNO_ENV_FILE="$LIVE_ROOT/.env" \
  bash "$LIVE_ROOT/current/deploy/deploy.sh" --rollback
ROLLBACK
  die "$1 — the previous release is back (the database was not rewound)"
}

say "Checking $PUBLIC_URL from outside"
ok=0
for attempt in $(seq 1 30); do
  body="$(curl -fsS -m 12 "$PUBLIC_URL/api/health" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -Fq '"ok":true' && printf '%s' "$body" | grep -Fq "\"version\":\"$SHA\""; then
    echo "Public site is healthy on ${SHA:0:12} (attempt $attempt)."
    ok=1; break
  fi
  sleep 5
done
[ "$ok" = 1 ] || rollback "the public site never reported ${SHA:0:12} as healthy"

say "Production smoke tests (sign-in and a real chat reply)"
vm "EXPECTED_SHA='$SHA' bash -s" <<'SMOKE' || rollback "production smoke tests failed"
set -e
APP_URL="$(grep -m1 '^NEXT_PUBLIC_APP_URL=' ~/juno/.env | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)"
APP_URL="${APP_URL%/}"
[ -n "$APP_URL" ] || APP_URL="https://chat.liams.dev"
SMOKE_TOKEN="$(grep -m1 '^JUNO_SMOKE_TOKEN=' ~/juno/.env | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)"
SMOKE_COOKIE="$(grep -m1 '^JUNO_SMOKE_COOKIE=' ~/juno/.env | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)"
MINT_LOG="$HOME/juno/smoke-token.log"
: > "$MINT_LOG"
FRESH_TOKEN="$(cd ~/juno/current && JUNO_SMOKE_EXPECTED_SHA="$EXPECTED_SHA" \
  node --env-file="$HOME/juno/.env" --import tsx scripts/mint-smoke-token.ts 2>>"$MINT_LOG")" || true
if [ -n "$FRESH_TOKEN" ]; then
  SMOKE_TOKEN="$FRESH_TOKEN"
else
  echo "Could not mint a smoke token; using the stored credential." >&2
  sed 's/^/  mint: /' "$MINT_LOG" | head -20 || true
fi
# Same ordered candidates as deploy.yml: the first model that streams wins.
SMOKE_MODEL="qwen:qwen3.6-flash,google:gemini-3.5-flash-lite,openai:gpt-5.4-mini"
JUNO_SMOKE_BASE_URL="$APP_URL" \
  JUNO_SMOKE_EXPECTED_SHA="$EXPECTED_SHA" \
  JUNO_SMOKE_REQUIRE_AUTH=1 \
  JUNO_SMOKE_TOKEN="$SMOKE_TOKEN" \
  JUNO_SMOKE_COOKIE="$SMOKE_COOKIE" \
  JUNO_SMOKE_MODEL="$SMOKE_MODEL" \
  JUNO_SMOKE_RUN_CHAT=1 \
  node ~/juno/current/scripts/production-smoke.mjs
JUNO_PUBLIC_UI_BASE_URL="$APP_URL" node ~/juno/current/scripts/public-ui-smoke.mjs
SMOKE

say "Deployed ${SHA:0:12} — $PUBLIC_URL is live on it. Total $(elapsed 0)."
[ "$SKIP_CHECKS" != 1 ] || warn "This release did NOT pass the shared gates (emergency bypass, logged). Run scripts/local-gates.sh on ${SHA:0:12} and fix forward."
