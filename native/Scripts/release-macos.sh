#!/bin/bash
#
# Ship Juno for Mac.
#
# Build → sign → notarize → staple → DMG → verify → publish. One command, and it
# refuses at every gate rather than producing something that only looks like a
# release.
#
# WHY THE GATES MATTER. The app updates itself, and `DesktopUpdater.swift` holds
# an update to the same standard as the app it is replacing: Apple-anchored, this
# bundle identifier, this Team ID — plus Developer ID and notarization when the
# installed app has them. A DMG that fails those checks would be downloaded,
# refused and reported as a failure on repeat, every ten minutes. So this script
# runs the same checks the updater runs, before spending twenty minutes on a
# build, and adapts them to the certificate that is actually available.
#
#   Usage:  native/Scripts/release-macos.sh 0.2.0 [--publish]
#
# Without --publish it produces and verifies the artifact and stops, which is the
# right default: publishing is the one step that cannot be taken back.
set -euo pipefail

VERSION="${1:-}"
PUBLISH="${2:-}"
REPO="LiamMagnier/juno"
SCHEME="JunoDesktop"
PROJECT="native/macOS/JunoDesktop/JunoDesktop.xcodeproj"
NOTARY_PROFILE="${JUNO_NOTARY_PROFILE:-juno-notary}"
BUILD_DIR="${JUNO_RELEASE_DIR:-/private/tmp/juno-release}"
EXPECTED_BUNDLE_ID="com.liammagnier.JunoDesktop"

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }
require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' is not available on PATH."
}

[ "$#" -le 2 ] || die "Usage: native/Scripts/release-macos.sh <version> [--publish]"
[ -n "$VERSION" ] || die "Usage: native/Scripts/release-macos.sh <version> [--publish]"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die \
  "Version must be MAJOR.MINOR.PATCH without leading zeroes, got '$VERSION'."
case "$PUBLISH" in
  ""|--publish) ;;
  *) die "The second argument must be --publish when publishing, got '$PUBLISH'." ;;
esac

