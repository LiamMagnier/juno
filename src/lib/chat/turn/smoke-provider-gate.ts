/**
 * When the chat route may answer with the deterministic smoke provider
 * (`streamDeterministicSmokeResponse`) instead of a real model.
 *
 * The smoke provider exists so the browser journey (sign in, stream, Stop,
 * regenerate, artifacts) can prove the real route, persistence and SSE path
 * without a provider key or quota. It must never become a production
 * fallback. Until 2026-10-25 that was guaranteed by refusing it whenever
 * `NODE_ENV === "production"` — which also refused it on the one production
 * build that needs it: the QA runner's (`scripts/qa/run-prod-e2e.sh`), which
 * only ever runs `next build` + `next start` and therefore could not run any
 * journey that streams (ledger P1-5).
 *
 * A production process now gets it only when all of these hold at once:
 *
 *   - JUNO_E2E_SMOKE_PROVIDER=1 (the runner sets it; nothing else does);
 *   - ALEVR_QA_RUNNER=1 (likewise);
 *   - DATABASE_URL, and DIRECT_URL when set, are the runner's disposable
 *     database: postgresql://postgres@127.0.0.1:55439/<name>_test with no
 *     password and no query but ?schema=. These are the same rules
 *     scripts/qa/lib/safe-env.mjs refuses everything else by, and a deployed
 *     server cannot meet them: it has a password, and its database is not a
 *     `_test` one on port 55439.
 *
 * Outside production (dev, tests) the explicit opt-in alone still suffices.
 */

export interface SmokeProviderEnv {
  readonly JUNO_E2E_SMOKE_PROVIDER?: string;
  readonly NODE_ENV?: string;
  readonly ALEVR_QA_RUNNER?: string;
  readonly DATABASE_URL?: string;
  readonly DIRECT_URL?: string;
}

const QA_DB_HOST = "127.0.0.1";
const QA_DB_PORT = "55439";
const QA_DB_USER = "postgres";
const QA_DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/;
const QA_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Whether `raw` is the QA runner's disposable database URL. Mirrors
 * `parseQaDatabaseUrl` in scripts/qa/lib/safe-env.mjs (a test holds the two to
 * the same verdicts), kept here so the app bundle never imports the harness.
 */
export function isQaRunnerDatabaseUrl(raw: string | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "postgresql:") return false;
  if (url.hostname !== QA_DB_HOST || url.port !== QA_DB_PORT) return false;
  if (decodeURIComponent(url.username) !== QA_DB_USER || url.password) return false;
  if (url.hash) return false;
  for (const [key, value] of url.searchParams) {
    if (key !== "schema" || !QA_SCHEMA_NAME.test(value)) return false;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return false;
  let database: string;
  try {
    database = decodeURIComponent(segments[0]);
  } catch {
    return false;
  }
  return QA_DATABASE_NAME.test(database);
}

export function deterministicSmokeProviderAllowed(env: SmokeProviderEnv): boolean {
  if (env.JUNO_E2E_SMOKE_PROVIDER !== "1") return false;
  if (env.NODE_ENV !== "production") return true;
  if (env.ALEVR_QA_RUNNER !== "1") return false;
  if (!isQaRunnerDatabaseUrl(env.DATABASE_URL)) return false;
  return env.DIRECT_URL === undefined || env.DIRECT_URL === "" || isQaRunnerDatabaseUrl(env.DIRECT_URL);
}
