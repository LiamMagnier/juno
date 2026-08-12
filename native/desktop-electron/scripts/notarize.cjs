/**
 * electron-builder `afterSign` hook — submits the signed .app to Apple's
 * notary service and staples the resulting ticket.
 *
 * The contract this file exists to honour: an unsigned local build must still
 * complete. A developer without an Apple Developer account, or CI on a pull
 * request from a fork, has no credentials and should get a working
 * `dist/mac-arm64/Juno.app` plus one line of explanation — not a failed build
 * with a stack trace about a missing environment variable. So every "cannot
 * notarize" path logs and returns; only a notarization that was attempted and
 * genuinely failed throws.
 *
 * CommonJS (`.cjs`) because package.json declares `"type": "module"` and
 * electron-builder loads hooks with `require`.
 *
 * @see https://www.electron.build/docs/features/code-signing/notarization/
 * @see https://github.com/electron/notarize
 */

"use strict";

/**
 * Two credential shapes, and the order matters.
 *
 * Credentials never appear in any log line here. Notarization logs are routinely
 * pasted into issues and CI output is often public; an app-specific password in
 * a build log is a leaked credential regardless of how the build went. Only
 * variable *names* are ever printed.
 *
 * `notarytool` accepts either an App Store Connect **API key** or an Apple ID
 * with an app-specific password. This hook originally required only the latter —
 * which would have failed every signed build in this repository, because
 * `.github/workflows/release-macos.yml` provisions the *former*
 * (`APPLE_NOTARY_KEY_BASE64`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER`).
 * The repo provisioned one thing and the hook demanded another, and nothing
 * would have surfaced that until someone tried to cut a release.
 *
 * The API key is preferred: it is revocable per key, carries no account
 * password, and is what the existing release workflow already stores. The Apple
 * ID path is kept because it is what a developer signing locally will have to
 * hand.
 */
const API_KEY_ENV = ["APPLE_NOTARY_KEY_PATH", "APPLE_NOTARY_KEY_ID", "APPLE_NOTARY_ISSUER"];
const APPLE_ID_ENV = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

/** Names only — never values — for a log line that says what is missing. */
function present(names) {
  return names.every((name) => Boolean(process.env[name]));
}

/**
 * @param {import("electron-builder").AfterPackContext} context
 * @returns {Promise<void>}
 */
module.exports = async function notarizeMac(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    return;
  }

  // `CSC_IDENTITY_AUTO_DISCOVERY=false` is how electron-builder is told to skip
  // signing. An unsigned .app cannot be notarized, and submitting one produces
  // a confusing rejection several minutes later rather than an immediate error.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    console.log("[notarize] Signing disabled (CSC_IDENTITY_AUTO_DISCOVERY=false) — skipping.");
    return;
  }

  const useApiKey = present(API_KEY_ENV);
  const useAppleId = !useApiKey && present(APPLE_ID_ENV);

  if (!useApiKey && !useAppleId) {
    // Names only. Never values.
    console.log(
      "[notarize] Skipping notarization: no credentials in the environment. " +
        "This build is fine for local use, but Gatekeeper will block it on " +
        "another machine. Provide EITHER " +
        `${API_KEY_ENV.join(", ")} (preferred — this is what ` +
        ".github/workflows/release-macos.yml already provisions) OR " +
        `${APPLE_ID_ENV.join(", ")}.`,
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  // @electron/notarize v3 is ESM-only. A static `require` of it from this CJS
  // hook works only on Node ≥22.12; `await import()` works everywhere and keeps
  // the cost off any build that skips above.
  const { notarize } = await import("@electron/notarize");

  console.log(
    `[notarize] Submitting ${appName}.app to Apple using ` +
      `${useApiKey ? "an App Store Connect API key" : "an Apple ID"}. ` +
      "This usually takes a few minutes.",
  );
  const startedAt = Date.now();

  // notarytool (the v3 default; altool is retired). Credentials are passed
  // straight from the environment into the call and are never held in a local
  // that might end up in an error message.
  await notarize(
    useApiKey
      ? {
          appPath,
          // `appleApiKey` is a *path* to the .p8. CI writes the decoded
          // secret to a file and passes its path, so the key never becomes an
          // argv entry — argv is world-readable via `ps`.
          appleApiKey: process.env.APPLE_NOTARY_KEY_PATH,
          appleApiKeyId: process.env.APPLE_NOTARY_KEY_ID,
          appleApiIssuer: process.env.APPLE_NOTARY_ISSUER,
        }
      : {
          appPath,
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
  );

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[notarize] Notarized and stapled ${appName}.app in ${seconds}s.`);
  console.log(`[notarize] Verify with: stapler validate "${appPath}"`);
};
