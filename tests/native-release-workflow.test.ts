import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const IOS_RELEASE = readFileSync(new URL("../.github/workflows/release-ios.yml", import.meta.url), "utf8");
const MACOS_RELEASE = readFileSync(new URL("../native/Scripts/release-macos.sh", import.meta.url), "utf8");

test("iOS production release is protected and fails closed on missing signing credentials", () => {
  assert.match(IOS_RELEASE, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(IOS_RELEASE, /environment:\s+Production/);
  assert.match(IOS_RELEASE, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(IOS_RELEASE, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(IOS_RELEASE, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(IOS_RELEASE, /\.\/scripts\/release-gates\.sh/);
  assert.match(IOS_RELEASE, /IOS_ASC_KEY_ID/);
  assert.match(IOS_RELEASE, /IOS_ASC_ISSUER_ID/);
  assert.match(IOS_RELEASE, /IOS_ASC_PRIVATE_KEY_BASE64/);
  assert.match(IOS_RELEASE, /\[ "\$missing" -eq 0 \]/);
  assert.doesNotMatch(IOS_RELEASE, /publish-dev/);
  assert.match(IOS_RELEASE, /CODE_SIGN_STYLE=Automatic/);
});

test("iOS production release archives, validates, and uploads the exact signed IPA", () => {
  assert.match(IOS_RELEASE, /-configuration Stable/);
  assert.match(IOS_RELEASE, /-destination 'generic\/platform=iOS'/);
  assert.match(IOS_RELEASE, /-allowProvisioningUpdates/);
  assert.match(IOS_RELEASE, /-authenticationKeyPath/);
  assert.match(IOS_RELEASE, /method<\/key><string>app-store/);
  assert.match(IOS_RELEASE, /altool --validate-app/);
  assert.match(IOS_RELEASE, /altool --upload-package/);
  assert.match(IOS_RELEASE, /--api-key/);
  assert.match(IOS_RELEASE, /--api-issuer/);
  assert.match(IOS_RELEASE, /if: always\(\)/);
  assert.match(IOS_RELEASE, /Remove App Store Connect key from the runner/);
});

test("macOS publication reverts a public release when the updater feed cannot verify it", () => {
  assert.match(MACOS_RELEASE, /gh api --method PATCH "repos\/\$REPO\/releases\/\$RELEASE_ID" -F draft=true/);
  assert.match(MACOS_RELEASE, /reverted to draft/);
  assert.match(MACOS_RELEASE, /could not revert the release to draft/);
});

/**
 * The live-feed check, run against the feeds the backend can now serve.
 *
 * LiamMagnier/juno went private, so the feed hands out a signed URL on a GitHub
 * release host rather than the github.com link the check used to require. The
 * jq filter is lifted out of the script and run for real, so this is the
 * script's own decision rather than a paraphrase of it.
 */
const FEED_FILTER = /'(\[\.downloads\[\][\s\S]*?\| \.url\]\[0\] \/\/ empty)'/.exec(MACOS_RELEASE)?.[1];
const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;

test("the feed check accepts the github.com link or a signed release-host URL for the same build", { skip: !HAS_JQ && "jq is not installed" }, () => {
  assert.ok(FEED_FILTER, "the live-feed jq filter is where the script keeps it");
  const sha = "ab".repeat(32);
  const row = {
    platform: "macos",
    label: "macOS",
    url: "https://github.com/LiamMagnier/juno/releases/download/v1.6.0/Juno-1.6.0.dmg",
    urlExpiresAt: null,
    version: "1.6.0",
    size: 23_958_367,
    sha256: sha,
    available: true,
    notarized: true,
  };
  const pick = (overrides: Record<string, unknown>) =>
    execFileSync(
      "jq",
      [
        "-r",
        "--arg", "version", "1.6.0",
        "--arg", "sha", sha,
        "--argjson", "size", "23958367",
        "--argjson", "notarized", "true",
        FEED_FILTER,
      ],
      { input: JSON.stringify({ downloads: [{ ...row, ...overrides }, { platform: "windows", available: false, url: null }] }) },
    ).toString().trim();

  const signed =
    "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sp=r&se=2026-09-22T21%3A36%3A11Z&sig=a%2Bb%3D&jwt=a.b.c";
  assert.equal(pick({}), row.url);
  assert.equal(pick({ url: signed, urlExpiresAt: "2026-09-22T21:17:06.000Z" }), signed);
  assert.equal(pick({ url: "https://objects.githubusercontent.com/x?X-Amz-Expires=300" }), "https://objects.githubusercontent.com/x?X-Amz-Expires=300");

  // Everything that was refused before is still refused.
  for (const wrong of [
    { url: "https://evil.example.com/Juno-1.6.0.dmg" },
    { url: "http://release-assets.githubusercontent.com/x" },
    { url: "https://release-assets.githubusercontent.com.evil.example/x" },
    { url: "https://github.com/LiamMagnier/juno/releases/download/v1.5.4/Juno-1.5.4.dmg" },
    { url: null },
    { version: "1.5.4" },
    { sha256: "cd".repeat(32) },
    { size: 23_958_366 },
    { notarized: false },
    { available: false },
  ]) {
    assert.equal(pick(wrong), "", JSON.stringify(wrong));
  }
});

test("the feed check downloads what the feed names, without a credential, and compares the bytes", () => {
  // A signed URL names no version, so its string cannot prove which file it
  // serves; the bytes can. And a github.com link to a private asset matches
  // the old string check while 404ing for every installed app.
  assert.match(MACOS_RELEASE, /curl --fail --silent --location --proto '=https' --proto-redir '=https' --max-time 300 \\\n\s+--output "\$FEED_ASSET" "\$FEED_ASSET_URL"/);
  assert.match(MACOS_RELEASE, /\[ "\$\(shasum -a 256 "\$FEED_ASSET" \| awk '\{print \$1\}'\)" = "\$SHA" \]/);
  // The signed URL is a working link to the file, so it never reaches the log.
  assert.doesNotMatch(MACOS_RELEASE, /printf[^\n]*\$FEED_ASSET_URL/);
});

const MACOS_WORKFLOW = readFileSync(
  new URL("../.github/workflows/release-macos.yml", import.meta.url),
  "utf8",
);

/**
 * The regressions behind "Apple could not verify Juno-1.5.4.dmg is free of
 * malware".
 *
 * Every macOS release from v0.15.15 to v1.5.4 was development-signed and
 * unnotarized, published as an ordinary stable GitHub release, and served to
 * every website visitor by `/api/downloads`. The production path that was
 * supposed to prevent that had never once run to completion. Each assertion
 * below pins one of the reasons.
 */

test("an unnotarized macOS build can only ever be published as a prerelease", () => {
  // `isStableRelease()` filters prereleases out of the public feed, so this is
  // what makes a development-signed build structurally undistributable.
  assert.match(MACOS_RELEASE, /EXPECTED_PRERELEASE="\$\(\[ "\$NOTARIZE" = 1 \] && echo false \|\| echo true\)"/);
  assert.match(MACOS_RELEASE, /-F "prerelease=\$EXPECTED_PRERELEASE"/);
  // And the result is read back, not assumed.
  assert.match(MACOS_RELEASE, /'\.prerelease'\)" = "\$EXPECTED_PRERELEASE"/);
  // The old unconditional promotion to a public stable release is gone.
  assert.doesNotMatch(MACOS_RELEASE, /-F draft=false -F prerelease=false/);
});

test("the release manifest records whether Apple notarized the build", () => {
  // The fact `/api/downloads` reads to decide whether a build is safe to offer.
  assert.match(MACOS_RELEASE, /"notarized": \$\(\[ "\$NOTARIZE" = 1 \] && echo true \|\| echo false\)/);
  assert.match(MACOS_RELEASE, /"schema_version": 2/);
});

test("the production archive is signed for Developer ID, not left unsigned for export to fix", () => {
  // CODE_SIGNING_ALLOWED=NO skipped ProcessProductPackaging, so the entitlements
  // never reached the binary and ENABLE_HARDENED_RUNTIME had nothing to apply to.
  assert.match(MACOS_RELEASE, /CODE_SIGN_STYLE=Manual/);
  assert.match(MACOS_RELEASE, /CODE_SIGN_IDENTITY="\$IDENTITY"/);
  assert.match(MACOS_RELEASE, /OTHER_CODE_SIGN_FLAGS="--timestamp"/);
  // Manual signing in the export too: automatic needs a developer-portal session
  // that a headless runner does not have.
  assert.match(MACOS_RELEASE, /<key>signingStyle<\/key><string>manual<\/string>/);
  assert.match(MACOS_RELEASE, /<key>signingCertificate<\/key><string>\$IDENTITY<\/string>/);
  assert.doesNotMatch(MACOS_RELEASE, /signingStyle<\/key><string>automatic/);
});

test("hardened runtime and both entitlements are asserted on the signed app", () => {
  // The notary service rejects an executable without hardened runtime, and a
  // missing entitlement is silent until a user's first dictation attempt fails.
  assert.match(MACOS_RELEASE, /was signed without Hardened Runtime/);
  assert.match(MACOS_RELEASE, /com\.apple\.security\.device\.audio-input com\.apple\.security\.automation\.apple-events/);
  assert.match(MACOS_RELEASE, /is missing the entitlement/);
  // The check that asserted nothing, because it discarded its own output. Anchored
  // to the start of a line so the comment recording why it went does not match.
  assert.doesNotMatch(MACOS_RELEASE, /^codesign -d --entitlements - --xml "\$APP" >\/dev\/null$/m);
});

test("the app itself is notarized and stapled, not only the disk image", () => {
  // Juno installs by drag-and-drop: a ticket stapled only to the DMG never
  // reaches the app the person actually runs.
  assert.match(MACOS_RELEASE, /xcrun stapler staple "\$APP"/);
  assert.match(MACOS_RELEASE, /xcrun stapler validate "\$APP"/);
  assert.match(MACOS_RELEASE, /xcrun stapler staple "\$DMG"/);
  // And the ticket on the dragged-out app is proven offline inside the image.
  assert.match(MACOS_RELEASE, /xcrun stapler validate "\$MOUNT\/\$\(basename "\$APP"\)"/);
});

test("Gatekeeper assesses the disk image, which is what a downloader meets first", () => {
  // `--type execute` on the app was the only assessment, so the gate could not
  // fail on the DMG-level rejection users were actually reporting.
  assert.match(MACOS_RELEASE, /spctl --assess --type open --context context:primary-signature --verbose=4 "\$DMG"/);
  assert.match(MACOS_RELEASE, /Gatekeeper rejected the notarized disk image/);
});

test("the production workflow authenticates the GitHub CLI the release script requires", () => {
  // Without this the script died in preflight with "The GitHub CLI is not
  // authenticated", before it built anything — every time.
  assert.match(MACOS_WORKFLOW, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(MACOS_WORKFLOW, /gh auth status --hostname github\.com/);
});

test("the production workflow builds the commit that was approved", () => {
  // `ref: main` resolved at checkout time, after the Production approval gate,
  // so an unapproved commit could be signed, notarized, tagged and published.
  assert.match(MACOS_WORKFLOW, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(MACOS_WORKFLOW, /^\s+ref: main$/m);
  assert.match(MACOS_WORKFLOW, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  // A dispatch from the wrong branch fails loudly instead of skipping green.
  assert.match(MACOS_WORKFLOW, /Dispatch this workflow from main/);
  assert.doesNotMatch(MACOS_WORKFLOW, /if: github\.ref == 'refs\/heads\/main'/);
});

test("a failed production release keeps its diagnostics and drops its notary key", () => {
  // The upload named a directory the script never wrote to — the build path
  // carries a PID suffix — so every failure uploaded an empty artifact.
  assert.match(MACOS_WORKFLOW, /JUNO_RELEASE_DIR: \/private\/tmp\/juno-release/);
  assert.match(MACOS_WORKFLOW, /\$\{\{ env\.JUNO_RELEASE_DIR \}\}\/notary-result\*\.json/);
  assert.match(MACOS_WORKFLOW, /\$\{\{ env\.JUNO_RELEASE_DIR \}\}\/archive-dd\/Logs\/\*\*/);
  assert.match(MACOS_WORKFLOW, /if-no-files-found: warn/);
  // The key removal was the last line of a `set -e` step, so a failure left an
  // App Store Connect private key on the runner.
  assert.match(MACOS_WORKFLOW, /Remove the notarization key from the runner/);
  // The notary log is fetched on rejection; the status alone never says why.
  assert.match(MACOS_RELEASE, /xcrun notarytool log "\$SUBMISSION_ID"/);
});