# Always resolve paths from the checkout containing this script. The workflow
# invokes this file from the repository root, but making that assumption
# implicit makes provenance checks surprisingly easy to bypass locally.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The script removes only named children below this directory. Refuse a caller
# supplied root/home/workspace path before any cleanup can happen.
case "$BUILD_DIR" in
  /private/tmp/*|/tmp/*) ;;
  *) die "JUNO_RELEASE_DIR must be a directory beneath /private/tmp or /tmp; got '$BUILD_DIR'." ;;
esac
if [ -L "$BUILD_DIR" ]; then
  die "JUNO_RELEASE_DIR must not be a symlink: '$BUILD_DIR'."
fi
mkdir -p "$BUILD_DIR"

# ── Preflight ──────────────────────────────────────────────────────────────
# Every one of these is something that fails late and expensively otherwise: a
# missing certificate after a 20-minute archive, a team mismatch after
# notarization, a dirty tree that makes the published commit a fiction.

step "Preflight"

require_command xcodebuild
require_command swift
require_command security
require_command xcrun
require_command codesign
require_command defaults
require_command hdiutil
require_command ditto
require_command shasum
require_command stat
require_command xmllint
require_command spctl
require_command jq
require_command curl

if [ "$PUBLISH" = "--publish" ]; then
  require_command gh
  require_command jq
  gh auth status --hostname github.com >/dev/null 2>&1 || die \
    "The GitHub CLI is not authenticated for github.com. Authenticate before publishing."
fi

[ -f native/Config/Base.xcconfig ] || die "Run from a Juno checkout containing native/Config/Base.xcconfig."
CONFIGURED_TEAM="$(sed -n 's/^DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')"
[ -n "$CONFIGURED_TEAM" ] || die "native/Config/Base.xcconfig sets no DEVELOPMENT_TEAM."
[[ "$CONFIGURED_TEAM" =~ ^[A-Z0-9]{10}$ ]] || die \
  "native/Config/Base.xcconfig has an invalid DEVELOPMENT_TEAM '$CONFIGURED_TEAM'."

MARKETING="$(sed -n 's/^MARKETING_VERSION[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')"
[ "$MARKETING" = "$VERSION" ] || die \
  "native/Config/Base.xcconfig says MARKETING_VERSION = $MARKETING, not $VERSION.
     Bump it (and CURRENT_PROJECT_VERSION) and commit before releasing — the
     updater compares the version the bundle reports, not the tag."

BUILD_NUMBER="$(sed -n 's/^CURRENT_PROJECT_VERSION[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')"
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || die \
  "native/Config/Base.xcconfig has invalid CURRENT_PROJECT_VERSION '$BUILD_NUMBER'."

SOURCE_CONTRACT="$(sed -n 's/^export const CONTRACT_VERSION = "\(.*\)";$/\1/p' src/lib/api-v1.ts | head -1)"
[ -n "$SOURCE_CONTRACT" ] || die "Could not read CONTRACT_VERSION from src/lib/api-v1.ts."

SOURCE_SHA="$(git rev-parse HEAD 2>/dev/null)" || die "The checkout has no resolvable HEAD commit."
SOURCE_SHORT_SHA="$(git rev-parse --short=10 HEAD 2>/dev/null)" || die "Could not resolve the short source commit."
[ -z "$(git status --porcelain --untracked-files=all)" ] || die \
  "The working tree is dirty. A release must name an exact committed source tree."

ORIGIN_URL="$(git config --get remote.origin.url || true)"
case "$ORIGIN_URL" in
  https://github.com/LiamMagnier/juno|https://github.com/LiamMagnier/juno.git|\
  git@github.com:LiamMagnier/juno.git|ssh://git@github.com/LiamMagnier/juno.git) ;;
  *) die "origin must be the canonical GitHub repository LiamMagnier/juno; got '$ORIGIN_URL'." ;;
esac

if [ "$PUBLISH" = "--publish" ]; then
  MAIN_SHA="$(git rev-parse refs/remotes/origin/main 2>/dev/null)" || die \
    "Could not resolve origin/main; refusing to publish without a fetched main ref."
  [ "$SOURCE_SHA" = "$MAIN_SHA" ] || die \
    "HEAD $SOURCE_SHA is not origin/main $MAIN_SHA. Check out the exact approved main commit."

  REMOTE_TAGS="$(git ls-remote origin "refs/tags/v$VERSION" 2>/dev/null)" || die \
    "Could not query origin for v$VERSION; refusing to prove tag uniqueness."
  [ -z "$REMOTE_TAGS" ] || die "Remote tag v$VERSION already exists. Releases are immutable."
  git show-ref --verify --quiet "refs/tags/v$VERSION" && die \
    "Local tag v$VERSION already exists. Releases are immutable."

  # A 404 is the only safe answer. Treat authentication, rate limiting and
  # network errors as blockers instead of interpreting every failed request as
  # proof that the version is available.
  RELEASE_LOOKUP=""
  if RELEASE_LOOKUP="$(gh api --include "repos/$REPO/releases/tags/v$VERSION" 2>&1)"; then
    die "GitHub release v$VERSION already exists. Releases are immutable."
  else
    HTTP_STATUS="$(printf '%s\n' "$RELEASE_LOOKUP" | awk '$1 ~ /^HTTP/ { code=$2 } END { print code }')"
    [ "$HTTP_STATUS" = "404" ] || {
      printf '%s\n' "$RELEASE_LOOKUP" >&2
      die "Could not prove that GitHub release v$VERSION is absent (HTTP $HTTP_STATUS)."
    }
  fi
fi

# A Developer ID Application certificate is mandatory for publication. A local
# dry run may still use Apple Development so developers can verify the archive,
# but there is no command-line escape hatch that can turn that artifact into a
# public release.
IDENTITY="$(security find-identity -v -p codesigning \
  | awk -F'"' '/Developer ID Application/{print $2; exit}')" || true
NOTARIZE=1
IDENTITY_CLASS="Developer ID Application"
if [ -z "$IDENTITY" ]; then
  if [ "$PUBLISH" = "--publish" ]; then
    AVAILABLE_IDENTITIES="$(security find-identity -v -p codesigning 2>&1 || true)"
    printf '%s\n' "$AVAILABLE_IDENTITIES" >&2
    die "Production publication requires a valid 'Developer ID Application' certificate for team $CONFIGURED_TEAM. No such identity is installed; an Apple Development certificate cannot publish a production release."
  fi
  # No Developer ID. Fall back to a development certificate so a build can still
  # be produced and installed by hand — but say plainly what that costs, because
  # the two artifacts are not interchangeable and it is the difference between a
  # release and a build.
  NOTARIZE=0
  IDENTITY_CLASS="Apple Development"
  IDENTITY="$(security find-identity -v -p codesigning \
    | awk -F'"' '/Apple Development/{print $2; exit}')" || true
  [ -n "$IDENTITY" ] || {
    security find-identity -v -p codesigning >&2
    die "No code-signing identity at all. Nothing can be built."
  }
  cat >&2 <<WARNING

  ⚠  DEVELOPMENT BUILD, NOT A DISTRIBUTABLE RELEASE

     No 'Developer ID Application' certificate is installed. This dry-run
     artifact is for local verification only; it cannot be published.

WARNING
fi
printf '  identity      %s\n' "$IDENTITY"
printf '  team          %s\n' "$CONFIGURED_TEAM"
printf '  notarize      %s\n' "$([ "$NOTARIZE" = 1 ] && echo yes || echo 'no (local dry run)')"

# A development artifact may be produced by a local dry run for verification,
# but publication has no development-build override.
if [ "$NOTARIZE" = 1 ]; then
  IDENTITY_TEAM="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9][A-Z0-9]*\)).*/\1/p')"
  [ "$IDENTITY_TEAM" = "$CONFIGURED_TEAM" ] || die \
    "Developer ID identity '$IDENTITY' belongs to team '$IDENTITY_TEAM', but the project is configured for '$CONFIGURED_TEAM'."
  require_command jq
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || die \
    "Developer ID signing is available, but notarization credentials are missing or invalid for profile '$NOTARY_PROFILE'. Configure an App Store Connect API-key profile in the protected release environment before publishing."
