#!/bin/bash
# Release gates for a Juno native release.
#
# Every check here exists because the corresponding mistake was actually made,
# or was one step away from being made. Run from the repository root:
#
#     ./scripts/release-gates.sh [path/to/JunoMac.app]
#
# Exit code 0 means every gate passed. Any failure is release-blocking.
set -uo pipefail

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }

echo "Juno release gates"
echo

# ---------------------------------------------------------------------------
# 1. The backfill migration must be the typed version from origin/main.
#
# The branch copy and the origin/main copy are the same 44 lines with the same
# statements; only the NULL typing differs, so a line count or a casual diff
# read will not catch a regression. The bare-NULL form already failed in
# production because an untyped NULL in the INSERT ... SELECT gives Postgres no
# column type to infer.
# ---------------------------------------------------------------------------
echo "Migration integrity"
MIGRATION="prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql"
if [ ! -f "$MIGRATION" ]; then
    fail "$MIGRATION is missing"
else
    TYPED=$(grep -c 'NULL::timestamp' "$MIGRATION")
    if [ "$TYPED" -eq 22 ]; then
        pass "$MIGRATION has 22 typed NULL::timestamp"
    else
        fail "$MIGRATION has $TYPED typed NULL::timestamp, expected 22"
        info "Take this file verbatim from origin/main; never keep the branch copy."
    fi
fi
echo

# ---------------------------------------------------------------------------
# 2. Client and server must agree on the contract version.
#
# The native client compares this for exact equality and refuses the session
# otherwise, surfacing "This version of Juno is not compatible with the server".
# Shipping apps built against a contract the deployed server does not serve
# means nobody can sign in.
# ---------------------------------------------------------------------------
echo "Contract parity"
NATIVE_CONTRACT="native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift"
BACKEND_CONTRACT="src/lib/api-v1.ts"
NATIVE_VERSION=$(grep -oE 'version = "[0-9.]+"' "$NATIVE_CONTRACT" 2>/dev/null | grep -oE '[0-9.]+' | head -1)
BACKEND_VERSION=$(grep -oE 'CONTRACT_VERSION = "[0-9.]+"' "$BACKEND_CONTRACT" 2>/dev/null | grep -oE '[0-9.]+' | head -1)
if [ -z "$NATIVE_VERSION" ] || [ -z "$BACKEND_VERSION" ]; then
    fail "could not read both contract versions (native='$NATIVE_VERSION' backend='$BACKEND_VERSION')"
elif [ "$NATIVE_VERSION" = "$BACKEND_VERSION" ]; then
    pass "native and backend both declare contract $NATIVE_VERSION"
else
    fail "contract mismatch: native $NATIVE_VERSION, backend $BACKEND_VERSION"
    info "Sign-in fails with 'This version of Juno is not compatible with the server'."
    info "Deploy the backend that serves $NATIVE_VERSION before building the apps."
fi

# The check above proves the release commit is *self-consistent*. It does not
# prove the deployed server serves that contract — the two are different
# failures, and only the second one strands users who already installed the app.
# JUNO_CHECK_LIVE_CONTRACT=1 adds the live check (needs network).
if [ "${JUNO_CHECK_LIVE_CONTRACT:-0}" = "1" ]; then
    LIVE=$(curl -fsS -m 15 https://chat.liams.dev/api/v1/auth/session 2>/dev/null \
        | grep -oE '"contractVersion":"[0-9.]+"' | grep -oE '[0-9.]+' | head -1)
    if [ -z "$LIVE" ]; then
        # The session route requires a bearer token, so an unauthenticated probe
        # cannot read the version. Fall back to the response header, which the
        # change-stream route sets unconditionally.
        LIVE=$(curl -fsS -m 15 -D - -o /dev/null https://chat.liams.dev/api/v1/changes/stream 2>/dev/null \
            | grep -i "^x-juno-contract-version:" | tr -d '\r' | awk '{print $2}')
    fi
    if [ -z "$LIVE" ]; then
        fail "could not read the live contract version from production"
        info "Verify manually before shipping; an unauthenticated probe may be refused."
    elif [ "$LIVE" = "$NATIVE_VERSION" ]; then
        pass "production serves contract $LIVE, matching the build"
    else
        fail "production serves contract $LIVE but this build requires $NATIVE_VERSION"
        info "Deploy the backend release before building the downloadable apps."
    fi
fi
echo

# ---------------------------------------------------------------------------
# 3. Release builds must point at production.
# ---------------------------------------------------------------------------
echo "Production base URL"
NATIVE_APP_SOURCES="native/macOS/JunoMac/App native/iOS/JunoMobile/App"
if grep -rn "localhost\|127\.0\.0\.1\|ngrok\|\.local:" $NATIVE_APP_SOURCES >/dev/null 2>&1; then
    fail "a local or temporary host appears in native app sources"
    grep -rn "localhost\|127\.0\.0\.1\|ngrok\|\.local:" $NATIVE_APP_SOURCES | sed 's/^/        /'
else
    pass "no localhost or temporary host in native app sources"
fi
for app in JunoMac JunoMobile; do
    dir=$(echo $NATIVE_APP_SOURCES | tr ' ' '\n' | grep "$app")
    if grep -rq "https://chat.liams.dev" "$dir" 2>/dev/null; then
        pass "$app targets https://chat.liams.dev"
    else
        fail "$app does not reference the production base URL"
    fi
done
echo

# ---------------------------------------------------------------------------
# 4. Release binaries must not contain the DEBUG preview harness.
#
# Optional: only runs when a built .app is passed. The harness is wrapped in
# `#if DEBUG` so this should always hold, but a release that shipped a preview
# transport would silently talk to fixtures instead of production.
# ---------------------------------------------------------------------------
if [ $# -ge 1 ]; then
    echo "Release binary"
    APP="$1"
    BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
    if [ ! -f "$BIN" ]; then
        fail "no executable at $BIN"
    else
        HITS=$(LC_ALL=C grep -ac "juno-ui-preview\|juno-code-ui-preview\|juno-preview-scenario" "$BIN" 2>/dev/null | head -1)
        SYMS=$(nm "$BIN" 2>/dev/null | grep -c "JunoPreviewContainer\|CodePreviewScenario\|PreviewFixture" | head -1)
        HITS=${HITS:-0}; SYMS=${SYMS:-0}
        if [ "$HITS" -eq 0 ] && [ "$SYMS" -eq 0 ]; then
            pass "no preview launch flags or preview symbols in $(basename "$APP")"
        else
            fail "preview harness present in release binary ($HITS flags, $SYMS symbols)"
        fi
    fi
    echo
fi

# ---------------------------------------------------------------------------
# 5. Same-commit requirement: the tree must be clean and pushed.
# ---------------------------------------------------------------------------
echo "Source state"
if [ -n "$(git status --porcelain)" ]; then
    fail "worktree is dirty — the built artifacts would not match any commit"
else
    pass "worktree clean"
fi
for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD; do
    if [ -e "$(git rev-parse --git-dir)/$marker" ]; then
        fail "$marker present — an integration is in progress"
    fi
done
[ $FAILED -eq 0 ] && pass "no merge, rebase or cherry-pick in progress"
echo

if [ $FAILED -eq 0 ]; then
    printf '\033[32mAll release gates passed.\033[0m\n'
else
    printf '\033[31mRelease gates FAILED — do not ship.\033[0m\n'
fi
exit $FAILED
