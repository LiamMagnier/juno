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
# Publishing a development-signed build is refused by default (see the gate
# below). This is the deliberate, typed-out override — long on purpose, because
# it is not something to reach for by habit.
ALLOW_DEVELOPMENT="${3:-}"
REPO="LiamMagnier/juno"
SCHEME="JunoDesktop"
PROJECT="native/macOS/JunoDesktop/JunoDesktop.xcodeproj"
NOTARY_PROFILE="${JUNO_NOTARY_PROFILE:-juno-notary}"
BUILD_DIR="${JUNO_RELEASE_DIR:-/private/tmp/juno-release}"

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }

[ -n "$VERSION" ] || die "Usage: native/Scripts/release-macos.sh <version> [--publish]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must be MAJOR.MINOR.PATCH, got '$VERSION'."
case "$PUBLISH" in
  ""|--publish) ;;
  *) die "The second argument must be --publish when publishing, got '$PUBLISH'." ;;
esac
case "$ALLOW_DEVELOPMENT" in
  ""|--allow-development-build) ;;
  *) die "The third argument may only be --allow-development-build, got '$ALLOW_DEVELOPMENT'." ;;
esac

# ── Preflight ──────────────────────────────────────────────────────────────
# Every one of these is something that fails late and expensively otherwise: a
# missing certificate after a 20-minute archive, a team mismatch after
# notarization, a dirty tree that makes the published commit a fiction.

step "Preflight"

command -v xcodebuild >/dev/null || die "xcodebuild is not on PATH."
command -v gh >/dev/null || die "The GitHub CLI is required to publish."

if [ "$PUBLISH" = "--publish" ]; then
  gh auth status --hostname github.com >/dev/null 2>&1 || die \
    "The GitHub CLI is not authenticated for github.com. Authenticate before publishing."
fi

CONFIGURED_TEAM="$(awk -F'= *' '/^DEVELOPMENT_TEAM/{print $2}' native/Config/Base.xcconfig | tr -d ' ')"
[ -n "$CONFIGURED_TEAM" ] || die "native/Config/Base.xcconfig sets no DEVELOPMENT_TEAM."

# A Developer ID Application certificate if there is one — that is the
# distinction that decides whether Gatekeeper will run the app on anyone else's
# Mac. Without it a development build can still be produced, and the warning
# below is deliberately loud about what that is and is not.
IDENTITY="$(security find-identity -v -p codesigning \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/')" || true
NOTARIZE=1
IDENTITY_CLASS="Developer ID Application"
if [ -z "$IDENTITY" ]; then
  # No Developer ID. Fall back to a development certificate so a build can still
  # be produced and installed by hand — but say plainly what that costs, because
  # the two artifacts are not interchangeable and it is the difference between a
  # release and a build.
  NOTARIZE=0
  IDENTITY_CLASS="Apple Development"
  IDENTITY="$(security find-identity -v -p codesigning \
    | grep "Apple Development" | head -1 | sed -E 's/.*"(.*)"/\1/')" || true
  [ -n "$IDENTITY" ] || {
    security find-identity -v -p codesigning >&2
    die "No code-signing identity at all. Nothing can be built."
  }
  cat >&2 <<WARNING

  ⚠  DEVELOPMENT BUILD, NOT A DISTRIBUTABLE RELEASE

     No 'Developer ID Application' certificate is installed, so this artifact:
       · cannot be notarized;
       · will be REFUSED by Gatekeeper on any Mac that downloads it;
       · will only auto-update installs that are themselves development-signed
         by the same team.

     To produce a real release, create a Developer ID Application certificate in
     the Apple Developer portal, install it, and store notarization credentials:
       xcrun notarytool store-credentials $NOTARY_PROFILE \\
         --apple-id <your Apple ID> --team-id $CONFIGURED_TEAM \\
         --password <an app-specific password>

WARNING
fi
printf '  identity      %s\n' "$IDENTITY"
printf '  team          %s\n' "$CONFIGURED_TEAM"
printf '  notarize      %s\n' "$([ "$NOTARIZE" = 1 ] && echo yes || echo 'no (development build)')"