fi

printf '  source       %s\n' "$SOURCE_SHA"
printf '  version      %s (build %s)\n' "$VERSION" "$BUILD_NUMBER"
printf '  bundle       %s\n' "$EXPECTED_BUNDLE_ID"
printf '  contract     %s\n' "$SOURCE_CONTRACT"

step "Tests"
swift test --package-path native/Packages/JunoNativeKit --scratch-path "$BUILD_DIR/pkg" >/dev/null
if [ -f runner/agent-core/package-lock.json ]; then
  npm ci --prefix runner/agent-core >/dev/null
  npm run build --prefix runner/agent-core >/dev/null
  npm test --prefix runner/agent-core >/dev/null
fi
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
  -destination 'platform=macOS' -derivedDataPath "$BUILD_DIR/test" \
  CODE_SIGNING_ALLOWED=NO -only-testing:JunoDesktopTests test >/dev/null

# ── Build ──────────────────────────────────────────────────────────────────

step "Archive (Stable, hardened runtime)"
rm -rf "$BUILD_DIR/archive.xcarchive" "$BUILD_DIR/export"
native/Scripts/write-build-metadata.sh >/dev/null || die "Could not write build provenance metadata."
GENERATED_METADATA="native/Config/Generated-Build.xcconfig"
[ -f "$GENERATED_METADATA" ] || die "Build provenance file was not generated: $GENERATED_METADATA."
GENERATED_SHA="$(sed -n 's/^JUNO_GIT_SHA = //p' "$GENERATED_METADATA" | head -1)"
[ "$GENERATED_SHA" = "$SOURCE_SHORT_SHA" ] || die "Generated build metadata says '$GENERATED_SHA', not source commit '$SOURCE_SHORT_SHA'."
[ -z "$(git status --porcelain --untracked-files=all)" ] || die "The source tree changed while preparing the archive. Refusing to publish mixed provenance."
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Stable \
  -destination 'generic/platform=macOS' \
  -archivePath "$BUILD_DIR/archive.xcarchive" \
  ENABLE_HARDENED_RUNTIME=YES \
  DEVELOPMENT_TEAM="$CONFIGURED_TEAM" \
  CODE_SIGN_IDENTITY="$IDENTITY_CLASS" \
  archive

cat > "$BUILD_DIR/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>$([ "$NOTARIZE" = 1 ] && echo developer-id || echo development)</string>
  <key>teamID</key><string>$CONFIGURED_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

step "Export"
xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/archive.xcarchive" \
  -exportPath "$BUILD_DIR/export" \
  -exportOptionsPlist "$BUILD_DIR/export.plist"

APP="$(find "$BUILD_DIR/export" -maxdepth 1 -type d -name '*.app' -print -quit)"
[ -n "$APP" ] || die "The export produced no application bundle."

# ── Verify what was signed, before spending a notarization on it ───────────

step "Verify the signature"
codesign --verify --deep --strict --verbose=2 "$APP"
# Captured, not piped into `grep -q`. Under `pipefail` a `-q` grep exits the
# moment it matches, `codesign` takes SIGPIPE, and the pipeline reports failure
# for the case that SUCCEEDED — which is how this first refused a correctly
# signed bundle.
SIGNING_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
case "$SIGNING_INFO" in
  *"TeamIdentifier=$CONFIGURED_TEAM"*) ;;
  *) die "The signed bundle does not carry team $CONFIGURED_TEAM.
