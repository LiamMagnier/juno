#!/bin/bash
# Release gates for a Juno native release.
#
# Every check here exists because the corresponding mistake was actually made,
# or was one step away from being made. Run from the repository root:
#
#     ./scripts/release-gates.sh [path/to/Juno.app]
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
# `\.local:` alone also matched Swift's `case .local:` — Juno Code has a `.local`
# execution environment — so this gate failed on every build and would have been
# learned-ignored. A hostname has a name character immediately before `.local`;
# an enum case has a space.
echo "Production base URL"
NATIVE_APP_SOURCES="native/macOS/JunoDesktop/App native/iOS/JunoMobile/App"
if grep -rn "localhost\|127\.0\.0\.1\|ngrok\|[A-Za-z0-9-]\.local:" $NATIVE_APP_SOURCES >/dev/null 2>&1; then
    fail "a local or temporary host appears in native app sources"
    grep -rn "localhost\|127\.0\.0\.1\|ngrok\|[A-Za-z0-9-]\.local:" $NATIVE_APP_SOURCES | sed 's/^/        /'
else
    pass "no localhost or temporary host in native app sources"
fi
# The URL is declared once, in JunoBackend, and both apps dial that constant.
# An earlier version of this gate grepped each app directory for the literal
# host, which passed only while the URL was duplicated per app — exactly the
# duplication that lets one client drift onto a different backend. It now
# checks the single declaration and that each app actually uses it.
BACKEND_CONST="native/Packages/JunoNativeKit/Sources/JunoCore/JunoBackend.swift"
if grep -q 'productionURLString = "https://chat.liams.dev"' "$BACKEND_CONST" 2>/dev/null; then
    pass "JunoBackend declares https://chat.liams.dev"
else
    fail "$BACKEND_CONST does not declare the production base URL"
fi
for app in JunoDesktop JunoMobile; do
    dir=$(echo $NATIVE_APP_SOURCES | tr ' ' '\n' | grep "$app")
    if grep -rq "JunoBackend.productionURLString" "$dir" 2>/dev/null; then
        pass "$app dials JunoBackend.productionURLString"
    else
        fail "$app does not use the shared production base URL"
    fi
done
# A hardcoded host anywhere in the app sources would bypass the constant.
if grep -rn "https://chat.liams.dev" $NATIVE_APP_SOURCES >/dev/null 2>&1; then
    fail "an app source hardcodes the backend host instead of using JunoBackend"
    grep -rn "https://chat.liams.dev" $NATIVE_APP_SOURCES | sed 's/^/        /'
else
    pass "no app source hardcodes the backend host"
fi
echo

# ---------------------------------------------------------------------------
# 4. The active JunoDesktop Code workbench must expose its local preview, remote
# task monitor, and composed agent runtime. These source-level checks prevent
# the package and the active app shell from drifting apart again.
# ---------------------------------------------------------------------------
echo "Code workbench wiring"
if npm run code:preview:check >/dev/null 2>&1; then
    pass "active JunoDesktop Code workbench exposes the local preview"
else
    fail "active JunoDesktop Code workbench is missing local preview wiring"
fi
if npm run code:remote:check >/dev/null 2>&1; then
    pass "active JunoDesktop Code composer exposes Cloud/Remote task dispatch"
else
    fail "active JunoDesktop Code composer is missing Cloud/Remote wiring"
fi
if npm run code:runtime:check >/dev/null 2>&1; then
    pass "MCP, hooks, Computer Use, subagents, terminal, preview, and remote monitoring are composed"
else
    fail "active Juno Code runtime is missing a core capability composition"
fi
echo

# ---------------------------------------------------------------------------
# 4b. The irreversible macOS publication path must fail closed when the runner
# only has an Apple Development identity. This is a source gate in addition to
# the protected workflow: a local release-script change must not silently turn
# a development DMG into a public Stable download.
# ---------------------------------------------------------------------------
echo "macOS publication safety"
if bash -n native/Scripts/release-macos.sh \
    && grep -q 'Refusing to publish a development-signed artifact' native/Scripts/release-macos.sh \
    && grep -q 'apple-actions/import-codesign-certs' .github/workflows/release-macos.yml \
    && grep -q 'JUNO_NOTARY_PROFILE' .github/workflows/release-macos.yml; then
    pass "macOS publication requires notarization and has a protected workflow"
else
    fail "macOS publication safety gate is incomplete"
fi
echo

