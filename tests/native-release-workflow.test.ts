import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const IOS_RELEASE = readFileSync(new URL("../.github/workflows/release-ios.yml", import.meta.url), "utf8");

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