$SIGNING_INFO" ;;
esac
if [ "$NOTARIZE" = 1 ]; then
  case "$SIGNING_INFO" in
    *"Authority=Developer ID Application:"*) ;;
    *) die "The production bundle is not signed by a Developer ID Application certificate.
$SIGNING_INFO" ;;
  esac
fi
codesign -d --entitlements - --xml "$APP" >/dev/null

# The exact requirement `DesktopUpdater.swift` enforces on the downloaded
# bundle. Checking it here means a release can never ship that the app would
# then refuse to install.
BUNDLE_ID="$(defaults read "$APP/Contents/Info" CFBundleIdentifier)"
[ "$BUNDLE_ID" = "$EXPECTED_BUNDLE_ID" ] || die \
  "The built app reports bundle identifier '$BUNDLE_ID', not '$EXPECTED_BUNDLE_ID'."
REQUIREMENT="anchor apple generic and identifier \"$EXPECTED_BUNDLE_ID\" and certificate leaf[subject.OU] = \"$CONFIGURED_TEAM\""
if [ "$NOTARIZE" = 1 ]; then
  REQUIREMENT="$REQUIREMENT and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
fi
# `-R=` with the equals sign: bare `-R` reads its argument as a FILENAME, so an
# inline requirement becomes "No such file or directory" and then "invalid
# requirement specification" — which reads as the bundle failing when it is the
# check that is malformed.
codesign --verify --strict -R="$REQUIREMENT" "$APP" \
  || die "The bundle does not satisfy the requirement the auto-updater enforces:
     $REQUIREMENT"

BUNDLE_VERSION="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
[ "$BUNDLE_VERSION" = "$VERSION" ] || die "The built app reports $BUNDLE_VERSION, not $VERSION."
BUNDLE_BUILD="$(defaults read "$APP/Contents/Info" CFBundleVersion)"
[ "$BUNDLE_BUILD" = "$BUILD_NUMBER" ] || die "The built app reports build $BUNDLE_BUILD, not $BUILD_NUMBER."
BUNDLE_GIT_SHA="$(defaults read "$APP/Contents/Info" JunoGitSHA)"
[ "$BUNDLE_GIT_SHA" = "$SOURCE_SHORT_SHA" ] || die \
  "The built app reports source '$BUNDLE_GIT_SHA', not '$SOURCE_SHORT_SHA'."
BUNDLE_CONTRACT="$(defaults read "$APP/Contents/Info" JunoContractVersion)"
[ "$BUNDLE_CONTRACT" = "$SOURCE_CONTRACT" ] || die \
  "The built app reports contract '$BUNDLE_CONTRACT', not '$SOURCE_CONTRACT'."
CHANNEL="$(defaults read "$APP/Contents/Info" JunoChannel)"
[ "$CHANNEL" = "stable" ] || die "The built app reports channel '$CHANNEL'. The updater only updates 'stable'."

[ "$(git rev-parse HEAD)" = "$SOURCE_SHA" ] || die "HEAD changed during the build; refusing mixed artifact provenance."
[ -z "$(git status --porcelain --untracked-files=all)" ] || die "The source tree changed during the build; refusing mixed artifact provenance."
step "Release gates for exported app"
bash scripts/release-gates.sh "$APP"

# ── Package ────────────────────────────────────────────────────────────────

step "Disk image"
DMG="$BUILD_DIR/Juno-$VERSION.dmg"
rm -f "$DMG"
STAGE="$BUILD_DIR/dmg"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Juno $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
codesign --sign "$IDENTITY" --timestamp "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
DMG_SIGNING_INFO="$(codesign -dv --verbose=4 "$DMG" 2>&1)"
case "$DMG_SIGNING_INFO" in
  *"TeamIdentifier=$CONFIGURED_TEAM"*) ;;
  *) die "The disk image does not carry team $CONFIGURED_TEAM.
$DMG_SIGNING_INFO" ;;
esac
if [ "$NOTARIZE" = 1 ]; then
  case "$DMG_SIGNING_INFO" in
    *"Authority=Developer ID Application:"*) ;;
    *) die "The disk image is not signed by a Developer ID Application certificate.
$DMG_SIGNING_INFO" ;;
  esac
fi

