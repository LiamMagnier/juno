#!/usr/bin/env node

/**
 * Start exactly one PM2 app from an ecosystem file.
 *
 * PM2 can throw while reconciling a full ecosystem when its saved process
 * list contains a stale numeric slot.  A one-service ecosystem avoids the
 * broken slot and lets a deploy recreate a missing process without touching
 * the already healthy services.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configFile = argumentValue("--config");
const service = argumentValue("--service");

if (!configFile || !service) {
  console.error("Usage: reconcile-pm2-service.mjs --config <ecosystem> --service <name>");
  process.exit(2);
}

const resolvedConfig = path.resolve(configFile);
const config = require(resolvedConfig);
const app = (config.apps ?? []).find((entry) => entry?.name === service);

if (!app) {
  throw new Error(`PM2 ecosystem does not define service ${service}`);
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "juno-pm2-"));
const tempConfig = path.join(tempDirectory, "ecosystem.config.cjs");

try {
  fs.writeFileSync(
    tempConfig,
    `module.exports = ${JSON.stringify({ apps: [app] })};\n`,
    { mode: 0o600 },
  );

  // A stale PM2 dump can retain the service name with a dead numeric slot.
  // `pm2 start` then resolves the one-service ecosystem back to that slot and
  // fails before it can create a process. Delete only this broken named entry
  // before starting it so healthy services keep running untouched.
  spawnSync("pm2", ["delete", service], { stdio: "inherit" });

  const result = spawnSync("pm2", ["start", tempConfig, "--update-env"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
