/**
 * A stand-in for the PM2 CLI, for tests that drive deploy/deploy.sh's own
 * release reload against it (tests/release-gates.test.ts).
 *
 * The process list lives in the JSON file named by FAKE_PM2_STATE, and every
 * call is appended to its `calls`, so a test can read back both what PM2 was
 * asked to do and what it ended up running. It models the behaviour the
 * release transaction depends on and nothing more:
 *   - `startOrReload` and `start` bring the apps a config declares online and
 *     leave every other process alone, as PM2 does;
 *   - `delete` removes an app, and fails for one it does not have;
 *   - `save` records the list a reboot would resurrect.
 * `failToStart` names apps `startOrReload` fails to create (a stale PM2 slot)
 * and `failToDelete` apps PM2 will not delete.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stateFile = process.env.FAKE_PM2_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const [command, ...args] = process.argv.slice(2);

function declaredBy(config) {
  const file = path.resolve(config);
  delete require.cache[file];
  return require(file).apps.map((app) => app.name);
}

// A config is logged as `<file>(<apps>)`: the one-service ecosystem lives in a
// random temporary directory, and which apps it started is what matters.
function describe(arg) {
  if (!/\.c?js$/.test(arg)) return arg;
  try {
    return `${path.basename(arg)}(${declaredBy(arg)})`;
  } catch {
    return path.basename(arg);
  }
}

function bringOnline(name) {
  const app = state.running.find((row) => row.name === name);
  if (app) app.status = "online";
  else state.running.push({ name, status: "online" });
}

state.calls.push([command, ...args.map(describe)].join(" "));

let exitCode = 0;
try {
  switch (command) {
    case "update":
      break;
    case "jlist":
      process.stdout.write(
        JSON.stringify(state.running.map((app) => ({ name: app.name, pm2_env: { status: app.status } }))),
      );
      break;
    case "startOrReload":
      for (const name of declaredBy(args[0])) {
        if (state.failToStart.includes(name)) exitCode = 1;
        else bringOnline(name);
      }
      break;
    case "start":
      for (const name of declaredBy(args[0])) bringOnline(name);
      break;
    case "restart":
      if (state.running.some((app) => app.name === args[0])) bringOnline(args[0]);
      else exitCode = 1;
      break;
    case "delete":
      if (state.failToDelete.includes(args[0]) || !state.running.some((app) => app.name === args[0])) {
        console.error(`[PM2][ERROR] Process or Namespace ${args[0]} could not be deleted`);
        exitCode = 1;
      } else {
        state.running = state.running.filter((app) => app.name !== args[0]);
      }
      break;
    case "save":
      state.dump = state.running.map((app) => app.name);
      break;
    default:
      console.error(`fake pm2: unsupported command ${command}`);
      exitCode = 1;
  }
} catch (error) {
  console.error(`fake pm2: ${error.message}`);
  exitCode = 1;
} finally {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
process.exit(exitCode);
