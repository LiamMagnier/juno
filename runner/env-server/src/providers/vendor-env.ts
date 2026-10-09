import type { ProviderInstance } from "../contracts/code-v2.js";
import { expandHome, spawnPath } from "./detect.js";

/**
 * Environment for a vendor runtime the user installed themselves (claude,
 * codex). It is the user's own environment — their CLI reads its own
 * credential store through HOME and the login keychain — minus anything Alevr
 * put there for itself, plus a PATH that finds the CLI's own helpers, plus the
 * instance's account isolation (CLAUDE_CONFIG_DIR / CODEX_HOME, never HOME:
 * moving HOME hides the macOS keychain and the CLI reports "not logged in").
 */
export function vendorEnv(
  instance: ProviderInstance,
  configVar: "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("ALEVR_") || k.startsWith("JUNO_")) continue;
    env[k] = v;
  }
  env.PATH = spawnPath(instance.binaryPath, base);
  for (const [k, v] of Object.entries(instance.env ?? {})) env[k] = v;
  if (configVar && instance.configDir) env[configVar] = expandHome(instance.configDir);
  return env;
}
