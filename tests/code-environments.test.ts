import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_NETWORK_ACCESS,
  CODE_PERMISSION_MODES,
  DEFAULT_CLOUD_PERMISSION_MODE,
  MAX_ENV_VARS,
  MAX_ENV_VAR_VALUE_LENGTH,
  MAX_ENV_VARS_TOTAL_BYTES,
  createEnvironmentSchema,
  describeEnvVarRejection,
  isAllowedEnvVarName,
  isCodeNetworkAccess,
  isCodePermissionMode,
  parseEnvVars,
  patchEnvironmentSchema,
  readStoredEnvVars,
  serializeCodeEnvironment,
} from "@/lib/code-environments";

/*
 * The rules a cloud environment is held to, exercised without a database.
 *
 * Everything here decides one of two things, and both of them are invisible
 * when they go wrong. The first is whether a stored variable is a variable or a
 * way to change how a process starts — the driver hands this map to its own
 * children, so `LD_PRELOAD` accepted here is a library loaded into a process
 * that holds the task token. The second is whether a value can leave the
 * server: the values are sealed with the connector keyring and the only reader
 * is the runner, so a serialiser that ever emitted one would be a silent
 * regression in a response that still looked correct.
 *
 * The cross-file half — that the route seals what this validates, and that the
 * driver reads what runner-context returns — lives in
 * tests/code-environment-runtime.test.ts.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("a name that changes how a process starts is refused", () => {
  // Not a list of "sensitive" names — a list of names whose VALUES are read by
  // the loader or the shell before the command anyone wrote runs.
  for (const name of [
    "PATH",
    "HOME",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "BASH_ENV",
    "IFS",
    "NODE_OPTIONS",
    "SHELLOPTS",
  ]) {
    assert.equal(isAllowedEnvVarName(name), false, `${name} must not be settable`);
  }
});

test("the namespaces the runner reasons about are reserved", () => {
  // hardenDriverEnv() strips JUNO_*/ACTIONS_*, and AGENT_ENV_ALLOW decides
  // about them. A user-settable variable in one of those would be read by that
  // code as something the runner itself had set.
  for (const name of ["JUNO_HOME", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN"]) {
    assert.equal(isAllowedEnvVarName(name), false, `${name} must not be settable`);
  }
  assert.equal(isAllowedEnvVarName("NPM_TOKEN"), true);
  assert.equal(isAllowedEnvVarName("DATABASE_URL"), true);
});

test("only a POSIX variable name is a name", () => {
  assert.equal(isAllowedEnvVarName("1LEADING_DIGIT"), false);
  assert.equal(isAllowedEnvVarName("has space"), false);
  assert.equal(isAllowedEnvVarName("EQUALS=SIGN"), false);
  assert.equal(isAllowedEnvVarName("_ok"), true);
});

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

test("a valid map comes back in a stable key order", () => {
  // The map is sealed as ONE ciphertext. Without an order, re-saving an
  // unchanged environment produces different bytes and `updatedAt` stops
  // meaning "someone changed this".
  const first = parseEnvVars({ ZED: "1", ALPHA: "2", MIDDLE: "3" });
  const second = parseEnvVars({ MIDDLE: "3", ALPHA: "2", ZED: "1" });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  assert.deepEqual(first.names, ["ALPHA", "MIDDLE", "ZED"]);
  assert.equal(JSON.stringify(first.vars), JSON.stringify(second.vars));
});

test("a reserved name is refused rather than dropped", () => {
  // Dropping it would store an environment that is not the one the user
  // submitted, and say nothing about the difference.
  const parsed = parseEnvVars({ NPM_TOKEN: "t", PATH: "/evil/bin" });
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.rejection.reason, "reserved_name");
  assert.match(describeEnvVarRejection(parsed.rejection), /PATH/);
});

test("the caps are enforced on count, on one value, and on the whole map", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i <= MAX_ENV_VARS; i += 1) many[`VAR_${i}`] = "x";
  assert.equal(parseEnvVars(many).ok, false);

  const long = parseEnvVars({ BIG: "x".repeat(MAX_ENV_VAR_VALUE_LENGTH + 1) });
  assert.equal(long.ok, false);
  if (long.ok) throw new Error("unreachable");
  assert.equal(long.rejection.reason, "value_too_long");

  // Under both individual caps and still too large together.
  const fat: Record<string, string> = {};
  const perVar = MAX_ENV_VAR_VALUE_LENGTH;
  for (let i = 0; i < Math.ceil(MAX_ENV_VARS_TOTAL_BYTES / perVar) + 1; i += 1) {
    fat[`FAT_${i}`] = "x".repeat(perVar);
  }
  const parsedFat = parseEnvVars(fat);
  assert.equal(parsedFat.ok, false);
  if (parsedFat.ok) throw new Error("unreachable");
  assert.equal(parsedFat.rejection.reason, "too_large");
});

test("every rejection has a sentence a person can act on", () => {
  // A 400 whose body says "Invalid input" for a list of thirty variables tells
  // the user to check all thirty.
  for (const rejection of [
    { reason: "invalid_name", name: "1BAD" },
    { reason: "reserved_name", name: "PATH" },
    { reason: "duplicate_name", name: "TOKEN" },
    { reason: "value_too_long", name: "BIG" },
    { reason: "too_many" },
    { reason: "too_large" },
  ] as const) {
    const sentence = describeEnvVarRejection(rejection);
    assert.ok(sentence.length > 10, `${rejection.reason} has no sentence`);
    assert.match(sentence, /\.$/, `${rejection.reason} does not end in a full stop`);
  }
});

