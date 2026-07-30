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

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }

[ -n "$VERSION" ] || die "Usage: native/Scripts/release-macos.sh <version> [--publish]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must be MAJOR.MINOR.PATCH, got '$VERSION'."

# ── Preflight ──────────────────────────────────────────────────────────────
# Every one of these is something that fails late and expensively otherwise: a
# missing certificate after a 20-minute archive, a team mismatch after
# notarization, a dirty tree that makes the published commit a fiction.

step "Preflight"

command -v xcodebuild >/dev/null || die "xcodebuild is not on PATH."
command -v gh >/dev/null || die "The GitHub CLI is required to publish."

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
codesign -dv --verbose=4 "$APP" 2>&1 | grep -q "TeamIdentifier=$CONFIGURED_TEAM" \
  || die "The signed bundle does not carry team $CONFIGURED_TEAM."
codesign -d --entitlements - --xml "$APP" >/dev/null

# The exact requirement `DesktopUpdater.swift` enforces on the downloaded
# bundle. Checking it here means a release can never ship that the app would
# then refuse to install.
BUNDLE_ID="$(defaults read "$APP/Contents/Info" CFBundleIdentifier)"
REQUIREMENT="anchor apple generic and identifier \"$BUNDLE_ID\" and certificate leaf[subject.OU] = \"$CONFIGURED_TEAM\""
if [ "$NOTARIZE" = 1 ]; then
  REQUIREMENT="$REQUIREMENT and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
fi
codesign --verify --strict -R "$REQUIREMENT" "$APP" \
  || die "The bundle does not satisfy the requirement the auto-updater enforces."

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

step "Gatekeeper"
# The app inside the image has to pass on a machine that has never seen it,
# which is what `spctl --assess` answers.
MOUNT="$(hdiutil attach "$DMG" -nobrowse -readonly -mountrandom /tmp -plist \
  | plutil -extract system-entities.0.mount-point raw - 2>/dev/null \
  || hdiutil attach "$DMG" -nobrowse -readonly | tail -1 | awk '{print $3}')"
if spctl --assess --type execute --verbose=4 "$MOUNT/$(basename "$APP")" 2>&1; then
  :
elif [ "$NOTARIZE" = 1 ]; then
  hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
  die "Gatekeeper rejected the notarized app."
else
  printf '  (rejected, as expected for a development build)\n'
fi
hdiutil detach "$MOUNT" -force >/dev/null

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE="$(stat -f%z "$DMG")"

printf '\n  artifact   %s\n  sha256     %s\n  bytes      %s\n' "$DMG" "$SHA" "$SIZE"

if [ "$PUBLISH" != "--publish" ]; then
  printf '\n  Verified and NOT published. Re-run with --publish to create the release.\n\n'
  exit 0
fi

# ── Publish ────────────────────────────────────────────────────────────────
# Everything above this line is reversible. Nothing below it is.

step "Publish v$VERSION to $REPO"
git tag -a "v$VERSION" -m "Juno for Mac $VERSION" 2>/dev/null || true
git push origin "v$VERSION"
gh release create "v$VERSION" "$DMG" \
  --repo "$REPO" \
  --title "Juno for Mac $VERSION" \
  --notes "$(cat <<NOTES
SHA-256 \`$SHA\` · $SIZE bytes

Installs by drag-and-drop. Existing installs update themselves within ten minutes, or immediately from Juno → Install Update and Relaunch.
$([ "$NOTARIZE" = 1 ] || printf '\n**This build is not notarized.** macOS Gatekeeper will refuse to open it after download. Until a Developer ID release is published, install by building from source.\n')
NOTES
)"

printf '\n  Published. /api/downloads picks it up within ten minutes (its cache window).\n\n'
