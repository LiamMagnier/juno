/**
 * electron-builder `afterPack` hook — restores the executable bit on node-pty's
 * `spawn-helper` before the bundle is signed.
 *
 * Why this is not paranoia: node-pty publishes `spawn-helper` (a small Mach-O
 * that performs the fork/exec dance for a real PTY) inside its npm tarball, and
 * the tarball has repeatedly shipped it as mode 644 instead of 755
 * (microsoft/node-pty#850). Package managers that faithfully preserve archive
 * permissions then install it without `+x`, and every `pty.spawn()` fails at
 * runtime with a `posix_spawnp failed` error that points nowhere near the cause.
 * The failure only appears in a packaged build, on someone else's machine.
 *
 * Running in `afterPack` matters: electron-builder signs after this hook, so the
 * corrected mode is what the signature covers. Fixing it later would invalidate
 * the signature.
 *
 * This is a no-op when the file is already executable, and it does not fail the
 * build if node-pty is absent — that is a legitimate state for a `--dir` build
 * or after node-pty is swapped out.
 *
 * CommonJS (`.cjs`) because package.json declares `"type": "module"` and
 * electron-builder loads hooks with `require`.
 */

"use strict";

const { chmod, stat } = require("node:fs/promises");
const path = require("node:path");

/** Owner/group/other execute bits. */
const EXECUTABLE_BITS = 0o111;

/**
 * @param {import("electron-builder").AfterPackContext} context
 * @returns {Promise<void>}
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  // Native code is unpacked out of the archive (see `asarUnpack` in
  // electron-builder.yml), so the real file lives under app.asar.unpacked.
  const helperPath = path.join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
    "spawn-helper",
  );

  let mode;
  try {
    ({ mode } = await stat(helperPath));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log(
        "[afterPack] node-pty spawn-helper not found — nothing to fix. " +
          "If terminals are expected to work in this build, check the " +
          "asarUnpack rules in electron-builder.yml.",
      );
      return;
    }
    throw error;
  }

  if ((mode & EXECUTABLE_BITS) === EXECUTABLE_BITS) {
    return;
  }

  await chmod(helperPath, mode | EXECUTABLE_BITS);
  console.log(
    `[afterPack] Restored the executable bit on node-pty spawn-helper ` +
      `(was ${(mode & 0o777).toString(8)}).`,
  );
};