test("a stored map is re-validated on the way out, and a bad entry is skipped", () => {
  // The rules can tighten. A name that was acceptable when it was sealed must
  // not reach a shell just because it is already in the database — but one bad
  // entry must not strand the whole task either, which is why this drops rather
  // than throws.
  const read = readStoredEnvVars({
    NPM_TOKEN: "keep",
    LD_PRELOAD: "/evil.so",
    NOT_A_STRING: 5,
    TOO_LONG: "x".repeat(MAX_ENV_VAR_VALUE_LENGTH + 1),
  });
  assert.deepEqual(read, { NPM_TOKEN: "keep" });
});

test("a non-object payload reads as no variables at all", () => {
  // Whatever JSON.parse returned, the run proceeds with an empty map rather
  // than with `undefined` reaching a spawn.
  assert.deepEqual(readStoredEnvVars(null), {});
  assert.deepEqual(readStoredEnvVars("NPM_TOKEN=1"), {});
  assert.deepEqual(readStoredEnvVars([["NPM_TOKEN", "1"]]), {});
});

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

test("the network levels are the two the runner can actually enforce", () => {
  // `trusted` and `custom` mean an allowlist an egress proxy enforces, and no
  // deployment runs that proxy. Storing them would be a control that promises
  // filtering nobody performs — so they are absent, and this pins that.
  assert.deepEqual([...CODE_NETWORK_ACCESS], ["none", "full"]);
  assert.equal(isCodeNetworkAccess("trusted"), false);
  assert.equal(isCodeNetworkAccess("none"), true);
});

test("the permission modes are agent-core's, minus the one with nobody to ask", () => {
  assert.deepEqual([...CODE_PERMISSION_MODES], ["plan", "auto-edit", "full"]);
  assert.equal(isCodePermissionMode("ask"), false);
  assert.equal(isCodePermissionMode("full"), true);
});

test("no preference still means what the driver used to hardcode", () => {
  // Every cloud task created before the column exists has a NULL mode. A
  // default of anything but `full` would narrow what they may do, months after
  // they were submitted.
  assert.equal(DEFAULT_CLOUD_PERMISSION_MODE, "full");
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

test("a patch must ask for something", () => {
  assert.equal(patchEnvironmentSchema.safeParse({}).success, false);
  assert.equal(patchEnvironmentSchema.safeParse({ name: "CI" }).success, true);
});

test("clearing the setup script and leaving it alone are different edits", () => {
  // `null` clears, an absent key does not. Collapsing the two would make every
  // rename silently delete the setup step.
  const cleared = patchEnvironmentSchema.safeParse({ setupScript: null });
  assert.equal(cleared.success, true);
  if (!cleared.success) throw new Error("unreachable");
  assert.equal(cleared.data.setupScript, null);
  assert.equal("setupScript" in patchEnvironmentSchema.parse({ name: "CI" }), false);
});

test("an unknown network level never reaches the column", () => {
  assert.equal(createEnvironmentSchema.safeParse({ name: "CI", network: "trusted" }).success, false);
  assert.equal(createEnvironmentSchema.safeParse({ name: "CI", network: "full" }).success, true);
});

test("a default can be set by a patch and never unset by one", () => {
  // The partial unique index allows at most one default per user; there is no
  // edit that leaves an account with none selected after it had one, because a
  // composer cannot draw "no environment is preselected, but one was".
  assert.equal(patchEnvironmentSchema.safeParse({ isDefault: true }).success, true);
  assert.equal(patchEnvironmentSchema.safeParse({ isDefault: false }).success, false);
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const ROW = {
  id: "env_1",
  name: "CI",
  network: "full",
  envVarNames: ["NPM_TOKEN"],
  setupScript: "npm ci",
  isDefault: true,
  createdAt: new Date("2026-09-17T09:00:00Z"),
  updatedAt: new Date("2026-09-17T10:00:00Z"),
};

test("a serialised environment never carries a variable value", () => {
  // The values are sealed with the connector keyring and there is no read path
  // back to a browser for them — not on the list, not on the detail, not for
  // the person who typed them. This asserts the shape rather than the absence
  // of one key, so a future field cannot smuggle them back in.
  for (const opts of [{}, { includeSetupScript: true }]) {
    const json = JSON.stringify(serializeCodeEnvironment(ROW, opts));
    assert.equal(json.includes("envVars"), false, "the sealed column must not be serialised");
    assert.deepEqual(Object.keys(JSON.parse(json)).sort(), [
      ...["createdAt", "envVarNames", "hasSetupScript", "id", "isDefault", "name", "network"],
      ...("includeSetupScript" in opts ? ["setupScript"] : []),
      "updatedAt",
    ].sort());
  }
});

test("the setup script is off the list and on the detail", () => {
  // A composer drawing a chip per environment would otherwise pull 25 scripts
  // down to render 25 names.
  assert.equal("setupScript" in serializeCodeEnvironment(ROW), false);
  assert.equal(serializeCodeEnvironment(ROW).hasSetupScript, true);
  assert.equal(serializeCodeEnvironment(ROW, { includeSetupScript: true }).setupScript, "npm ci");
});

test("a network value the column should not hold reads as the safe one", () => {
  // A row written by a future deploy, or by hand, must not open egress on a
  // reader that does not understand it.
  const serialized = serializeCodeEnvironment({ ...ROW, network: "trusted" });
  assert.equal(serialized.network, "none");
});
