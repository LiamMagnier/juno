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
APP_HOME="${JUNO_APP_HOME:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
RELEASES_DIR="${JUNO_RELEASES_DIR:-$APP_HOME/releases}"
CURRENT_LINK="${JUNO_CURRENT_LINK:-$APP_HOME/current}"
PREVIOUS_LINK="${JUNO_PREVIOUS_LINK:-$APP_HOME/previous}"
ENV_FILE="${JUNO_ENV_FILE:-$APP_HOME/.env}"
LOCK_FILE="${JUNO_DEPLOY_LOCK:-$APP_HOME/.deploy.lock}"
DEPLOY_REF="${JUNO_DEPLOY_REF:-origin/main}"
DEPLOY_BUNDLE="${JUNO_DEPLOY_BUNDLE:-}"
DEPLOY_ARCHIVE="${JUNO_DEPLOY_ARCHIVE:-}"
BUILD_ARTIFACT="${JUNO_BUILD_ARTIFACT:-}"
BUILD_ARTIFACT_SHA256="${JUNO_BUILD_ARTIFACT_SHA256:-}"
BUILD_ROOT="${JUNO_BUILD_ROOT:-}"
INITIAL_RELEASE_TARGET="${JUNO_INITIAL_RELEASE_TARGET:-$APP_HOME}"
PERSISTENT_DATA_ROOT="${JUNO_PERSISTENT_DATA_ROOT:-$APP_HOME}"

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
  for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS; do
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
  if git -C "$APP_HOME" rev-parse --git-dir >/dev/null 2>&1; then
    migration_files="$(git -C "$APP_HOME" ls-tree -r --name-only "$target_sha" -- prisma/migrations | awk '/\/migration\.sql$/')"
  else
    # CI can deliver a SHA-verified `git archive` instead of a full history.
    # The archive has already been authenticated with git get-tar-commit-id;
    # validate the materialized migration ledger before building it.
    migration_files="$(find "$APP_HOME/prisma/migrations" -mindepth 2 -maxdepth 2 -type f -name migration.sql -print -quit 2>/dev/null || true)"
  fi
  [[ -n "$migration_files" ]] || fail "The reviewed commit contains no Prisma migration files"
}

verify_source_archive() {
  local archive="$1"
  local expected_sha="$2"
  local archive_sha

  # `git get-tar-commit-id` only needs the tar metadata and exits before the
  # compressed stream is exhausted. Temporarily disabling pipefail prevents
  # gzip's expected SIGPIPE from masquerading as an archive-integrity failure.
  set +o pipefail
  if ! archive_sha="$(set +o pipefail; gzip -cd "$archive" | git get-tar-commit-id)"; then
    set -o pipefail
    fail "The reviewed source archive is not a valid Git tar archive: $archive"
  fi
  set -o pipefail
  [[ "$archive_sha" == "$expected_sha" ]] || fail "The source archive commit $archive_sha does not match reviewed commit $expected_sha"
}

