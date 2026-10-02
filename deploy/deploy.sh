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
# One lock per live root, never per source tree. Both callers run this script
# from a per-run stage (JUNO_APP_HOME=~/.juno-source-<RUN_ID>), so a lock under
# APP_HOME was a new file on every run and never contended: a CI deploy stuck
# in `pm2 startOrReload` from 2026-08-26 held its private lock for 26 days
# while other deploys ran beside it. The directory that holds `current` is the
# one path every deploy and every --rollback on a host shares.
LOCK_FILE="${JUNO_DEPLOY_LOCK:-$(dirname -- "$CURRENT_LINK")/.deploy.lock}"
DEPLOY_REF="${JUNO_DEPLOY_REF:-origin/main}"
DEPLOY_BUNDLE="${JUNO_DEPLOY_BUNDLE:-}"
DEPLOY_ARCHIVE="${JUNO_DEPLOY_ARCHIVE:-}"
BUILD_ARTIFACT="${JUNO_BUILD_ARTIFACT:-}"
BUILD_ARTIFACT_SHA256="${JUNO_BUILD_ARTIFACT_SHA256:-}"
BUILD_ROOT="${JUNO_BUILD_ROOT:-}"
INITIAL_RELEASE_TARGET="${JUNO_INITIAL_RELEASE_TARGET:-$APP_HOME}"
PERSISTENT_DATA_ROOT="${JUNO_PERSISTENT_DATA_ROOT:-$APP_HOME}"
PM2_SERVICE_STARTER="${JUNO_PM2_SERVICE_STARTER:-$SCRIPT_DIR/../scripts/reconcile-pm2-service.mjs}"

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
  if ! archive_sha="$(set +o pipefail; gzip -cd "$archive" 2>/dev/null | git get-tar-commit-id)"; then
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
  local files=()
  while IFS= read -r -d '' file; do
    if grep -IqF -- "$BUILD_ROOT" "$file"; then
      files+=("$file")
    fi
  done < <(find "$directory/.next" -path "$directory/.next/cache" -prune -o -type f -print0)
  (( ${#files[@]} > 0 )) || return 0

  # This is a text substitution, so it is only safe if every occurrence of the
  # build root in the build IS the build root. A root that also begins longer
  # names is not: a build made in /app had "/app" inside "/app-auth",
  # "/apple-icon.png" and a user-agent regex (/\/applecoremedia\//), and the
  # rewritten release booted, then failed every request on "Invalid regular
  # expression flags". Refuse it while the release is still staged — before
  # migrations run and before anything is switched on.
  local collision
  collision="$(BUILD_ROOT="$BUILD_ROOT" perl -ne '
    chomp;
    if (/\Q$ENV{BUILD_ROOT}\E[A-Za-z0-9_.-]/) {
      my $from = $-[0] > 40 ? $-[0] - 40 : 0;
      print "$ARGV: ", substr($_, $from, 80 + length($ENV{BUILD_ROOT}));
      exit;
    }
  ' "${files[@]}")"
  [[ -z "$collision" ]] \
    || fail "Build root $BUILD_ROOT is also part of longer names in the build, so rewriting it would corrupt the release. Build in a directory whose path occurs nowhere else. First collision: $collision"

  for file in "${files[@]}"; do
    BUILD_ROOT="$BUILD_ROOT" \
      RUNTIME_ROOT="$runtime_root" \
      perl -pi -e 's/\Q$ENV{BUILD_ROOT}\E/$ENV{RUNTIME_ROOT}/g' "$file"
  done
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
  local declared_apps
  local status=0
  [[ -f "$config_file" ]] || return 1

  export GIT_SHA="$release_sha_value"
  # Every step reports its own failure rather than leaning on `set -e`, which
  # is off when rollback_release calls this. Nothing touches PM2 until the
  # list of apps this release declares has been read.
  declared_apps="$(declared_pm2_apps "$config_file")" || return 1
  # Keep in-memory PM2 in sync with the local binary, but only when they
  # differ: `pm2 update` respawns the daemon and resurrects every app, and on
  # the 1 GB VM that second boot storm on top of the reload below is what
  # pushed the box into swap (2026-10-02).
  if ! pm2_daemon_matches_binary; then
    pm2 update 2>/dev/null || true
  fi
  # PM2 reloads an app with the script and interpreter it was first started
  # with: `startOrReload` cannot change how an app is launched. An app whose
  # launch changed is deleted first so the reload below starts it fresh.
  delete_relaunched_pm2_apps "$config_file" || true
  # `pm2 start`/`pm2 reload` can throw when an older dump contains a process
  # id whose process object has disappeared.  Keep the bulk reconciliation
  # best-effort; verify_pm2_ecosystem repairs each missing service below from
  # a one-service ecosystem so a stale slot cannot prevent a new relay from
  # being created.
  pm2 startOrReload "$config_file" --update-env || true
  retire_undeclared_pm2_apps "$declared_apps" || status=1
  verify_pm2_ecosystem "$config_file" "$declared_apps" || status=1
  # Persist the reconciled list — retired apps gone, repaired ones present —
  # so a reboot resurrects this release's ecosystem and nothing else. Saved
  # even when a step above failed: which apps belong is already settled, and
  # the dump from before this reload may still name apps that do not.
  pm2 save || status=1
  return "$status"
}

# True unless PM2 reports its in-memory daemon is older than the binary
# (it prints "In-memory PM2 is out-of-date" on every command until updated).
pm2_daemon_matches_binary() {
  ! pm2 ping 2>&1 | grep -qi "out-of-date"
}

# Deletes every declared app whose running script or interpreter differs from
# what the ecosystem now declares (e.g. `npm run <task>` → the script itself).
delete_relaunched_pm2_apps() {
  PM2_CONFIG="$1" node -e '
    const path = require("path");
    const { execFileSync, spawnSync } = require("child_process");
    const configFile = path.resolve(process.env.PM2_CONFIG);
    const apps = require(configFile).apps;
    const lines = execFileSync("pm2", ["jlist"], { encoding: "utf8" }).split("\n").reverse();
    let rows = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) { rows = parsed; break; }
      } catch {}
    }
    const wantsInterpreter = (app) => app.interpreter ?? "node";
    for (const app of apps) {
      const running = rows.find((row) => row?.name === app.name);
      if (!running || !app.script) continue;
      const env = running.pm2_env ?? {};
      const declaredScript = path.isAbsolute(app.script) ? app.script : path.resolve(app.cwd ?? ".", app.script);
      const scriptChanged = path.basename(env.pm_exec_path ?? "") !== path.basename(declaredScript);
      const interpreterChanged =
        app.interpreter !== undefined && path.basename(env.exec_interpreter ?? "") !== path.basename(wantsInterpreter(app));
      const argsChanged = (env.node_args ?? []).join(" ") !== (app.interpreter_args ?? "").split(" ").filter(Boolean).join(" ");
      if (scriptChanged || interpreterChanged || (app.interpreter_args !== undefined && argsChanged)) {
        console.log(`Relaunching PM2 app ${app.name}: its launch command changed.`);
        spawnSync("pm2", ["delete", app.name], { stdio: "inherit" });
      }
    }
  '
}

