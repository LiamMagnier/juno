import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CLOUD_PERMISSION_MODE,
  isAllowedEnvVarName,
  parseEnvVars,
  SETUP_SCRIPT_OUTPUT_LIMIT,
  SETUP_SCRIPT_TIMEOUT_MS,
} from "@/lib/code-environments";

/*
 * A CLOUD ENVIRONMENT, AND A PERMISSION MODE, FROM THE COLUMN TO THE CONTAINER.
 *
 * Both settings are worth exactly as much as the last file in their chain, and
 * the chain crosses two languages and five files: the schema, the create route,
 * runner-context, the driver, and the vendored container sandbox. Each link is
 * the kind that fails silently — a mode accepted and never passed to
 * `AgentSession.create` produces a run that behaves perfectly and ignores the
 * setting; a network level stored and never applied produces a container that
 * is still offline while the composer says otherwise. Neither shows up in a
 * stack trace, and a behavioural test would need Docker, a dispatch and a
 * GitHub App, which is exactly why nothing tested the hardcoded `mode: "full"`
 * that sat in the driver for the life of Cloud Code.
 *
 * So the seams are read as text, in the style of tests/code-continuity.test.ts
 * and tests/cloud-runner-containment.test.ts. The pure rules are exercised
 * directly in tests/code-environments.test.ts.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260917120000_code_environments/migration.sql");
const createRoute = read("src/app/api/code/tasks/route.ts");
const runnerContext = read("src/app/api/code/tasks/[id]/runner-context/route.ts");
const environmentsRoute = read("src/app/api/code/environments/route.ts");
const environmentRoute = read("src/app/api/code/environments/[id]/route.ts");
const serializer = read("src/lib/code-remote.ts");
const driver = read("scripts/cloud-code-runner.mjs");
const sandbox = read("runner/agent-core/src/tools/container-sandbox.ts");
const workflow = read(".github/workflows/code-runner.yml");

// ---------------------------------------------------------------------------
// The columns, and the migration that adds them
// ---------------------------------------------------------------------------

test("the schema carries the environment and the mode, added by the migration", () => {
  const task = /model CodeTask \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  assert.match(task, /^\s+environmentId\s+String\?/m);
  assert.match(task, /^\s+permissionMode\s+String\?/m);
  assert.match(migration, /ALTER TABLE "CodeTask" ADD COLUMN "environmentId" TEXT;/);
  assert.match(migration, /ALTER TABLE "CodeTask" ADD COLUMN "permissionMode" TEXT;/);
  assert.match(schema, /model CodeEnvironment \{/);
  assert.match(migration, /CREATE TABLE "CodeEnvironment"/);
});

test("deleting an environment does not delete the runs that used it", () => {
  // The history of a run is the record of what the product did. Cascading from
  // a configuration row someone tidied up would take that with it.
  const task = /model CodeTask \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  assert.match(task, /environment\s+CodeEnvironment\?\s+@relation\([^)]*onDelete: SetNull/);
  assert.match(migration, /REFERENCES "CodeEnvironment"\("id"\) ON DELETE SET NULL/);
});

test("one default per user is the database's rule, not the route's", () => {
  // Prisma cannot express a filtered index, so it is hand-written — the same
  // reason CodeWorkspace's (userId, key) index is. Without it, a PATCH that
  // clears the old default and then fails leaves the user with two.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "CodeEnvironment_userId_default_key"[\s\S]*?ON "CodeEnvironment"\("userId"\) WHERE "isDefault";/,
  );
});

// ---------------------------------------------------------------------------
// The variables are secrets
// ---------------------------------------------------------------------------

test("the variables are sealed with the connector cipher on every write", () => {
  // The same keyring as the OAuth connector tokens (src/lib/crypto.ts), so a
  // database dump alone yields nothing usable and key rotation covers them.
  for (const [name, source] of [
    ["the create route", environmentsRoute],
    ["the patch route", environmentRoute],
  ] as const) {
    assert.match(source, /import \{ encryptSecret \} from "@\/lib\/crypto"/, `${name} does not seal`);
    const writes = source
      .split("\n")
      .filter((line) => /^\s*(data\.)?envVars[:=]/.test(line))
      .filter((line) => !line.includes("encryptSecret") && !line.includes("null"));
    assert.deepEqual(writes, [], `${name} writes envVars without sealing it`);
  }
});

test("nothing that answers a browser ever unseals them", () => {
  // runner-context is the ONE reader, and it refuses a browser session with 403
  // before it gets here — the same gate that protects the clone token.
  assert.match(runnerContext, /decryptSecret\(task\.environment\.envVars\)/);
  for (const [name, source] of [
    ["the environments list", environmentsRoute],
    ["the single environment", environmentRoute],
  ] as const) {
    assert.equal(source.includes("decryptSecret"), false, `${name} decrypts on a browser path`);
  }
  // And the names are what a browser is given instead, so a client can still
  // say what a run will carry.
  assert.match(environmentsRoute, /envVarNames: true/);
});

test("a key that was dropped refuses before the handoff is spent", () => {
  // runner-context is single-use: it stamps runnerClaimedAt and any later call
  // is 409. A throw AFTER that stamp would leave a task no retry could ever
  // bootstrap, so the unsealing happens before it.
  const unseal = runnerContext.indexOf("decryptSecret(task.environment.envVars)");
  const claim = runnerContext.indexOf("runnerClaimedAt: new Date()");
  assert.notEqual(unseal, -1);
  assert.notEqual(claim, -1);
  assert.ok(
    unseal < claim,
    "unsealing after the single-use claim strands the task when the key is gone",
  );
  assert.match(runnerContext, /environment_secrets_unreadable/);
});

test("the values are registered for redaction before anything can log them", () => {
  // The driver's log is this run's PUBLIC Actions log. A failing `npm ci` that
  // echoes its auth token must have the token replaced first.
  const register = driver.indexOf("for (const value of Object.values(environment.env)) SECRETS.add(value);");
  const setup = driver.indexOf("async function runSetupScript");
  assert.notEqual(register, -1, "the driver no longer registers the environment's values as secrets");
  assert.notEqual(setup, -1);
  // Registered inside main(), which runs before any of the phases that log.
  assert.ok(driver.slice(0, register).includes("const environment = readEnvironment(ctx.environment)"));
});

// ---------------------------------------------------------------------------
// Cloud only, and said so
// ---------------------------------------------------------------------------

test("a device task cannot be given a setting no device reads", () => {
  // The Mac runs its own approval gating from its own settings and reads
  // neither column. Accepting them for a device task would persist a
  // preference the thing executing it never sees — the exact defect of a
  // control that implies something the runtime cannot do.
  assert.match(createRoute, /if \(!isCloud && \(environmentId \|\| permissionMode\)\)/);
  assert.match(createRoute, /cloud_only_option/);
});

test("a stale environment id fails before anything is dispatched", () => {
  const lookup = /prisma\.codeEnvironment\.findFirst\(\{[\s\S]*?\}\);/.exec(createRoute)?.[0] ?? "";
  assert.ok(lookup.includes("userId: user.id"), "the environment lookup is not scoped to the owner");
  assert.match(createRoute, /environment_not_found/);
  assert.ok(
    createRoute.indexOf("environment_not_found") < createRoute.indexOf("await dispatchCloudRunner({"),
    "the environment is validated after the runner is started",
  );
});

test("both columns are persisted as chosen, not as resolved", () => {
  assert.match(createRoute, /environmentId: inheritedEnvironmentId,/);
  assert.match(createRoute, /permissionMode: inheritedPermissionMode,/);
});

test("a follow-up keeps the environment the first message chose", () => {
  // Continuity already clones the branch the first run pushed. Dropping the
  // environment would then work that tree with no network, none of the
  // variables and none of the setup step that installed its dependencies —
  // the user changed nothing and the second message behaves differently.
  const lookup = /const last = await tx\.codeTask\.findFirst\(\{[\s\S]*?\}\);/.exec(createRoute)?.[0] ?? "";
  assert.ok(lookup, "the create route no longer inherits the conversation's environment");
  for (const clause of ["userId: user.id", "conversationId", 'target: "cloud"']) {
    assert.ok(lookup.includes(clause), `the inheritance lookup must filter on ${clause}`);
  }
  // A value the client sent always wins, which is how a mid-conversation
  // change of mode reaches the run.
  assert.match(
    createRoute,
    /if \(inheritEnvironment\) inheritedEnvironmentId = last\?\.environmentId \?\? null;/,
  );
  // And a mode written by a deploy that offered a value this one no longer
  // does is checked rather than carried forward forever.
  assert.match(
    createRoute,
    /isCodePermissionMode\(last\?\.permissionMode\)\s*\?\s*last\.permissionMode\s*:\s*null/,
  );
});

test("a client can read back what a run was dispatched with", () => {
  assert.match(serializer, /environmentId: task\.environmentId,/);
  assert.match(serializer, /permissionMode: task\.permissionMode,/);
  // But never the values — those have exactly one reader.
  assert.equal(serializer.includes("envVars"), false);
});

// ---------------------------------------------------------------------------
// runner-context resolves, the driver acts
// ---------------------------------------------------------------------------

test("runner-context resolves the mode server-side and defaults it to full", () => {
  // One answer to "what did this run execute under", and it is the server's.
  assert.match(runnerContext, /permissionMode: isCodePermissionMode\(task\.permissionMode\)/);
  assert.match(runnerContext, /: DEFAULT_CLOUD_PERMISSION_MODE,/);
  assert.equal(DEFAULT_CLOUD_PERMISSION_MODE, "full");
});

test("the driver passes the mode to the session instead of hardcoding one", () => {
  // `mode: "full"` sat here for the life of Cloud Code: the engine had four
  // modes and this one line meant none of them could ever be picked.
  assert.equal(driver.includes('mode: "full"'), false, "the driver still hardcodes the permission mode");
  assert.match(driver, /^\s+mode: permissionMode,$/m);
  assert.match(driver, /const permissionMode = CLOUD_PERMISSION_MODES\.has\(ctx\.permissionMode\)\s*\?\s*ctx\.permissionMode\s*:\s*"full";/);
});

test("a narrower mode refuses what it cannot ask about", () => {
  /*
   * The half that is easy to leave out, and worth the most. The engine routes
   * everything it cannot decide to `requestApproval`, so a callback that always
   * allowed made `auto-edit` byte-identical to `full` — a run that edits files
   * AND executes every command, under a control that said it would only do the
   * first.
   */
  const callback = /requestApproval: async \(request\) => \{[\s\S]*?\n {6}\},/.exec(driver)?.[0] ?? "";
  assert.ok(callback, "the driver no longer answers approvals");
  assert.match(callback, /const allowed = permissionMode === "full";/);
  assert.match(callback, /return allowed \? "allow" : "deny";/);
  // And the refusal says which setting refused, on a row the transcript
  // already renders as failed (`^Denied ` in code-activity.tsx).
  assert.match(callback, /`Denied — this run is set to \$\{PERMISSION_MODE_LABELS\[permissionMode\]\}/);
  assert.match(read("src/components/code/code-activity.tsx"), /\/\^Denied \//);
});

test("the environment's egress overrides the workflow's default", () => {
  // JUNO_RUNNER_SANDBOX_NETWORK is pinned to `none` in the workflow. If that
  // were a ceiling rather than a default, the network control would never do
  // anything — and the workflow says so in a comment so the next reader does
  // not "fix" it back.
  assert.match(driver, /environment\.network === "full"[\s\S]{0,120}?\{ network: "full" \}/);
  assert.match(workflow, /The DEFAULT egress for the agent's container, not a ceiling over it/);
});

test("the sandbox is still read before the driver's environment is stripped", () => {
  // Restated here because this change rewrites the lines around that ordering.
  // hardenDriverEnv() deletes JUNO_RUNNER_SANDBOX_IMAGE; reading after it
  // yields null and every agent command escapes the container.
  // tests/cloud-runner-containment.test.ts owns the full argument.
  assert.ok(
    driver.indexOf("containerSandboxFromEnv(process.env") < driver.indexOf("hardenDriverEnv();"),
  );
});

test("variables reach the container by name, never as a value in an argv", () => {
  // `docker run --env NAME` with no `=` copies the value from docker's own
  // process environment — which is `agentEnv`, the scrubbed map the driver
  // already builds. So a variable has to be in both lists to arrive, and no
  // secret is ever readable from the host's process list.
  // One filtered map feeds both lists, so the container can never be told to
  // forward a variable the agent's shells were not given — a disagreement with
  // no symptom, since the run would simply behave as if it was never set.
  assert.match(driver, /const carried = carriedEnvVars\(environment\.env\);/);
  assert.match(driver, /forwardEnv: carriedNames/);
  assert.match(driver, /const agentEnv = buildAgentEnv\(carried\);/);
  assert.match(sandbox, /args\.push\("--env", name\)/);
  // A bulk forward is the thing that would hand over the task token; the file
  // may discuss it in prose, and must not emit it.
  assert.equal(/args\.push\([^)]*--env-file/.test(sandbox), false);
  assert.equal(/args\.push\([^)]*--env=/.test(sandbox), false);
});

test("a forwarded name can never shadow one the runner depends on", () => {
  // The route refuses PATH and its neighbours. This is the second lock on the
  // same door, because the failure it prevents — a stored variable deciding
  // which binary `npm` is, for a process holding the task token — is not one
  // worth a single check.
  const carry = /function carriedEnvVars\(vars\) \{[\s\S]*?\n\}/.exec(driver)?.[0] ?? "";
  assert.ok(carry, "carriedEnvVars is no longer declared as a function statement");
  assert.match(carry, /if \(AGENT_ENV_ALLOW\.includes\(name\)\) continue;/);
  const build = /function buildAgentEnv\(extra = \{\}\) \{[\s\S]*?\n\}/.exec(driver)?.[0] ?? "";
  assert.ok(build, "buildAgentEnv is no longer declared as a function statement");
  assert.match(build, /if \(name in env\) continue;/);
});

test("every name the driver drops is a name the route refuses", () => {
  /*
   * THE LOCK THE PREVIOUS TEST COULD NOT SEE.
   *
   * `carriedEnvVars` drops every name in AGENT_ENV_ALLOW, and the test above
   * pins that line as text — so it passes whether or not the route agrees. It
   * did not agree: LANG, LC_ALL, LC_CTYPE, TZ, TERM and TMPDIR were accepted by
   * POST /api/code/environments with a 201, listed back in `envVarNames` as
   * something the run would carry, and then discarded by the driver with
   * nothing logged and nothing in the transcript. The submitter's only evidence
   * was a run that behaved as if they had never typed the variable.
   *
   * So the two lists are compared directly, from the driver's own source. A
   * name added to AGENT_ENV_ALLOW without being reserved fails here, at the
   * seam, instead of silently at run time.
   */
  const block = /const AGENT_ENV_ALLOW = \[([\s\S]*?)\];/.exec(driver)?.[1];
  assert.ok(block, "AGENT_ENV_ALLOW is no longer a literal array in the driver");
  const names = [...block.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `AGENT_ENV_ALLOW parsed as only ${names.length} name(s)`);
  for (const name of names) {
    assert.equal(
      isAllowedEnvVarName(name),
      false,
      `${name} is dropped by carriedEnvVars but accepted by the environments route: a run would silently ignore it`,
    );
  }
});

test("a submitted locale or terminal variable is refused with a reason", () => {
  // The visible half of the fix above: the rejection reaches the person who
  // typed it, as a 400 naming the variable, rather than a 201 followed by a run
  // that ignores it.
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"]) {
    const parsed = parseEnvVars({ [name]: "x" });
    assert.equal(parsed.ok, false, `${name} was accepted`);
    if (!parsed.ok) {
      assert.equal(parsed.rejection.reason, "reserved_name");
      assert.equal((parsed.rejection as { name: string }).name, name);
    }
  }
  // JUNO_HOME is the twelfth name, and it is covered by the prefix rule rather
  // than by the list — asserted here so a later tidy-up of the prefixes cannot
  // quietly reopen it.
  const juno = parseEnvVars({ JUNO_HOME: "/tmp" });
  assert.equal(juno.ok, false);
});

test("a denied tool produces one transcript row, and it is the honest one", () => {
  /*
   * The engine follows a `deny` from the approval callback with its own
   * `tool_denied` whose reason is "The user declined this action."
   * (runner/agent-core/src/agent.ts). No user is attached to a cloud run, so
   * that sentence is the same invented human the callback's comment says it
   * removed from the allow path — arriving as a second row right after the one
   * that names the mode. The driver's row is the only one that survives.
   */
  assert.match(driver, /if \(!allowed\) sink\.denialsAnswered \+= 1;/);
  const denied = /case "tool_denied":[\s\S]*?\n    case /.exec(driver)?.[0] ?? "";
  assert.ok(denied, "onAgentEvent no longer handles tool_denied");
  assert.match(denied, /if \(sink\.denialsAnswered > 0\) \{[\s\S]*?break;/);
  // Plan mode and project rules deny without ever reaching the callback, so
  // their rows must still be pushed.
  assert.match(denied, /sink\.push\("tool", \{/);
});

test("a chatty setup script is not killed for being chatty", () => {
  /*
   * execFile's `maxBuffer` KILLS the child on overflow and reports it exactly
   * as it reports a timeout, so a setup script that succeeded but printed more
   * than the buffer failed the whole task with "exited 124" and no true reason.
   * Output is bounded in JS now, and the process keeps its own exit status.
   */
  const fn = /function runSetupScriptProcess\(script, \{ cwd, env \}\) \{[\s\S]*?\n\}\n/.exec(driver)?.[0] ?? "";
  assert.ok(fn, "runSetupScriptProcess is no longer declared as a function statement");
  assert.equal(/maxBuffer/.test(fn), false, "the output cap must not be able to kill the script");
  assert.match(fn, /output = output\.slice\(-keep\)/);
  assert.match(fn, /slice\(-SETUP_SCRIPT_OUTPUT_LIMIT\)/);
  // The timeout still kills, and kills the whole group: a script that started a
  // background server used to leave it holding the runner for the rest of the
  // job, because execFile signals bash alone.
  assert.match(fn, /detached: true/);
  assert.match(fn, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(fn, /SETUP_SCRIPT_TIMEOUT_MS/);
  // And the two are distinguishable in what the run reports.
  assert.match(driver, /timedOut \? "timed out" : "failed"/);
  assert.match(driver, /ran longer than \$\{Math\.round\(SETUP_SCRIPT_TIMEOUT_MS \/ 60_000\)\} minutes/);
  assert.equal(/execFileAsync\("\/bin\/bash"/.test(driver), false);
});

test("choosing full egress cannot drop a run out of a filtered network", () => {
  // `full` lifts the workflow's `none`. On a deployment running the
  // capability-aware egress proxy, `proxied` is the filtered path and leaving
  // it is not what "full" was chosen to mean.
  assert.match(
    driver,
    /environment\.network === "full" && fromWorkflow\.network !== "proxied"/,
  );
});

test("an environment and a mode can be cleared, not only changed", () => {
  /*
   * A composer offering "No environment", or resetting to "Auto" after a Plan
   * run, has to be able to SAY so. With `.optional()` alone, absent meant
   * inherit and there was no other value — so the picker would show one setting
   * while the next message quietly ran with the previous one.
   */
  assert.match(createRoute, /environmentId: z\.string\(\)[\s\S]{0,60}?\.nullable\(\)\.optional\(\)/);
  assert.match(createRoute, /permissionMode: z\.enum\(CODE_PERMISSION_MODES\)\.nullable\(\)\.optional\(\)/);
  // Only ABSENT inherits; null is an answer.
  assert.match(createRoute, /const inheritEnvironment = environmentId === undefined;/);
  assert.match(createRoute, /const inheritPermissionMode = permissionMode === undefined;/);
  assert.match(createRoute, /if \(inheritEnvironment\) inheritedEnvironmentId = last\?\.environmentId \?\? null;/);
});

// ---------------------------------------------------------------------------
// The setup step
// ---------------------------------------------------------------------------

test("the setup script runs after the credentials are gone and before the agent", () => {
  /*
   * Ordering is the whole safety argument. removeAskpass() first, so no git
   * credential is on disk while user-authored shell executes; hardenDriverEnv()
   * next, so reading this process's /proc/environ yields nothing; and then the
   * script, before AgentSession.create, because a tree whose `npm ci` has not
   * finished makes every later failure point at the code instead of at setup.
   */
  const askpass = driver.lastIndexOf("removeAskpass();\n\n  // 4.");
  const harden = driver.indexOf("hardenDriverEnv();");
  const setup = driver.indexOf("await runSetupScript(environment.setupScript");
  const session = driver.indexOf("const session = AgentSession.create({");
  assert.notEqual(askpass, -1, "the askpass teardown before the agent phase has moved");
  assert.notEqual(setup, -1, "the driver no longer runs the environment's setup script");
  assert.ok(askpass < harden, "the setup step must not run while the clone token is on disk");
  assert.ok(harden < setup, "the setup step must not run before the driver's env is stripped");
  assert.ok(setup < session, "the setup step must finish before the agent starts");
});

test("it runs on the host, which is the only place with a network", () => {
  // The container has no egress by default, and container-sandbox.ts's own
  // header says dependencies should be fetched by the driver outside it —
  // which is exactly what a setup script is.
  assert.match(driver, /spawn\("\/bin\/bash", \["-c", script\], \{\s*cwd,\s*env,/);
  assert.match(sandbox, /fetched by the driver, outside the/);
});

test("a failed setup script fails the run, with its output already flushed", () => {
  // Starting the agent anyway hands the model a broken tree. And the fatal
  // handler posts its terminal `failed` with its own fetch, bypassing the
  // sink — so a row left buffered is a row nobody ever sees, and it is the one
  // holding the reason.
  const fn = /async function runSetupScript\([\s\S]*?\n\}/.exec(driver)?.[0] ?? "";
  assert.ok(fn, "runSetupScript is no longer declared as a function statement");
  assert.ok(fn.indexOf("await sink.flushing;") < fn.indexOf("if (exitCode !== 0) {"));
  assert.match(fn, /The environment's setup script exited \$\{exitCode\}/);
  // The tail of the output, not the head: a build log's last lines are the
  // reason it stopped.
  assert.match(driver, /\.slice\(-SETUP_SCRIPT_OUTPUT_LIMIT\)/);
});

test("the driver and the server agree on the setup script's bounds", () => {
  // Two languages, two files, one pair of numbers. They drift silently: the
  // server would accept a script the driver kills, or truncate differently
  // from what the transcript says it kept.
  const value = (name: string): number => {
    const expression = new RegExp(`const ${name} = ([^;]+);`).exec(driver)?.[1];
    assert.ok(expression, `${name} is no longer a const in the driver`);
    // Evaluated rather than string-compared so `10 * 60_000` and `600000` are
    // the same answer, which is what the two files actually have to agree on.
    return (new Function(`return ${expression};`) as () => number)();
  };
  assert.equal(value("SETUP_SCRIPT_TIMEOUT_MS"), SETUP_SCRIPT_TIMEOUT_MS);
  assert.equal(value("SETUP_SCRIPT_OUTPUT_LIMIT"), SETUP_SCRIPT_OUTPUT_LIMIT);
});
