#!/usr/bin/env bash
set -Eeuo pipefail

# A deploy is a release transaction, not an in-place update. The repository
# checkout is only used as a Git client; every build and every PM2 process runs
# from an immutable, commit-addressed release directory.

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_HOME="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
RELEASES_DIR="${JUNO_RELEASES_DIR:-$APP_HOME/releases}"
CURRENT_LINK="${JUNO_CURRENT_LINK:-$APP_HOME/current}"
PREVIOUS_LINK="${JUNO_PREVIOUS_LINK:-$APP_HOME/previous}"
ENV_FILE="${JUNO_ENV_FILE:-$APP_HOME/.env}"
LOCK_FILE="${JUNO_DEPLOY_LOCK:-$APP_HOME/.deploy.lock}"
DEPLOY_REF="${JUNO_DEPLOY_REF:-origin/main}"

STAGING_DIR=''
RELEASE_DIR=''
TARGET_SHA=''
OLD_CURRENT_TARGET=''
OLD_CURRENT_SHA=''
OLD_PREVIOUS_TARGET=''
CURRENT_WAS_LINK=0
PREVIOUS_WAS_LINK=0
ROLLBACK_NEEDED=0

say() {
  printf '%b\n' "$*"
}

fail() {
  say "${RED}❌ $*${NC}" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

run_in_release() {
  local directory="$1"
  shift
  (cd -- "$directory" && "$@")
}

env_has_value() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    return 0
  fi
  [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*${name}[[:space:]]*=[[:space:]]*[^[:space:]]" "$ENV_FILE"
}

require_deploy_environment() {
  [[ -f "$ENV_FILE" ]] || fail "Deployment environment file is missing: $ENV_FILE"
  local name
  for name in DATABASE_URL AUTH_SECRET AUTH_URL ALLOWED_ORIGINS; do
    env_has_value "$name" || fail "$name must be set in the reviewed deployment environment"
  done
}

require_clean_checkout() {
  git -C "$APP_HOME" diff --quiet -- || fail "Tracked working-tree changes are present in $APP_HOME"
  git -C "$APP_HOME" diff --cached --quiet -- || fail "Staged working-tree changes are present in $APP_HOME"
}

reviewed_migrations_exist() {
  local target_sha="$1"
  local migration_files
  migration_files="$(git -C "$APP_HOME" ls-tree -r --name-only "$target_sha" -- prisma/migrations | awk '/\/migration\.sql$/')"
  [[ -n "$migration_files" ]] || fail "The reviewed commit contains no Prisma migration files"
}

validate_release() {
  local directory="$1"
  [[ -d "$directory" ]] || fail "Release directory does not exist: $directory"
  [[ -f "$directory/package.json" ]] || fail "Release is missing package.json: $directory"
  [[ -f "$directory/prisma/schema.prisma" ]] || fail "Release is missing prisma/schema.prisma: $directory"
  [[ -f "$directory/deploy/ecosystem.config.js" ]] || fail "Release is missing the PM2 ecosystem: $directory"
  [[ -d "$directory/prisma/migrations" ]] || fail "Release is missing prisma/migrations: $directory"

  local migration_dir
  while IFS= read -r migration_dir; do
    [[ -f "$migration_dir/migration.sql" ]] || fail "Migration directory has no migration.sql: $migration_dir"
  done < <(find "$directory/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -print)
}

pointer_target() {
  local pointer="$1"
  if [[ -L "$pointer" ]]; then
    readlink -f -- "$pointer"
  elif [[ -e "$pointer" ]]; then
    fail "$pointer exists but is not a symlink"
  else
    printf '\n'
  fi
}

atomic_symlink() {
  local target="$1"
  local pointer="$2"
  local temporary="${pointer}.tmp.$$"

  if [[ -e "$pointer" && ! -L "$pointer" ]]; then
    fail "Refusing to replace non-symlink release pointer: $pointer"
  fi
  if [[ -e "$temporary" || -L "$temporary" ]]; then
    fail "Refusing to reuse an existing release pointer temporary: $temporary"
  fi

  ln -s -- "$target" "$temporary"
  # The temporary symlink and its destination are on the same filesystem, so
  # rename is atomic and readers see either the old release or the new one.
  mv -f -- "$temporary" "$pointer"
}

restore_pointer() {
  local pointer="$1"
  local was_link="$2"
  local target="$3"

  if [[ "$was_link" == 1 ]]; then
    atomic_symlink "$target" "$pointer"
  elif [[ -L "$pointer" ]]; then
    rm -f -- "$pointer"
  elif [[ -e "$pointer" ]]; then
    printf '%s\n' "Refusing to remove non-symlink release pointer: $pointer" >&2
    return 1
  fi
}

release_sha() {
  local directory="$1"
  if [[ -f "$directory/.juno-release-sha" ]]; then
    local recorded
    IFS= read -r recorded < "$directory/.juno-release-sha" || true
    printf '%s\n' "$recorded"
    return 0
  fi
  git -C "$directory" rev-parse --verify HEAD 2>/dev/null || printf 'unknown\n'
}

reload_release() {
  local directory="$1"
  local release_sha_value="$2"
  [[ -f "$directory/deploy/ecosystem.config.js" ]] || return 1

  export GIT_SHA="$release_sha_value"
  pm2 startOrReload "$directory/deploy/ecosystem.config.js" --cwd "$directory" --update-env
  pm2 save
}

health_url() {
  local url="${JUNO_HEALTH_URL:-${NEXT_PUBLIC_APP_URL:-}}"
  if [[ -z "$url" && -f "$ENV_FILE" ]]; then
    url="$(grep -m1 '^NEXT_PUBLIC_APP_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '\"' | tr -d "'" | tr -d '\r' || true)"
  fi
  url="${url%/}"
  if [[ -z "$url" ]]; then
    printf '%s\n' "JUNO_HEALTH_URL or NEXT_PUBLIC_APP_URL is required" >&2
    return 1
  fi
  printf '%s\n' "$url"
}

wait_for_health() {
  local url="$1"
  local expected_sha="$2"
  local attempts="$3"
  local sleep_seconds="$4"
  local timeout_seconds="$5"
  local attempt
  local body

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if body="$(curl --silent --show-error --max-time "$timeout_seconds" "$url/api/health" 2>/dev/null)" \
      && printf '%s' "$body" | grep -Fq '"ok":true'; then
      if [[ "$expected_sha" == unknown ]] || printf '%s' "$body" | grep -Fq "\"version\":\"$expected_sha\""; then
        say "${GREEN}✅ $url is healthy on release $expected_sha (attempt $attempt).${NC}"
        return 0
      fi
    fi
    say "${YELLOW}⏳ Waiting for $url/api/health (attempt $attempt/$attempts)...${NC}"
    sleep "$sleep_seconds"
  done
  return 1
}

rollback_release() {
  local reason="$1"
  local rollback_failed=0

  say "${RED}↩️ Rolling back application release: $reason${NC}" >&2
  set +e
  restore_pointer "$CURRENT_LINK" "$CURRENT_WAS_LINK" "$OLD_CURRENT_TARGET" || rollback_failed=1
  restore_pointer "$PREVIOUS_LINK" "$PREVIOUS_WAS_LINK" "$OLD_PREVIOUS_TARGET" || rollback_failed=1

  if (( rollback_failed == 0 )); then
    reload_release "$OLD_CURRENT_TARGET" "$OLD_CURRENT_SHA" || rollback_failed=1
  fi

  if (( rollback_failed == 0 )); then
    local rollback_url
    if rollback_url="$(health_url)"; then
      wait_for_health "$rollback_url" "$OLD_CURRENT_SHA" "${JUNO_ROLLBACK_HEALTH_ATTEMPTS:-6}" "${JUNO_HEALTH_SLEEP_SECONDS:-5}" "${JUNO_HEALTH_TIMEOUT_SECONDS:-12}" || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi

  if (( rollback_failed != 0 )); then
    say "${RED}❌ Automatic application rollback could not be verified. Database migrations are forward-only; inspect the preserved release and PM2 state manually.${NC}" >&2
  else
    say "${YELLOW}⚠️ Application code was restored. Database migrations were not reversed.${NC}" >&2
  fi
  ROLLBACK_NEEDED=0
  set -e
}

cleanup_staging() {
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf -- "$STAGING_DIR"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && (( ROLLBACK_NEEDED == 1 )); then
    rollback_release "deploy failed before the new release was verified"
  fi
  cleanup_staging
  exit "$status"
}

main() {
  require_command git
  require_command npm
  require_command npx
  require_command tar
  require_command find
  require_command flock
  require_command pm2
  require_command curl

  umask 077
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another deployment is already running: $LOCK_FILE"
  trap on_exit EXIT

  say "${BLUE}🚀 Starting Juno release deployment...${NC}"
  require_deploy_environment
  require_clean_checkout

  say "${YELLOW}📥 Fetching the reviewed Git ref...${NC}"
  git -C "$APP_HOME" fetch --prune origin main
  TARGET_SHA="$(git -C "$APP_HOME" rev-parse --verify "${DEPLOY_REF}^{commit}")"
  reviewed_migrations_exist "$TARGET_SHA"

  if [[ -e "$RELEASES_DIR" && ! -d "$RELEASES_DIR" ]]; then
    fail "Release storage is not a directory: $RELEASES_DIR"
  fi
  mkdir -p -- "$RELEASES_DIR"

  local release_id
  release_id="${TARGET_SHA:0:12}-$(date -u +%Y%m%d%H%M%S)-$$"
  STAGING_DIR="$RELEASES_DIR/.staging-$release_id"
  RELEASE_DIR="$RELEASES_DIR/$release_id"
  mkdir -- "$STAGING_DIR"

  say "${YELLOW}📦 Materializing commit $TARGET_SHA into a staged release...${NC}"
  git -C "$APP_HOME" archive --format=tar "$TARGET_SHA" | tar -xf - -C "$STAGING_DIR"
  install -m 600 -- "$ENV_FILE" "$STAGING_DIR/.env"
  printf '%s\n' "$TARGET_SHA" > "$STAGING_DIR/.juno-release-sha"
  validate_release "$STAGING_DIR"

  say "${YELLOW}📦 Installing application dependencies...${NC}"
  run_in_release "$STAGING_DIR" npm ci

  say "${YELLOW}💎 Generating Prisma client...${NC}"
  run_in_release "$STAGING_DIR" npx prisma generate

  say "${YELLOW}🤖 Syncing model registry inside the candidate release...${NC}"
  if ! run_in_release "$STAGING_DIR" npm run sync:models:write; then
    say "${RED}⚠️ Model sync failed — continuing with the committed registry in the candidate release.${NC}" >&2
  fi

  say "${YELLOW}🏗️ Building the candidate application...${NC}"
  run_in_release "$STAGING_DIR" npm run build

  say "${YELLOW}🎙️ Building the candidate voice relay...${NC}"
  run_in_release "$STAGING_DIR/relay" npm ci
  run_in_release "$STAGING_DIR/relay" npm run build

  say "${YELLOW}🗄️ Applying reviewed Prisma migrations...${NC}"
  if ! run_in_release "$STAGING_DIR" node scripts/baseline-production-migrations.mjs --status; then
    fail "Production migration history is not verified; refusing to deploy outside the reviewed migration ledger."
  fi
  run_in_release "$STAGING_DIR" npx prisma migrate deploy

  mv -- "$STAGING_DIR" "$RELEASE_DIR"
  STAGING_DIR=''
  validate_release "$RELEASE_DIR"

  OLD_CURRENT_TARGET="$(pointer_target "$CURRENT_LINK")"
  if [[ -z "$OLD_CURRENT_TARGET" ]]; then
    # Existing installations used the repository root as the live checkout.
    # Treat it as the first rollback target without replacing that directory.
    OLD_CURRENT_TARGET="$APP_HOME"
  else
    CURRENT_WAS_LINK=1
  fi
  validate_release "$OLD_CURRENT_TARGET"
  OLD_CURRENT_SHA="$(release_sha "$OLD_CURRENT_TARGET")"

  OLD_PREVIOUS_TARGET="$(pointer_target "$PREVIOUS_LINK")"
  if [[ -n "$OLD_PREVIOUS_TARGET" ]]; then
    PREVIOUS_WAS_LINK=1
  fi

  ROLLBACK_NEEDED=1
  atomic_symlink "$OLD_CURRENT_TARGET" "$PREVIOUS_LINK"
  atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"

  say "${YELLOW}🔄 Activating the candidate PM2 ecosystem...${NC}"
  reload_release "$RELEASE_DIR" "$TARGET_SHA"

  HEALTH_URL="$(health_url)"
  wait_for_health "$HEALTH_URL" "$TARGET_SHA" "${JUNO_HEALTH_ATTEMPTS:-30}" "${JUNO_HEALTH_SLEEP_SECONDS:-5}" "${JUNO_HEALTH_TIMEOUT_SECONDS:-12}"

  ROLLBACK_NEEDED=0
  say "${GREEN}✅ Juno release $TARGET_SHA is active at $CURRENT_LINK.${NC}"
  say "${GREEN}↩️ Previous release preserved at $PREVIOUS_LINK ($OLD_CURRENT_TARGET).${NC}"
}

main "$@"