# A development artifact is useful for local installation and verification, but
# it is not a distributable release. Publishing it puts a file on /api/downloads
# that Gatekeeper refuses on every Mac except one signed by the same team, so
# the irreversible path fails closed by default.
#
# It is not, however, forbidden: v0.10.0 and v0.10.1 shipped exactly this way,
# to an audience of installs that are themselves development-signed and update
# from the same team. `--allow-development-build` is how that decision is
# stated — out loud, in the command, and recorded in the shell history — rather
# than by editing this gate or reaching for `gh release create` by hand, which
# would skip the tag, the symbols, the checksums and the warning below.
if [ "$PUBLISH" = "--publish" ] && [ "$NOTARIZE" != 1 ]; then
  [ "$ALLOW_DEVELOPMENT" = "--allow-development-build" ] || die \
    "Refusing to publish a development-signed artifact.
     Install a Developer ID Application certificate and notarization credentials,
     or pass --allow-development-build to publish a pre-release that only
     development-signed installs by this team can run."
  printf '  publish       yes, as a PRE-RELEASE (development build, Gatekeeper will refuse it)\n'
fi

if [ "$NOTARIZE" = 1 ]; then
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || die \
    "No notarization credentials stored under '$NOTARY_PROFILE'.
     Create them once with:
       xcrun notarytool store-credentials $NOTARY_PROFILE \\
         --apple-id <your Apple ID> --team-id $CONFIGURED_TEAM \\
         --password <an app-specific password>"
fi

MARKETING="$(awk -F'= *' '/^MARKETING_VERSION/{print $2}' native/Config/Base.xcconfig | tr -d ' ')"
[ "$MARKETING" = "$VERSION" ] || die \
  "native/Config/Base.xcconfig says MARKETING_VERSION = $MARKETING, not $VERSION.
     Bump it (and CURRENT_PROJECT_VERSION) and commit before releasing — the
     updater compares the version the bundle reports, not the tag."

[ -z "$(git status --porcelain)" ] || die "The working tree is dirty. A release tag must name an exact commit."

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
native/Scripts/write-build-metadata.sh >/dev/null 2>&1 || true
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Stable \
  -destination 'generic/platform=macOS' \
  -archivePath "$BUILD_DIR/archive.xcarchive" \
  ENABLE_HARDENED_RUNTIME=YES \
  DEVELOPMENT_TEAM="$CONFIGURED_TEAM" \
  `# The identity CLASS, not the full certificate name. Automatic signing`  \
  `# rejects a specific certificate — "conflicting provisioning settings" —`  \
  `# and resolves the class against the team itself.`                        \
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

APP="$(find "$BUILD_DIR/export" -maxdepth 1 -name '*.app' | head -1)"
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
codesign -d --entitlements - --xml "$APP" >/dev/null

# The exact requirement `DesktopUpdater.swift` enforces on the downloaded
# bundle. Checking it here means a release can never ship that the app would
# then refuse to install.
BUNDLE_ID="$(defaults read "$APP/Contents/Info" CFBundleIdentifier)"
REQUIREMENT="anchor apple generic and identifier \"$BUNDLE_ID\" and certificate leaf[subject.OU] = \"$CONFIGURED_TEAM\""
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
CHANNEL="$(defaults read "$APP/Contents/Info" JunoChannel)"
[ "$CHANNEL" = "stable" ] || die "The built app reports channel '$CHANNEL'. The updater only updates 'stable'."

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

if [ "$NOTARIZE" = 1 ]; then
  step "Notarize (this takes a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
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
(
  cd "$BUILD_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$DSYM")" > "$(basename "$CHECKSUMS")"
)

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
ATTACH_PLIST="$(hdiutil attach "$DMG" -nobrowse -readonly -mountrandom /tmp -plist)"
MOUNT="$(printf '%s' "$ATTACH_PLIST" \
  | xmllint --xpath 'string(//key[text()="mount-point"]/following-sibling::string[1])' - 2>/dev/null)"
