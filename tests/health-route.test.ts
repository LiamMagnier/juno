import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROUTE = readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8");
const PROVIDER_HEALTH = readFileSync(new URL("../src/lib/provider-health.ts", import.meta.url), "utf8");

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function section(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

test("ordinary health is a public DB-only liveness check", () => {
  const source = withoutComments(ROUTE);
  const get = section(source, "export async function GET(request: Request)");
  const normalBranch = section(get, "const db =");
  const beforeDiagnostic = section(source, "const startedAt", "async function diagnosticResponse");

  assert.doesNotMatch(beforeDiagnostic, /import\(["']@\/lib\/provider-health["']\)/);
  assert.doesNotMatch(beforeDiagnostic, /from ["']@\/lib\/provider-health["']/);
  assert.doesNotMatch(beforeDiagnostic, /from ["']@\/lib\/admin["']/);
  assert.doesNotMatch(normalBranch, /getOwnerUser|probeAllProviders|providerHealthSnapshot|ensureProviderHealthFresh/);
  assert.match(normalBranch, /databaseOk\(\)/);
  assert.doesNotMatch(normalBranch, /providers|alertOperator|fetch\(/);
  assert.match(source, /\["readiness", "diagnostic", "probe"\]/);
  assert.match(get, /isDiagnosticHealthRequest\(request\)/);
});

test("the diagnostic mode is explicit, owner-gated, and is the only route path that probes", () => {
  const diagnostic = section(ROUTE, "async function diagnosticResponse", "export async function GET");

  assert.match(diagnostic, /import\("@\/lib\/admin"\)/);
  assert.match(diagnostic, /import\("@\/lib\/provider-health"\)/);
  assert.match(diagnostic, /const owner = await getOwnerUser\(\)/);
  assert.match(diagnostic, /if \(!owner\).*status: 404/s);
  assert.match(diagnostic, /probeAllProviders\(\{ timeoutMs: 10_000 \}\)/);
  assert.match(diagnostic, /providersUnhealthy/);
  assert.match(diagnostic, /status: dbOk && providersUnhealthy\.length === 0 \? 200 : 503/);
});

test("the liveness DB query has both a server cancellation boundary and client deadlines", () => {
  const database = section(withoutComments(ROUTE), "async function databaseOk", "async function diagnosticResponse");

  assert.match(database, /\$transaction\(/);
  assert.match(database, /set_config\('statement_timeout'/);
  assert.match(database, /\$queryRaw`SELECT 1`/);
  assert.match(database, /maxWait: DATABASE_TRANSACTION_MAX_WAIT_MS/);
  assert.match(database, /timeout: DATABASE_CHECK_TIMEOUT_MS/);
  assert.doesNotMatch(database, /Promise\.race/);
});

test("provider diagnostics cancel per-provider and batch work and clean up deadlines", () => {
  assert.match(PROVIDER_HEALTH, /export const PROVIDER_PROBE_TIMEOUT_MS = 8_000/);
  assert.match(PROVIDER_HEALTH, /export const PROVIDER_DIAGNOSTIC_TIMEOUT_MS/);
  assert.match(PROVIDER_HEALTH, /signal: deadline\.signal/);
  assert.match(PROVIDER_HEALTH, /finally \{\s*deadline\.cleanup\(\);\s*\}/s);
  assert.match(PROVIDER_HEALTH, /probeAllProviders\(options:/);
  assert.match(PROVIDER_HEALTH, /options\.timeoutMs \?\? PROVIDER_DIAGNOSTIC_TIMEOUT_MS/);
  assert.match(PROVIDER_HEALTH, /startRefresh\(provider, deadline\.signal\)/);
  assert.match(PROVIDER_HEALTH, /clearTimeout\(timeout\)/);
  assert.match(PROVIDER_HEALTH, /removeEventListener\("abort", forwardAbort\)/);
});