# Prints the names of the apps an ecosystem file declares, as a JSON array:
# what PM2 must be running once that release is active, no more and no less.
declared_pm2_apps() {
  PM2_CONFIG="$1" node -e '
    const configFile = require("path").resolve(process.env.PM2_CONFIG);
    const apps = require(configFile).apps;
    const names = Array.isArray(apps) ? apps.map((app) => app?.name) : [];
    if (names.length === 0 || !names.every((name) => typeof name === "string" && name !== "")) {
      console.error(`${configFile} must declare at least one PM2 app, and name every app it declares.`);
      process.exit(1);
    }
    console.log(JSON.stringify(names));
  '
}

# PM2 never removes an app because the ecosystem it is given stops declaring
# it: `startOrReload` starts and reloads the apps the file names and leaves
# every other process running, with a cwd that now resolves to whichever
# release `current` points at. A rollback to c3004795 on 2026-09-22 left the
# failed release's juno-memory-dreamer crash-looping every ~3 s for 40 minutes
# on `npm error Missing script: "memory:dreamer"`.
#
# The juno- prefix is the ecosystem's namespace. Any juno-* app the release
# being activated does not declare is deleted here, before `pm2 save`, so the
# dump PM2 resurrects after a reboot agrees. Other PM2 apps are never touched.
retire_undeclared_pm2_apps() {
  DECLARED_PM2="$1" node -e '
    const { execFileSync, spawnSync } = require("child_process");
    const declared = JSON.parse(process.env.DECLARED_PM2 || "null");
    if (!Array.isArray(declared) || declared.length === 0) {
      console.error("Refusing to retire PM2 apps without the list of apps the release declares.");
      process.exit(1);
    }

    // jlist prints its JSON on one line; notices PM2 prints around it (such as
    // "[PM2] Spawning PM2 daemon") are lines of their own.
    function undeclaredJunoApps() {
      const lines = execFileSync("pm2", ["jlist"], { encoding: "utf8" }).split("\n").reverse();
      for (const line of lines) {
        let rows;
        try {
          rows = JSON.parse(line);
        } catch {
          continue;
        }
        if (!Array.isArray(rows)) continue;
        const names = new Set(rows.map((row) => row?.name));
        return [...names].filter(
          (name) => typeof name === "string" && name.startsWith("juno-") && !declared.includes(name),
        );
      }
      throw new Error("pm2 jlist printed no process list");
    }

    try {
      for (const name of undeclaredJunoApps()) {
        console.log(`Retiring PM2 app ${name}: the release being activated does not declare it.`);
        spawnSync("pm2", ["delete", name], { stdio: "inherit" });
      }
      const remaining = undeclaredJunoApps();
      if (remaining.length > 0) throw new Error(`still running: ${remaining.join(", ")}`);
    } catch (error) {
      console.error(`Could not retire undeclared PM2 apps: ${error.message}`);
      process.exit(1);
    }
  '
}

