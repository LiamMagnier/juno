// The QA runner's safety rules, in one place (spec §14, P0 (2)).
//
// Every e2e run, server and seed goes through scripts/qa/run-prod-e2e.sh, and
// that script, ensure-test-db.mjs, serve-prod.mjs and playwright.config.ts all
// read these rules from here, so there is exactly one definition of "safe":
//
// - DATABASE_URL and DIRECT_URL are both
//   postgresql://postgres@127.0.0.1:55439/<name>, with <name> ending in _test.
//   Nothing else: no password, no other host, no other port, no query string
//   that could redirect libpq (`?host=` would), and both name one database.
// - No .env, .env.local, .env.production or .env.production.local in the
//   working directory. Next and Prisma load those files on their own, so one
//   left in a checkout could hand a production URL to `next start` behind the
//   runner's back.
// - E2E_BASE_URL, when set, is http(s) on 127.0.0.1 or localhost.
// - Children get an allowlisted environment only. Nothing else from the
//   parent environment passes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const QA_DB_HOST = "127.0.0.1";
export const QA_DB_PORT = "55439";
export const QA_DB_USER = "postgres";
/** The maintenance database CREATE and DROP run from. Never migrated, never seeded. */
export const QA_MAINTENANCE_URL = `postgresql://${QA_DB_USER}@${QA_DB_HOST}:${QA_DB_PORT}/postgres`;

/** Files Next.js and Prisma read by themselves; any one of them makes the runner refuse. */
export const FORBIDDEN_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
/** Prisma also reads prisma/.env next to the schema. Refused for the same reason. */
export const FORBIDDEN_ROOT_ONLY_FILES = ["prisma/.env"];

/** Inherited from the parent, when set. Everything else is set by the runner. */
export const INHERITED_KEYS = ["PATH", "HOME", "TMPDIR", "CI"];

/**
 * Variables the runner itself sets for its children. They carry run
 * mechanics (where to write reports, which port), never credentials, and they
 * are never copied from the parent environment: the runner writes each one.
 */
export const RUNNER_CONTROL_KEYS = [
  "ALEVR_QA_RUNNER",
  "ALEVR_QA_RUN_DIR",
  "ALEVR_QA_REPORT_DIR",
  "ALEVR_QA_PACKAGE",
  "ALEVR_QA_CHROMIUM_CHANNEL",
  "ALEVR_QA_REUSE_BUILD",
  "ALEVR_QA_UPDATE_BASELINES",
  "E2E_PORT",
  "E2E_BASE_URL",
];

/** Keys scripts/qa/test.env may never set: the runner owns them. */
export const RESERVED_TEST_ENV_KEYS = new Set([
  ...INHERITED_KEYS,
  ...RUNNER_CONTROL_KEYS,
  "NODE_ENV",
  "PORT",
  "DATABASE_URL",
  "DIRECT_URL",
  "JUNO_E2E_SMOKE_PROVIDER",
  "NODE_OPTIONS",
]);

const DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const LOCAL_BASE_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Parses one QA database URL. Returns the database name, or why it is refused.
 * @param {string | undefined} raw
 * @param {string} label the variable name, for messages
 * @returns {{ ok: true, database: string } | { ok: false, reason: string }}
 */
export function parseQaDatabaseUrl(raw, label = "DATABASE_URL") {
  const expected = `postgresql://${QA_DB_USER}@${QA_DB_HOST}:${QA_DB_PORT}/<name>_test`;
  if (!raw || !raw.trim()) return { ok: false, reason: `${label} is not set. Expected ${expected}.` };
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `${label} is not a URL. Expected ${expected}.` };
  }
  if (url.protocol !== "postgresql:") {
    return { ok: false, reason: `${label} must use postgresql://, not ${url.protocol}//.` };
  }
  if (url.hostname !== QA_DB_HOST) {
    return { ok: false, reason: `${label} points at host "${url.hostname}". Only ${QA_DB_HOST} is allowed.` };
  }
  if (url.port !== QA_DB_PORT) {
    return { ok: false, reason: `${label} uses port ${url.port || "(default)"}. Only ${QA_DB_PORT} is allowed.` };
  }
  if (decodeURIComponent(url.username) !== QA_DB_USER) {
    return { ok: false, reason: `${label} connects as "${decodeURIComponent(url.username) || "(none)"}". Only ${QA_DB_USER} is allowed.` };
  }
  if (url.password) {
    return { ok: false, reason: `${label} carries a password. The disposable database uses trust auth and needs none.` };
  }
  if (url.hash) return { ok: false, reason: `${label} has a #fragment.` };
  for (const [key, value] of url.searchParams) {
    // `host`, `hostaddr`, `port` or `service` in the query would send libpq
    // somewhere other than the authority above. Only a schema is accepted.
    if (key !== "schema" || !SCHEMA_NAME.test(value)) {
      return { ok: false, reason: `${label} has the query parameter "${key}". Only ?schema=<name> is allowed.` };
    }
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return { ok: false, reason: `${label} must name exactly one database.` };
  }
  let database;
  try {
    database = decodeURIComponent(segments[0]);
  } catch {
    return { ok: false, reason: `${label} has a malformed database name.` };
  }
  if (!DATABASE_NAME.test(database)) {
    return {
      ok: false,
      reason: `${label} names the database "${database}". QA databases must match ${DATABASE_NAME} (lower case, ending in _test).`,
    };
  }
  return { ok: true, database };
}