verify_build_artifact() {
  local artifact="$1"
  [[ -f "$artifact" ]] || fail "The reviewed build artifact is missing: $artifact"
  if [[ -n "$BUILD_ARTIFACT_SHA256" ]]; then
    [[ "$BUILD_ARTIFACT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "JUNO_BUILD_ARTIFACT_SHA256 must be a lowercase SHA-256 digest"
    require_command sha256sum
    local actual_sha
    actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
    [[ "$actual_sha" == "$BUILD_ARTIFACT_SHA256" ]] || fail "The build artifact checksum $actual_sha does not match the reviewed checksum"
  fi
}

normalize_next_build_paths() {
  local directory="$1"
  local runtime_root="${2:-$directory}"
  [[ -n "$BUILD_ROOT" && -d "$directory/.next" ]] || return 0
  require_command perl

  local file
  while IFS= read -r -d '' file; do
    if grep -Iq -- "$BUILD_ROOT" "$file"; then
      BUILD_ROOT="$BUILD_ROOT" \
        RUNTIME_ROOT="$runtime_root" \
        perl -pi -e 's/\Q$ENV{BUILD_ROOT}\E/$ENV{RUNTIME_ROOT}/g' "$file"
    fi
  done < <(find "$directory/.next" -path "$directory/.next/cache" -prune -o -type f -print0)
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
  # `mv -f` follows a symlink whose target is a directory on GNU coreutils,
  # turning a pointer replacement into an accidental move inside the target
  # directory during rollback.  `-T` makes the destination the symlink itself
  # and keeps the pointer swap atomic in both directions.
  mv -Tf -- "$temporary" "$pointer"
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
  local config_file="$directory/deploy/ecosystem.config.js"
  [[ -f "$config_file" ]] || return 1

  export GIT_SHA="$release_sha_value"
  pm2 start "$config_file" --update-env || pm2 reload "$config_file" --update-env || true
  pm2 save
  verify_pm2_ecosystem "$config_file"
}

verify_pm2_ecosystem() {
  local config_file="${1:-}"
  local expected='["juno-backend","juno-scheduler","juno-work","juno-work-scheduler","juno-research","juno-work-triggers","juno-import-recovery","juno-code-sweeper","juno-voice-relay"]'
  PM2_CONFIG="$config_file" EXPECTED_PM2="$expected" node -e '
    const { execSync } = require("child_process");
    const expected = JSON.parse(process.env.EXPECTED_PM2);
    const configFile = process.env.PM2_CONFIG || "";

    for (let attempt = 1; attempt <= 6; attempt++) {
      let rows = [];
      try {
        const out = execSync("pm2 jlist", { encoding: "utf8" });
        rows = JSON.parse(out);
      } catch {}

      const missing = expected.filter((name) => !rows.some((row) => row.name === name && row.pm2_env?.status === "online"));
      if (missing.length === 0) {
        console.log(`PM2 ecosystem healthy: ${expected.join(", ")}`);
        process.exit(0);
      }

      console.log(`Waiting for PM2 services to be online (attempt ${attempt}/6): ${missing.join(", ")}`);
      for (const name of missing) {
        if (configFile) {
          try {
            execSync(`pm2 start "${configFile}" --only "${name}" --update-env`, { stdio: "ignore" });
          } catch {}
        }
        try {
          execSync(`pm2 restart "${name}" --update-env`, { stdio: "ignore" });
        } catch {}
      }
      try {
        execSync("sleep 2");
      } catch {}
    }

    let rows = [];
    try {
      rows = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
    } catch {}
    const backendOnline = rows.some((row) => row.name === "juno-backend" && row.pm2_env?.status === "online");
    const voiceRelayOnline = rows.some((row) => row.name === "juno-voice-relay" && row.pm2_env?.status === "online");
    if (!backendOnline) {
      console.error("Critical service juno-backend failed to come online.");
      process.exit(1);
    }
    if (!voiceRelayOnline) {
      console.error("Critical service juno-voice-relay failed to come online.");
      process.exit(1);
    }
    console.log("Core PM2 backend and voice relay are online; continuing deployment.");
  '
}

wait_for_voice_relay_health() {
  local release_dir="$1"
  say "${YELLOW}🎙️ Verifying voice relay health and WebSocket handshake...${NC}"
  if [[ -f "$release_dir/scripts/verify-voice-relay.mjs" ]]; then
    run_in_release "$release_dir" node scripts/verify-voice-relay.mjs || fail "Voice relay health verification failed."
  fi
}

prune_old_releases() {
  local releases_dir="$1"
  local current_target="$2"
  local previous_target="$3"
  local keep_count="${4:-2}"

  [[ -d "$releases_dir" ]] || return 0

  # Clean up any abandoned staging directories
  find "$releases_dir" -mindepth 1 -maxdepth 1 -name '.staging-*' -exec rm -rf -- {} + 2>/dev/null || true

  # Resolve canonical paths to protect active links
  local current_real=""
  local previous_real=""
  [[ -n "$current_target" ]] && current_real="$(cd -- "$current_target" 2>/dev/null && pwd -P || echo "$current_target")"
  [[ -n "$previous_target" ]] && previous_real="$(cd -- "$previous_target" 2>/dev/null && pwd -P || echo "$previous_target")"

  # Find all release directories sorted from oldest to newest
  local rel_dirs=()
  while IFS= read -r dir; do
    [[ -n "$dir" ]] && rel_dirs+=("$dir")
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | sort)

  local total="${#rel_dirs[@]}"
  if (( total <= keep_count )); then
    return 0
  fi

  local to_remove=$(( total - keep_count ))
  for (( i = 0; i < to_remove; i++ )); do
    local candidate="${rel_dirs[i]}"
    local candidate_real
    candidate_real="$(cd -- "$candidate" 2>/dev/null && pwd -P || echo "$candidate")"
    if [[ -n "$candidate_real" && "$candidate_real" != "$current_real" && "$candidate_real" != "$previous_real" ]]; then
      say "${YELLOW}🧹 Pruning old release: $(basename "$candidate")...${NC}"
      rm -rf -- "$candidate" || true
    fi
  done
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

rollback_active_release() {
  local current_target previous_target previous_sha
  current_target="$(pointer_target "$CURRENT_LINK")"
  previous_target="$(pointer_target "$PREVIOUS_LINK")"
  [[ -n "$current_target" ]] || fail "No active release pointer exists: $CURRENT_LINK"
  [[ -n "$previous_target" ]] || fail "No previous release pointer exists: $PREVIOUS_LINK"
  validate_release "$previous_target"
  previous_sha="$(release_sha "$previous_target")"

  say "${YELLOW}↩️ Switching current from $current_target to $previous_target...${NC}"
  atomic_symlink "$current_target" "$PREVIOUS_LINK"
  atomic_symlink "$previous_target" "$CURRENT_LINK"
  reload_release "$previous_target" "$previous_sha"

  local url
  url="$(health_url)"
  wait_for_health "$url" "$previous_sha" "${JUNO_ROLLBACK_HEALTH_ATTEMPTS:-6}" \
    "${JUNO_HEALTH_SLEEP_SECONDS:-5}" "${JUNO_HEALTH_TIMEOUT_SECONDS:-12}" \
    || fail "Rollback did not restore a healthy release"
  say "${GREEN}✅ Application rollback verified on $previous_sha.${NC}"
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
  require_command gzip
  require_command find
  require_command flock
  require_command pm2
  require_command curl

  if [[ -n "$BUILD_ARTIFACT" ]]; then
    verify_build_artifact "$BUILD_ARTIFACT"
  fi

  if [[ "${1:-}" == "--rollback" ]]; then
    umask 077
    exec 9>"$LOCK_FILE"
    flock -n 9 || fail "Another deployment is already running: $LOCK_FILE"
    require_deploy_environment
    rollback_active_release
    exit 0
  fi

  umask 077
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another deployment is already running: $LOCK_FILE"
  trap on_exit EXIT

  say "${BLUE}🚀 Starting Juno release deployment...${NC}"
  require_deploy_environment
  if [[ -z "$DEPLOY_ARCHIVE" ]]; then
    require_clean_checkout
  fi

  say "${YELLOW}📥 Fetching the reviewed Git ref...${NC}"
  if [[ -n "$DEPLOY_ARCHIVE" ]]; then
    [[ -f "$DEPLOY_ARCHIVE" ]] || fail "The reviewed source archive is missing: $DEPLOY_ARCHIVE"
    [[ "$DEPLOY_REF" =~ ^[0-9a-f]{40}$ ]] || fail "JUNO_DEPLOY_REF must be a full SHA when deploying an archive"
    verify_source_archive "$DEPLOY_ARCHIVE" "$DEPLOY_REF"
    TARGET_SHA="$DEPLOY_REF"
  elif [[ -n "$DEPLOY_BUNDLE" ]]; then
    git -C "$APP_HOME" fetch --no-tags "$DEPLOY_BUNDLE" "$DEPLOY_REF"
    TARGET_SHA="$(git -C "$APP_HOME" rev-parse --verify "${DEPLOY_REF}^{commit}")"
  else
    git -C "$APP_HOME" fetch --prune origin main
    TARGET_SHA="$(git -C "$APP_HOME" rev-parse --verify "${DEPLOY_REF}^{commit}")"
  fi
  reviewed_migrations_exist "$TARGET_SHA"

  if [[ -e "$RELEASES_DIR" && ! -d "$RELEASES_DIR" ]]; then
    fail "Release storage is not a directory: $RELEASES_DIR"
  fi
  mkdir -p -- "$RELEASES_DIR"

  # Pre-flight cleanup of old releases and staging directories to ensure disk space
  prune_old_releases "$RELEASES_DIR" "$CURRENT_LINK" "$PREVIOUS_LINK" 2

  local release_id
  release_id="${TARGET_SHA:0:12}-$(date -u +%Y%m%d%H%M%S)-$$"
  STAGING_DIR="$RELEASES_DIR/.staging-$release_id"
  RELEASE_DIR="$RELEASES_DIR/$release_id"
  mkdir -- "$STAGING_DIR"

  say "${YELLOW}📦 Materializing commit $TARGET_SHA into a staged release...${NC}"
  if [[ -n "$DEPLOY_ARCHIVE" ]]; then
    tar -xzf "$DEPLOY_ARCHIVE" -C "$STAGING_DIR"
  else
    git -C "$APP_HOME" archive --format=tar "$TARGET_SHA" | tar -xf - -C "$STAGING_DIR"
  fi
  if [[ -n "$BUILD_ARTIFACT" ]]; then
    say "${YELLOW}📦 Installing the reviewed CI build artifact...${NC}"
    tar -xzf "$BUILD_ARTIFACT" -C "$STAGING_DIR" --no-same-owner --no-same-permissions
  fi
  install -m 600 -- "$ENV_FILE" "$STAGING_DIR/.env"
  # Storage and logs are deployment-scoped persistent state. Keep them outside
  # the immutable release and expose them through symlinks so a release switch
  # cannot strand uploaded files or split logs across release directories.
  mkdir -p -- "$PERSISTENT_DATA_ROOT/.uploads" "$PERSISTENT_DATA_ROOT/logs"
  ln -s -- "$PERSISTENT_DATA_ROOT/.uploads" "$STAGING_DIR/.uploads"
  ln -s -- "$PERSISTENT_DATA_ROOT/logs" "$STAGING_DIR/logs"
  printf '%s\n' "$TARGET_SHA" > "$STAGING_DIR/.juno-release-sha"
  validate_release "$STAGING_DIR"

  if [[ -n "$BUILD_ARTIFACT" ]]; then
    [[ -x "$STAGING_DIR/node_modules/.bin/prisma" ]] || fail "The CI build artifact is missing the Prisma CLI"
    [[ -f "$STAGING_DIR/.next/BUILD_ID" ]] || fail "The CI build artifact is missing the Next.js build"
    [[ -f "$STAGING_DIR/relay/dist/server.js" ]] || fail "The CI build artifact is missing the voice relay build"
    [[ -f "$STAGING_DIR/runner/agent-core/dist/index.js" ]] || fail "The CI build artifact is missing the vendored runner build"
    # Scan the temporary tree, but point manifests at the final immutable path
    # because the staging directory is renamed immediately after this branch.
    normalize_next_build_paths "$STAGING_DIR" "$RELEASE_DIR"
  else
    say "${YELLOW}📦 Installing application dependencies...${NC}"
    run_in_release "$STAGING_DIR" npm ci

    say "${YELLOW}💎 Generating Prisma client...${NC}"
    run_in_release "$STAGING_DIR" npx prisma generate

    say "${YELLOW}🏗️ Building the candidate application...${NC}"
    run_in_release "$STAGING_DIR" npm run build

    say "${YELLOW}🎙️ Building the candidate voice relay...${NC}"
    run_in_release "$STAGING_DIR/relay" npm ci
    run_in_release "$STAGING_DIR/relay" npm run build

    say "${YELLOW}🧠 Building the vendored runner core...${NC}"
    run_in_release "$STAGING_DIR" npm ci --prefix runner/agent-core
    run_in_release "$STAGING_DIR" npm run build --prefix runner/agent-core
  fi

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
    # The CI bootstrap may keep the Git source mirror elsewhere, so make the
    # initial live target explicit rather than accidentally rolling back to it.
    OLD_CURRENT_TARGET="$INITIAL_RELEASE_TARGET"
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
  wait_for_voice_relay_health "$RELEASE_DIR"

  ROLLBACK_NEEDED=0
  say "${GREEN}✅ Juno release $TARGET_SHA is active at $CURRENT_LINK.${NC}"
  say "${GREEN}↩️ Previous release preserved at $PREVIOUS_LINK ($OLD_CURRENT_TARGET).${NC}"

  # Prune older releases to keep disk healthy
  prune_old_releases "$RELEASES_DIR" "$RELEASE_DIR" "$OLD_CURRENT_TARGET" "${JUNO_KEEP_RELEASES:-2}"
}

main "$@"