if [ -z "$MOUNT" ]; then
  printf '%s' "$ATTACH_PLIST" | grep -o '/tmp/dmg\.[A-Za-z0-9]*' | head -1 | read -r MOUNT || true
fi
[ -n "$MOUNT" ] && [ -d "$MOUNT" ] || die "The disk image mounted but its mount point could not be read."
# Detached however this step ends, including a failure: a release run must not
# leave images attached for the next one to trip over.
trap 'hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true' EXIT

if spctl --assess --type execute --verbose=4 "$MOUNT/$(basename "$APP")" 2>&1; then
  :
elif [ "$NOTARIZE" = 1 ]; then
  die "Gatekeeper rejected the notarized app."
else
  printf '  (rejected, as expected for a development build)\n'
fi
hdiutil detach "$MOUNT" -force >/dev/null
trap - EXIT

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE="$(stat -f%z "$DMG")"

printf '\n  artifact   %s\n  sha256     %s\n  bytes      %s\n' "$DMG" "$SHA" "$SIZE"

if [ "$PUBLISH" != "--publish" ]; then
  printf '\n  Verified and NOT published. A development artifact is local-only until Developer ID signing and notarization are available.\n\n'
  exit 0
fi

# ── Publish ────────────────────────────────────────────────────────────────
# Everything above this line is reversible. Nothing below it is.

step "Publish v$VERSION to $REPO"
[ -z "$(git tag --list "v$VERSION")" ] || die "Tag v$VERSION already exists. Choose a new version; releases are immutable."
git tag -a "v$VERSION" -m "Juno for Mac $VERSION"
git push origin "v$VERSION"
# A development build is published as a PRE-RELEASE, titled as one, and says so
# in its own notes.
#
# All three matter and none is decoration. GitHub's "Latest release" pointer
# skips pre-releases, so an unnotarized build cannot become the thing a stranger
# downloads by default; the title is what somebody scanning the releases list
# reads; and the paragraph is the only warning a person gets before Gatekeeper
# refuses the app with a message that sounds like the download was corrupted.
# v0.10.0 and v0.10.1 carried the same three, and this keeps the shelf
# consistent rather than mixing two kinds of release under one style.
TITLE="Juno for Mac $VERSION"
# A plain string, deliberately, and expanded unquoted below.
#
# The obvious spelling is an array — `PRERELEASE=(--prerelease)` and
# `"${PRERELEASE[@]}"` — and it is a trap here. macOS ships bash 3.2, which is
# what this script's `#!/bin/bash` resolves to, and in 3.2 expanding an *empty*
# array under `set -u` aborts with "unbound variable". The array is empty on
# exactly one path: the notarized one. So the first real Developer ID release
# would have died at `gh release create`, twenty minutes into the build and
# after `git push origin "v$VERSION"` had already made the tag public — leaving
# a tag with no release behind it and a version number that can never be reused.
#
# Unquoted word-splitting is safe for this value because it is a fixed literal
# chosen by the line below, never anything read from outside.
PRERELEASE_FLAG=""
DEVELOPMENT_NOTE=""
if [ "$NOTARIZE" != 1 ]; then
  TITLE="$TITLE (Development build)"
  PRERELEASE_FLAG="--prerelease"
  DEVELOPMENT_NOTE="

**This build is not notarized.** macOS Gatekeeper will refuse to open it after download. It updates existing installs that are themselves development-signed by this team; on any other Mac, build from source."
fi

gh release create "v$VERSION" "$DMG" \
  "$DSYM" \
  "$CHECKSUMS" \
  --repo "$REPO" \
  $PRERELEASE_FLAG \
  --title "$TITLE" \
  --notes "$(cat <<NOTES
Source commit \`$(git rev-parse HEAD)\`
DMG SHA-256 \`$SHA\` · $SIZE bytes
Symbols and \`SHA256SUMS.txt\` are attached for crash diagnosis and independent verification.

Installs by drag-and-drop. Existing installs update themselves within ten minutes, or immediately from Juno → Install Update and Relaunch.$DEVELOPMENT_NOTE
NOTES
)"

printf '\n  Published. /api/downloads picks it up within ten minutes (its cache window).\n\n'
