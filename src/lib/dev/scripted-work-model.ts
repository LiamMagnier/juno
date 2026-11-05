/**
 * The scripted Work model's switch (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.7).
 *
 * For tests and local demos on a machine with no provider key: a Work run
 * driven by a fixed script (runner/agent-core/src/work/scripted-model.ts)
 * instead of a model, so real tools (a real computer included) can be
 * exercised end to end. It is never in the model catalog, never selectable,
 * and never in production. It applies only when every one of these holds:
 *
 *   - NODE_ENV is not "production";
 *   - JUNO_ALLOW_SCRIPTED_WORK is exactly "1";
 *   - WORK_SCRIPTED_MODEL_FILE names a readable script;
 *   - the account is listed in WORK_SCRIPTED_MODEL_USERS (ids, or emails
 *     compared case-insensitively).
 *
 * In production it answers null whatever is set, and logs
 * `work.scripted_model_refused` once if any of the variables is set, so a
 * stray demo setting in a production env file is visible and inert. A run it
 * drives says so in its own transcript (the runner's `model_substituted`
 * degradation: "Development run: a scripted test model drove this task. No AI
 * model was called.").
 */

import { readFileSync } from "node:fs";

const VARIABLES = ["JUNO_ALLOW_SCRIPTED_WORK", "WORK_SCRIPTED_MODEL_FILE", "WORK_SCRIPTED_MODEL_USERS"] as const;

/** What the runner says in the run when the scripted model drove it. */
export const SCRIPTED_MODEL_EXPLANATION =
  "Development run: a scripted test model drove this task. No AI model was called.";

let refusalLogged = false;

/** Test seam: log the production refusal again. */
export function resetScriptedWorkModelLogForTest(): void {
  refusalLogged = false;
}

/** Cheap first check, before anything reads the account: is the switch on at all? */
export function scriptedWorkModelSwitchedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") {
    if (!refusalLogged && VARIABLES.some((name) => (env[name] ?? "").trim() !== "")) {
      refusalLogged = true;
      console.warn("[work] work.scripted_model_refused: scripted Work model variables are set in production and are ignored.");
    }
    return false;
  }
  return env.JUNO_ALLOW_SCRIPTED_WORK === "1" && (env.WORK_SCRIPTED_MODEL_FILE ?? "").trim() !== "";
}

function listed(user: { id: string; email?: string | null }, env: NodeJS.ProcessEnv): boolean {
  const entries = (env.WORK_SCRIPTED_MODEL_USERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const email = user.email?.trim().toLowerCase() ?? null;
  return entries.some((entry) => (entry.includes("@") ? email !== null && entry.toLowerCase() === email : entry === user.id));
}

/**
 * The script to drive this account's Work runs with, or null (the normal
 * case, and always in production). `vision` is the script's own claim, which
 * decides whether pixel tools are offered.
 */
export function scriptedWorkModelFor(
  user: { id: string; email?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): { scriptPath: string; vision: boolean } | null {
  if (!scriptedWorkModelSwitchedOn(env)) return null;
  if (!listed(user, env)) return null;
  const scriptPath = (env.WORK_SCRIPTED_MODEL_FILE ?? "").trim();
  try {
    const parsed = JSON.parse(readFileSync(scriptPath, "utf8")) as { vision?: unknown };
    return { scriptPath, vision: parsed?.vision === true };
  } catch {
    return null;
  }
}
