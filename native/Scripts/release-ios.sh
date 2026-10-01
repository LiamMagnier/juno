#!/usr/bin/env bash
# Local counterpart of release-ios.yml. Builds/archives by default; upload is
# an explicit --upload action, and is never part of --check-only.
set -euo pipefail
cd "$(dirname "$0")/../.."

CHECK_ONLY=0
UPLOAD=0
VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --upload) UPLOAD=1 ;;
    --version) shift; VERSION="${1:?--version needs MAJOR.MINOR.PATCH}" ;;
    --help) echo 'Usage: native/Scripts/release-ios.sh [--check-only] [--version MAJOR.MINOR.PATCH] [--upload]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$CHECK_ONLY" -eq 0 ] || [ "$UPLOAD" -eq 0 ] || { echo '--check-only cannot upload.' >&2; exit 2; }

CONFIGURED_VERSION="$(sed -n 's/^MARKETING_VERSION[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')"
BUILD_NUMBER="$(sed -n 's/^CURRENT_PROJECT_VERSION[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')"
IOS_TEAM="${IOS_DEVELOPMENT_TEAM:-$(sed -n 's/^DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*//p' native/Config/Base.xcconfig | head -1 | tr -d '[:space:]')}"
VERSION="${VERSION:-$CONFIGURED_VERSION}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Version must be MAJOR.MINOR.PATCH.' >&2; exit 1; }
[ "$VERSION" = "$CONFIGURED_VERSION" ] || { echo 'Requested version differs from committed Base.xcconfig.' >&2; exit 1; }
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo 'Build number must be numeric.' >&2; exit 1; }
command -v xcodebuild >/dev/null
command -v xcrun >/dev/null
[ -f native/iOS/JunoMobile/Resources/PrivacyInfo.xcprivacy ]
[ -f native/iOS/JunoMobile/JunoMobile.xcodeproj/project.pbxproj ]

OUTPUT_DIR="${JUNO_IOS_RELEASE_OUTPUT:-${TMPDIR:-/tmp}/juno-ios-release-$VERSION-$BUILD_NUMBER}"
mkdir -p "$OUTPUT_DIR"
xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
  -configuration Stable -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$OUTPUT_DIR/simulator-dd" \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=YES CODE_SIGNING_ALLOWED=NO build
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "iOS $VERSION ($BUILD_NUMBER) unsigned release build verified. No archive or upload was made."
  exit 0
fi

[[ "$IOS_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Set IOS_DEVELOPMENT_TEAM to the distribution team.' >&2; exit 1; }
: "${IOS_ASC_KEY_ID:?Set IOS_ASC_KEY_ID}"
: "${IOS_ASC_ISSUER_ID:?Set IOS_ASC_ISSUER_ID}"
: "${IOS_ASC_PRIVATE_KEY_BASE64:?Set IOS_ASC_PRIVATE_KEY_BASE64}"
[[ "$IOS_ASC_KEY_ID" =~ ^[A-Za-z0-9]+$ ]] || { echo 'Invalid App Store key id.' >&2; exit 1; }

KEY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/juno-ios-asc.XXXXXX")"
trap 'rm -rf "$KEY_DIR"' EXIT
KEY_PATH="$KEY_DIR/AuthKey_$IOS_ASC_KEY_ID.p8"
printf '%s' "$IOS_ASC_PRIVATE_KEY_BASE64" | base64 --decode > "$KEY_PATH"
chmod 600 "$KEY_PATH"
cat > "$OUTPUT_DIR/export-options.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>$IOS_TEAM</string>
<key>uploadSymbols</key><true/>
</dict></plist>
PLIST
AUTH_ARGS=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$IOS_ASC_KEY_ID" -authenticationKeyIssuerID "$IOS_ASC_ISSUER_ID")
xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
  -configuration Stable -destination 'generic/platform=iOS' \
  -archivePath "$OUTPUT_DIR/JunoMobile.xcarchive" "${AUTH_ARGS[@]}" \
  DEVELOPMENT_TEAM="$IOS_TEAM" CODE_SIGN_STYLE=Automatic archive
xcodebuild -exportArchive -archivePath "$OUTPUT_DIR/JunoMobile.xcarchive" \
  -exportPath "$OUTPUT_DIR/export" -exportOptionsPlist "$OUTPUT_DIR/export-options.plist" "${AUTH_ARGS[@]}"
IPA="$(find "$OUTPUT_DIR/export" -maxdepth 1 -type f -name '*.ipa' -print -quit)"
[ -n "$IPA" ] || { echo 'No IPA was exported.' >&2; exit 1; }
if [ "$UPLOAD" -eq 1 ]; then
  # altool's API_PRIVATE_KEYS_DIR keeps the key in this isolated temporary
  # directory, so an existing login key is never overwritten or deleted.
  API_PRIVATE_KEYS_DIR="$KEY_DIR" xcrun altool --validate-app -f "$IPA" --type ios --api-key "$IOS_ASC_KEY_ID" --api-issuer "$IOS_ASC_ISSUER_ID"
  API_PRIVATE_KEYS_DIR="$KEY_DIR" xcrun altool --upload-package "$IPA" --api-key "$IOS_ASC_KEY_ID" --api-issuer "$IOS_ASC_ISSUER_ID" --wait
fi
echo "iOS archive and IPA: $OUTPUT_DIR"