verify_pm2_ecosystem() {
  local config_file="${1:-}"
  # The apps to verify are the ones the ecosystem being activated declares
  # (declared_pm2_apps), never a list kept in this script. The script that
  # runs a rollback is the newer release's own, so a list kept here named the
  # failed release's new apps and "repaired" them onto the older code.
  local expected="${2:-}"
  PM2_CONFIG="$config_file" EXPECTED_PM2="$expected" PM2_SERVICE_STARTER="$PM2_SERVICE_STARTER" node -e '
    const { execFileSync, execSync } = require("child_process");
    const expected = JSON.parse(process.env.EXPECTED_PM2 || "null");
    if (!Array.isArray(expected) || expected.length === 0) {
      console.error("Refusing to verify PM2 without the list of apps the release declares.");
      process.exit(1);
    }
    const configFile = process.env.PM2_CONFIG || "";
    const serviceStarter = process.env.PM2_SERVICE_STARTER || "";

    function parseJlist(out) {
      if (!out || typeof out !== "string") return [];
      try {
        const start = out.indexOf("[");
        const end = out.lastIndexOf("]");
        if (start !== -1 && end !== -1 && end > start) {
          return JSON.parse(out.slice(start, end + 1));
        }
      } catch (err) {
        console.error("Failed to parse pm2 jlist:", err.message);
      }
      return [];
    }

    function isOnline(row) {
      return row.pm2_env?.status === "online" || row.status === "online";
    }

    for (let attempt = 1; attempt <= 20; attempt++) {
      let rows = [];
      try {
        const out = execSync("pm2 jlist", { encoding: "utf8" });
        rows = parseJlist(out);
      } catch {}

      const missing = expected.filter((name) => !rows.some((row) => row.name === name && row.pm2_env?.status === "online"));
      if (missing.length === 0) {
        console.log(`PM2 ecosystem healthy: ${expected.join(", ")}`);
        process.exit(0);
      }

      console.log(`Waiting for PM2 services to be online (attempt ${attempt}/20): ${missing.join(", ")}`);
      // Only repair services that are dead/errored/missing after giving initial boot time
      if (attempt >= 4) {
        for (const name of missing) {
          const row = rows.find((r) => r.name === name);
          const status = row?.pm2_env?.status || row?.status;
          if (!row || status === "errored" || status === "stopped") {
            let started = false;
            if (configFile && serviceStarter) {
              try {
                execFileSync("node", [serviceStarter, "--config", configFile, "--service", name], {
                  stdio: "inherit",
                });
                started = true;
              } catch {}
            }
            if (!started) {
              try {
                execFileSync("pm2", ["restart", name, "--update-env"], { stdio: "ignore" });
              } catch {}
            }
          }
        }
      }
      try {
        execSync("sleep 3");
      } catch {}
    }

    let rows = [];
    try {
      rows = parseJlist(execSync("pm2 jlist", { encoding: "utf8" }));
    } catch {}
    const backendOnline = rows.some((row) => row.name === "juno-backend" && isOnline(row));
    const voiceRelayOnline = rows.some((row) => row.name === "juno-voice-relay" && isOnline(row));
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
  [[ -f "$release_dir/scripts/verify-voice-relay.mjs" ]] || return 0
  # Several tries, like the app health wait above: the relay restarts in the
  # same reload, and on the 1 GB VM one 10 s probe right after it rolled back
  # a release that was otherwise healthy (2026-10-02).
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if VOICE_RELAY_TIMEOUT_MS="${VOICE_RELAY_TIMEOUT_MS:-20000}" \
      run_in_release "$release_dir" node scripts/verify-voice-relay.mjs; then
      return 0
    fi
    say "${YELLOW}Voice relay not ready yet (attempt ${attempt}/6); retrying in 10s...${NC}"
    sleep 10
  done
  fail "Voice relay health verification failed."
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

# Held for the whole transaction, deploy or --rollback. The holder writes who
# it is into the file, so a refused deploy can say which process to look at: a
# hung deploy is otherwise invisible. The file is opened for append, not
# truncated, so the refused deploy does not erase that note before reading it.
acquire_deploy_lock() {
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    local holder
    holder="$(cat -- "$LOCK_FILE" 2>/dev/null || true)"
    fail "Another deployment is already running${holder:+ ($holder)}: $LOCK_FILE"
  fi
  printf 'pid %s since %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE" || true
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

  umask 077
  acquire_deploy_lock

  if [[ "${1:-}" == "--rollback" ]]; then
    require_deploy_environment
    rollback_active_release
    exit 0
  fi

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
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -name '.staging-*' -exec rm -rf -- {} + 2>/dev/null || true
  # Only when space is short: deleting a release is tens of thousands of
  # files, and on a VM under memory pressure that alone held a deploy for 15
  # minutes (2026-10-02). The post-activation prune below runs either way.
  local free_kb
  free_kb="$(df -Pk -- "$RELEASES_DIR" | awk 'NR == 2 { print $4 }')"
  if [[ -z "$free_kb" || "$free_kb" -lt 5242880 ]]; then
    prune_old_releases "$RELEASES_DIR" "$CURRENT_LINK" "$PREVIOUS_LINK" 1
  fi

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
