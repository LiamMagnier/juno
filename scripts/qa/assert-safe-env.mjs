#!/usr/bin/env node
// Refuses to let a QA run start unless the environment is safe (spec §14).
//
//   node scripts/qa/assert-safe-env.mjs [--cwd <dir>]
//       Exit 0 when safe; otherwise print every reason and exit 2.
//   node scripts/qa/assert-safe-env.mjs --print-child-env [--port N] [--control KEY=VALUE ...]
//       After the same checks, print the allowlisted child environment as
//       NUL-separated KEY=VALUE pairs for `env -i`.
//
// The rules live in lib/safe-env.mjs; run-prod-e2e.sh calls this first, before
// it touches a database or starts anything.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv, checkSafeEnv, readTestEnv, RUNNER_CONTROL_KEYS } from "./lib/safe-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = { cwd: process.cwd(), print: false, port: undefined, control: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--print-child-env") args.print = true;
    else if (arg === "--port") args.port = argv[++i];
    else if (arg === "--control") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      if (eq <= 0 || !RUNNER_CONTROL_KEYS.includes(key)) {
        throw new Error(`--control takes KEY=VALUE with KEY one of ${RUNNER_CONTROL_KEYS.join(", ")}; got "${pair}".`);
      }
      args.control[key] = pair.slice(eq + 1);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[qa] ${error instanceof Error ? error.message : String(error)}`);
    return 64;
  }
  const result = checkSafeEnv({ env: process.env, dirs: [ROOT, args.cwd], root: ROOT });
  if (!result.ok) {
    console.error("[qa] Refusing to run. The QA runner only talks to the disposable local database:");
    for (const error of result.errors) console.error(`[qa]   - ${error}`);
    return 2;
  }
  let testEnv;
  try {
    testEnv = readTestEnv(ROOT);
  } catch (error) {
    console.error(`[qa] scripts/qa/test.env is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (args.print) {
    const child = buildChildEnv({ env: process.env, testEnv, port: args.port, control: args.control });
    process.stdout.write(Object.entries(child).map(([k, v]) => `${k}=${v}\0`).join(""));
  } else {
    console.error(`[qa] Environment is safe: database ${result.database} on 127.0.0.1:55439.`);
  }
  return 0;
}

process.exitCode = main();