# ---------------------------------------------------------------------------
# 5. Release binaries must not contain the DEBUG preview harness.
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

    INFO_PLIST="$APP/Contents/Info.plist"
    if [ ! -f "$INFO_PLIST" ]; then
        fail "no Info.plist at $INFO_PLIST"
    else
        APP_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST" 2>/dev/null)
        APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST" 2>/dev/null)
        APP_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST" 2>/dev/null)
        APP_GIT_SHA=$(/usr/libexec/PlistBuddy -c "Print :JunoGitSHA" "$INFO_PLIST" 2>/dev/null)
        APP_CONTRACT=$(/usr/libexec/PlistBuddy -c "Print :JunoContractVersion" "$INFO_PLIST" 2>/dev/null)
        APP_CHANNEL=$(/usr/libexec/PlistBuddy -c "Print :JunoChannel" "$INFO_PLIST" 2>/dev/null)
        EXPECTED_VERSION=$(sed -n 's/^MARKETING_VERSION = //p' native/Config/Base.xcconfig | head -1)
        EXPECTED_BUILD=$(sed -n 's/^CURRENT_PROJECT_VERSION = //p' native/Config/Base.xcconfig | head -1)
        EXPECTED_GIT_SHA=$(git rev-parse --short=10 HEAD 2>/dev/null)

        if [ "$APP_BUNDLE_ID" = "com.liammagnier.JunoDesktop" ]; then
            pass "Stable bundle identifier is $APP_BUNDLE_ID"
        else
            fail "unexpected Stable bundle identifier '$APP_BUNDLE_ID'"
        fi
        if [ "$APP_VERSION" = "$EXPECTED_VERSION" ] && [ "$APP_BUILD" = "$EXPECTED_BUILD" ]; then
            pass "bundle version is $APP_VERSION ($APP_BUILD)"
        else
            fail "bundle version $APP_VERSION ($APP_BUILD) does not match $EXPECTED_VERSION ($EXPECTED_BUILD)"
        fi
        if [ "$APP_GIT_SHA" = "$EXPECTED_GIT_SHA" ]; then
            pass "bundle commit is $APP_GIT_SHA"
        else
            fail "bundle commit '$APP_GIT_SHA' does not match HEAD $EXPECTED_GIT_SHA"
            info "Run ./native/Scripts/write-build-metadata.sh after the release commit."
        fi
        if [ "$APP_CONTRACT" = "$BACKEND_VERSION" ]; then
            pass "bundle contract is $APP_CONTRACT"
        else
            fail "bundle contract '$APP_CONTRACT' does not match source $BACKEND_VERSION"
        fi
        if [ "$APP_CHANNEL" = "stable" ]; then
            pass "bundle channel is stable"
        else
            fail "bundle channel is '$APP_CHANNEL', expected stable"
        fi
    fi
    echo
fi

# ---------------------------------------------------------------------------
# 5. No Work route hands a remote client a host-only shape.
#
# src/lib/work/serializers.ts draws the line between what the Mac that owns a
# folder may see and what everybody else may see. `serializeGrantForHost` adds
# the absolute path a grant resolved to; `serializeCommandForHost` passes a
# command payload through unfiltered, including the path the user picked in a
# file dialog. Both are right for the host executing the instruction and are a
# disclosure to anything else — including the phone that asked for the work.
#
# Grepped rather than typechecked because only half of it is expressible.
# `ClientWorkGrant` types the two path fields as `never`, so the grant half
# fails to compile; the host and remote *command* shapes differ only in which
# JSON keys survive, so they are mutually assignable and the compiler is silent.
#
# Mirrored in .github/workflows/deploy.yml — change one, change both.
# ---------------------------------------------------------------------------
echo "Work disclosure boundary"
WORK_ROUTES="src/app/api/work"
if [ ! -d "$WORK_ROUTES" ]; then
    fail "$WORK_ROUTES does not exist, so this gate is checking nothing"
elif HOST_SERIALISER_HITS=$(grep -rn 'serializeGrantForHost\|serializeCommandForHost' "$WORK_ROUTES"); then
    fail "a Work route references a host-only serialiser"
    printf '%s\n' "$HOST_SERIALISER_HITS" | sed 's/^/        /'
    info "Those shapes carry the grant's absolute path and the unfiltered command payload."
    info "Use serializeGrantForRemote / serializeCommandForRemote instead."
else
    pass "no route under $WORK_ROUTES uses a host-only serialiser"
fi
echo

# ---------------------------------------------------------------------------
# 6. The Work tables have a migration, and no migration can deadlock a deploy.
#
# Prisma identifies an applied migration by its directory name and records that
# name in _prisma_migrations, so the name is permanent — renaming it leaves
# every deployed database pointing at a directory that no longer exists. The
# exact path is therefore the right thing to assert, not a glob.
# ---------------------------------------------------------------------------
echo "Work migration integrity"
WORK_MIGRATION="prisma/migrations/20260805120000_work_domain/migration.sql"
if [ -f "$WORK_MIGRATION" ]; then
    pass "$WORK_MIGRATION is present"
else
    fail "$WORK_MIGRATION is missing"
    info "Every Work route fails on its first query against a freshly migrated database."
    info "The directory name is an identifier Prisma stores; it can never be renamed."