/**
 * @param {string | undefined} raw
 * @returns {string | null} why it is refused, or null when unset or local
 */
export function checkBaseUrl(raw) {
  if (raw === undefined || raw === "") return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `E2E_BASE_URL is not a URL: "${raw}".`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `E2E_BASE_URL must be http or https, not ${url.protocol}.`;
  }
  if (url.username || url.password) return "E2E_BASE_URL must not carry credentials.";
  if (!LOCAL_BASE_HOSTS.has(url.hostname)) {
    return `E2E_BASE_URL points at "${url.hostname}". Only 127.0.0.1 or localhost is allowed.`;
  }
  return null;
}

/**
 * @param {string[]} dirs directories to look in (the repo root, the caller's cwd)
 * @param {string} root the repo root, for the root-only files
 * @returns {string[]} the env files that exist
 */
export function findForbiddenEnvFiles(dirs, root) {
  const found = new Set();
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    for (const name of FORBIDDEN_ENV_FILES) {
      const file = path.join(dir, name);
      if (existsSync(file)) found.add(file);
    }
  }
  if (root) {
    for (const name of FORBIDDEN_ROOT_ONLY_FILES) {
      const file = path.join(root, name);
      if (existsSync(file)) found.add(file);
    }
  }
  return [...found];
}

/**
 * Every refusal rule at once, so a caller sees all problems in one run.
 * @param {{ env: Record<string, string | undefined>, dirs: string[], root?: string }} input
 * @returns {{ ok: boolean, errors: string[], database: string | null }}
 */
export function checkSafeEnv({ env, dirs, root }) {
  const errors = [];
  const primary = parseQaDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
  const direct = parseQaDatabaseUrl(env.DIRECT_URL, "DIRECT_URL");
  if (!primary.ok) errors.push(primary.reason);
  if (!direct.ok) errors.push(direct.reason);
  if (primary.ok && direct.ok && primary.database !== direct.database) {
    errors.push(
      `DATABASE_URL (${primary.database}) and DIRECT_URL (${direct.database}) name different databases. Migrations and the app must use the same one.`
    );
  }
  const base = checkBaseUrl(env.E2E_BASE_URL);
  if (base) errors.push(base);
  for (const file of findForbiddenEnvFiles(dirs, root)) {
    errors.push(`${file} exists. Next.js and Prisma would load it behind the runner's back; move it out of the way first.`);
  }
  return { ok: errors.length === 0, errors, database: primary.ok ? primary.database : null };
}

/**
 * Parses scripts/qa/test.env: KEY=VALUE lines, # comments, optional quotes.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseTestEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new Error(`test.env line ${index + 1} is not KEY=VALUE: "${trimmed}"`);
    const [, key, rawValue] = match;
    if (RESERVED_TEST_ENV_KEYS.has(key)) {
      throw new Error(`test.env may not set ${key}: the runner owns it.`);
    }
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

/** @param {string} root */
export function readTestEnv(root) {
  return parseTestEnv(readFileSync(path.join(root, "scripts", "qa", "test.env"), "utf8"));
}

/**
 * The exact environment a QA child process receives.
 * @param {{
 *   env: Record<string, string | undefined>,
 *   testEnv: Record<string, string>,
 *   port?: string | number,
 *   control?: Record<string, string | undefined>,
 * }} input
 * @returns {Record<string, string>}
 */
export function buildChildEnv({ env, testEnv, port, control = {} }) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of INHERITED_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  Object.assign(out, testEnv);
  out.NODE_ENV = "production";
  if (port !== undefined && port !== "") out.PORT = String(port);
  out.DATABASE_URL = String(env.DATABASE_URL);
  out.DIRECT_URL = String(env.DIRECT_URL);
  out.JUNO_E2E_SMOKE_PROVIDER = "1";
  for (const key of RUNNER_CONTROL_KEYS) {
    const value = control[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** Every key a QA child may see, given a test.env. */
export function allowedChildKeys(testEnv) {
  return new Set([
    ...INHERITED_KEYS,
    ...Object.keys(testEnv),
    ...RUNNER_CONTROL_KEYS,
    "NODE_ENV",
    "PORT",
    "DATABASE_URL",
    "DIRECT_URL",
    "JUNO_E2E_SMOKE_PROVIDER",
  ]);
}

/**
 * Re-filters an environment that is supposed to be allowlisted already. Used
 * by serve-prod.mjs and playwright.config.ts as a second line: Playwright
 * spreads `process.env` into the web server's environment whatever the config
 * says, so the server re-applies the allowlist itself.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} testEnv
 */
export function filterToAllowlist(env, testEnv) {
  const allowed = allowedChildKeys(testEnv);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}