if [ "$NOTARIZE" = 1 ]; then
  step "Notarize (this takes a few minutes)"
  NOTARY_RESULT="$BUILD_DIR/notary-result.json"
  if ! xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" \
    --wait --output-format json > "$NOTARY_RESULT"; then
    cat "$NOTARY_RESULT" >&2 || true
    die "Apple notarization failed. The DMG was not published."
  fi
  NOTARY_STATUS="$(jq -r '.status // empty' "$NOTARY_RESULT" 2>/dev/null || true)"
  [ "$NOTARY_STATUS" = "Accepted" ] || {
    cat "$NOTARY_RESULT" >&2
    die "Apple notarization returned status '$NOTARY_STATUS' instead of Accepted. The DMG was not published."
  }
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

step "Release symbols and checksums"
DSYM_SOURCE="$BUILD_DIR/archive.xcarchive/dSYMs/Juno.app.dSYM"
[ -d "$DSYM_SOURCE" ] || die "The archive contains no Juno.app.dSYM. Refusing to publish without symbols."
DSYM="$BUILD_DIR/Juno-$VERSION.dSYM.zip"
rm -f "$DSYM"
ditto -c -k --sequesterRsrc --keepParent "$DSYM_SOURCE" "$DSYM"
CHECKSUMS="$BUILD_DIR/SHA256SUMS.txt"
DSYM_SHA="$(shasum -a 256 "$DSYM" | awk '{print $1}')"
DSYM_SIZE="$(stat -f%z "$DSYM")"
(
  cd "$BUILD_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$DSYM")" > "$(basename "$CHECKSUMS")"
)
(
  cd "$BUILD_DIR"
  shasum -a 256 -c "$(basename "$CHECKSUMS")"
)
CHECKSUMS_SHA="$(shasum -a 256 "$CHECKSUMS" | awk '{print $1}')"
CHECKSUMS_SIZE="$(stat -f%z "$CHECKSUMS")"

step "Gatekeeper"
# The app inside the image has to pass on a machine that has never seen it,
# which is what `spctl --assess` answers.
#
# Attached ONCE. This was `hdiutil attach … | plutil … || hdiutil attach …`,
# and the fallback is not a fallback: `plutil` fails whenever the first
# system-entity is the partition scheme rather than the mounted volume, which
# is most of the time — so the `||` ran a SECOND attach against an image that
# was already attached and the step died on "Resource busy", leaving two
# images mounted behind it.
MOUNT=""
cleanup_mount() {
  if [ -n "$MOUNT" ] && [ -d "$MOUNT" ]; then
    hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
  fi
}
trap cleanup_mount EXIT
ATTACH_PLIST="$(hdiutil attach "$DMG" -nobrowse -readonly -mountrandom /tmp -plist)"
MOUNT="$(printf '%s' "$ATTACH_PLIST" \
  | xmllint --xpath 'string(//key[text()="mount-point"]/following-sibling::string[1])' - 2>/dev/null)"
if [ -z "$MOUNT" ]; then
  MOUNT="$(printf '%s' "$ATTACH_PLIST" | grep -o '/tmp/dmg\.[A-Za-z0-9]*' | sed -n '1p')"
fi
[ -n "$MOUNT" ] && [ -d "$MOUNT" ] || die "The disk image mounted but its mount point could not be read."

if spctl --assess --type execute --verbose=4 "$MOUNT/$(basename "$APP")" 2>&1; then
  :
elif [ "$NOTARIZE" = 1 ]; then
  die "Gatekeeper rejected the notarized app."
else
  printf '  (rejected, as expected for a development build)\n'
fi
hdiutil detach "$MOUNT" -force >/dev/null
MOUNT=""
trap - EXIT

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE="$(stat -f%z "$DMG")"

MANIFEST="$BUILD_DIR/Juno-$VERSION.release.json"
cat > "$MANIFEST" <<MANIFEST_JSON
{
  "schema_version": 1,
  "product": "Juno",
  "platform": "macos",
  "channel": "stable",
  "version": "$VERSION",
  "build": "$BUILD_NUMBER",
  "bundle_identifier": "$EXPECTED_BUNDLE_ID",
  "team_id": "$CONFIGURED_TEAM",
  "contract_version": "$SOURCE_CONTRACT",
  "source_commit": "$SOURCE_SHA",
  "source_commit_short": "$SOURCE_SHORT_SHA",
  "artifacts": {
    "dmg": {
      "name": "$(basename "$DMG")",
      "bytes": $SIZE,
      "sha256": "$SHA"
    },
    "dsym": {
      "name": "$(basename "$DSYM")",
      "bytes": $DSYM_SIZE,
      "sha256": "$DSYM_SHA"
    },
    "checksums": {
      "name": "$(basename "$CHECKSUMS")",
      "bytes": $CHECKSUMS_SIZE,
      "sha256": "$CHECKSUMS_SHA"
    }
  }
}
MANIFEST_JSON
jq -e . "$MANIFEST" >/dev/null || die "The release provenance manifest is not valid JSON."
MANIFEST_SHA="$(shasum -a 256 "$MANIFEST" | awk '{print $1}')"
MANIFEST_SIZE="$(stat -f%z "$MANIFEST")"