fi

# CREATE INDEX CONCURRENTLY cannot run inside the transaction Prisma wraps each
# migration file in, and the usual workaround — a bare COMMIT partway through —
# leaves a half-applied migration and a failed _prisma_migrations row that
# P3009-blocks every later deploy.
#
# Comments are stripped and newlines flattened first. A bare search for the word
# has two false positives that would each get this gate learned-ignored:
# 20260717220000_chat_first_submission_receipt explains in prose why its indexes
# do *not* need CONCURRENTLY, and a statement split across two lines is equally
# valid SQL that a line-oriented grep would miss.
CONCURRENT_MIGRATIONS=""
while IFS= read -r file; do
    if sed 's/--.*$//' "$file" | tr '\n' ' ' \
        | grep -qiE 'create[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently'; then
        CONCURRENT_MIGRATIONS="${CONCURRENT_MIGRATIONS}${file}"$'\n'
    fi
done < <(find prisma/migrations -type f -name '*.sql' | sort)
if [ -n "$CONCURRENT_MIGRATIONS" ]; then
    fail "a migration uses CREATE INDEX CONCURRENTLY"
    printf '%s' "$CONCURRENT_MIGRATIONS" | sed 's/^/        /'
    info "Build the index without it, or create the table in the same migration."
else
    pass "no migration uses CREATE INDEX CONCURRENTLY"
fi
echo

# ---------------------------------------------------------------------------
# 7. The Work gates that live in CI are still in CI.
#
# The gates below run in .github/workflows/*.yml, not here. This section does
# not repeat them — it asserts they are still wired, which is the failure this
# script can actually catch. A gate deleted in a refactor is green in CI by
# construction, and the first evidence otherwise is a stale Swift enum in a
# shipped app or a Swift package nothing has compiled for two months.
# ---------------------------------------------------------------------------
echo "Work CI coverage"
if grep -q "work:contract:check" .github/workflows/deploy.yml 2>/dev/null; then
    pass "deploy.yml gates on the Work contract drift check"
else
    fail "deploy.yml no longer runs work:contract:check"
    info "native.yml is path filtered, so a commit touching only contracts/work/juno-work-v1.json"
    info "or src/lib/work/domain.ts would never be checked anywhere else."
fi
if grep -q "runner/agent-core" .github/workflows/deploy.yml 2>/dev/null; then
    pass "deploy.yml builds and tests runner/agent-core, which holds the Work runtime"
else
    fail "deploy.yml no longer builds runner/agent-core"
    info "runner/agent-core is outside the root tsconfig; nothing else in CI compiles it."
fi
# Every Swift package must be in native.yml's matrix, because that matrix is the
# whole gate — a package outside it is never compiled or tested by CI at all.
NATIVE_PACKAGE_MATRIX=$(grep -m1 'package: \[' .github/workflows/native.yml 2>/dev/null)
if [ -z "$NATIVE_PACKAGE_MATRIX" ]; then
    fail "could not find the package matrix in .github/workflows/native.yml"
else
    for package_dir in native/Packages/*/; do
        package_name=$(basename "$package_dir")
        case "$NATIVE_PACKAGE_MATRIX" in
            *"$package_name"*) pass "native.yml builds and tests $package_name" ;;
            *)
                fail "$package_name is not in the native.yml package matrix"
                info "A package outside that matrix is never compiled or tested by CI."
                ;;
        esac
    done
fi
echo

# ---------------------------------------------------------------------------
# 8. Same-commit requirement: the tree must be clean and pushed.
# ---------------------------------------------------------------------------
echo "Source state"
if [ -n "$(git status --porcelain)" ]; then
    fail "worktree is dirty — the built artifacts would not match any commit"
else
    pass "worktree clean"
fi
# Tracked in its own flag rather than read off the global FAILED. This line used
# to be `[ $FAILED -eq 0 ] && pass ...`, which reports on every gate in the file
# rather than on this one: any earlier failure silenced it, so the output said
# nothing at all about whether an integration was in progress at exactly the
# moment somebody was scanning a failing run for what to fix. Adding sections
# above made that far more likely to bite.
INTEGRATION_IN_PROGRESS=0
for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD; do
    if [ -e "$(git rev-parse --git-dir)/$marker" ]; then
        fail "$marker present — an integration is in progress"
        INTEGRATION_IN_PROGRESS=1
    fi
done
[ $INTEGRATION_IN_PROGRESS -eq 0 ] && pass "no merge, rebase or cherry-pick in progress"
echo

if [ $FAILED -eq 0 ]; then
    printf '\033[32mAll release gates passed.\033[0m\n'
else
    printf '\033[31mRelease gates FAILED — do not ship.\033[0m\n'
fi
exit $FAILED