printf '\n  artifact   %s\n  sha256     %s\n  bytes      %s\n  source     %s\n' "$DMG" "$SHA" "$SIZE" "$SOURCE_SHA"

if [ "$PUBLISH" != "--publish" ]; then
  printf '\n  Verified and NOT published. A development artifact is local-only until Developer ID signing and notarization are available.\n\n'
  exit 0
fi

# ── Publish ────────────────────────────────────────────────────────────────
# Everything above this line is reversible. Nothing below it is.

step "Publish v$VERSION to $REPO"
[ -z "$(git tag --list "v$VERSION")" ] || die "Tag v$VERSION already exists. Choose a new version; releases are immutable."
[ "$NOTARIZE" = 1 ] || die "A published release must be Developer ID signed and notarized."
TITLE="Juno for Mac $VERSION"
gh release create "v$VERSION" "$DMG" \
  "$DSYM" \
  "$CHECKSUMS" \
  "$MANIFEST" \
  --repo "$REPO" \
  --target "$SOURCE_SHA" \
  --draft \
  --title "$TITLE" \
  --notes "$(cat <<NOTES
Source commit \`$(git rev-parse HEAD)\`
DMG SHA-256 \`$SHA\` · $SIZE bytes
Symbols and \`SHA256SUMS.txt\` are attached for crash diagnosis and independent verification.

Installs by drag-and-drop. Existing installs update themselves within ten minutes, or immediately from Juno → Install Update and Relaunch.
NOTES
)"

RELEASE_ID="$(gh api "repos/$REPO/releases/tags/v$VERSION" --jq '.id // empty')"
[ -n "$RELEASE_ID" ] || die "GitHub created the draft release but returned no release ID; it remains draft-only."
if ! gh api --method PATCH "repos/$REPO/releases/$RELEASE_ID" \
  -F draft=false -F prerelease=false >/dev/null; then
  die "Could not publish the verified draft release; it remains draft-only."
fi
RELEASE_STATE="$(gh api "repos/$REPO/releases/tags/v$VERSION")"
[ "$(printf '%s' "$RELEASE_STATE" | jq -r '.draft')" = "false" ] || die \
  "GitHub did not publish the release as a stable release."
[ "$(printf '%s' "$RELEASE_STATE" | jq -r '.prerelease')" = "false" ] || die \
  "GitHub marked the release as a prerelease; refusing to claim stable publication."

# A GitHub release can be public before the backend's server-side release-feed
# cache has observed it. Do not call a release complete until the exact version,
# download URL and checksum are visible through the endpoint the installed Mac
# actually uses. This is the final end-to-end guarantee against publishing a
# release that the app cannot discover.
step "Verify the live updater feed"
FEED_URL="https://chat.liams.dev/api/downloads?refresh=release-${VERSION}-${SOURCE_SHORT_SHA}"
for attempt in $(seq 1 18); do
  FEED="$(curl --fail --silent --show-error --max-time 20 "$FEED_URL" 2>/dev/null || true)"
  if [ -n "$FEED" ] && printf '%s' "$FEED" | jq -e \
    --arg version "$VERSION" \
    --arg sha "$SHA" \
    '.downloads[]
      | select(
          .platform == "macos"
          and .available == true
          and .version == $version
          and .url == ("https://github.com/LiamMagnier/juno/releases/download/v" + $version + "/Juno-" + $version + ".dmg")
          and .sha256 == $sha
        )' >/dev/null; then
    printf '\n  Published and discoverable. The live updater feed serves Juno %s.\n\n' "$VERSION"
    exit 0
  fi
  printf '  Waiting for /api/downloads to expose %s (attempt %s/18)\n' "$VERSION" "$attempt"
  sleep 5
done

die "GitHub published v$VERSION, but https://chat.liams.dev/api/downloads did not expose the exact Mac artifact and checksum. The release is public; repair the feed before telling users to update."
