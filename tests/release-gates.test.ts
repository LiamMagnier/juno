import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DEPLOY_WORKFLOW = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const PRODUCTION_SMOKE = readFileSync(new URL("../scripts/production-smoke.mjs", import.meta.url), "utf8");

function sectionAfter(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing expected section: ${marker}`);
  const end = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, end === -1 ? undefined : end);
}

function withoutCommentLines(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const deployJobStart = DEPLOY_WORKFLOW.indexOf("\n  build-and-deploy:\n");
assert.notEqual(deployJobStart, -1, "deploy workflow is missing the build-and-deploy job");
const DEPLOY_JOB = DEPLOY_WORKFLOW.slice(deployJobStart);
const RELEASE_PREFLIGHT = sectionAfter(
  DEPLOY_JOB,
  "      - name: Validate production release inputs before building or shipping\n",
  "\n      - name: Install dependencies",
);
const SMOKE_STEP = sectionAfter(
  DEPLOY_JOB,
  "      - name: Run authenticated production smoke",
  "\n      - name: ",
);
const SMOKE_REMOTE_BLOCK = SMOKE_STEP.match(/<<['"]REMOTE['"]\n([\s\S]*?)\n\s+REMOTE\b/)?.[1] ?? "";

test("production release preflight does not require an optional smoke credential", () => {
  const preflight = withoutCommentLines(RELEASE_PREFLIGHT);
  const credentialGuard = Array.from(preflight.matchAll(/(?:^|\n)\s*if\b[\s\S]*?\bfi\b/g)).find(([block]) => {
    const hasToken = /JUNO_SMOKE_TOKEN/.test(block);
    const hasCookie = /JUNO_SMOKE_COOKIE/.test(block);
    const rejectsMissingCredentials = /(?:missing\s*=\s*1|exit\s+1)/.test(block);
    const checksEitherCredential =
      /\|\|/.test(block) || /\|/.test(block) || (/-z/.test(block) && hasToken && hasCookie);
    return hasToken && hasCookie && checksEitherCredential && rejectsMissingCredentials;
  });

  assert.equal(credentialGuard, undefined, "release preflight must remain deployable without a dedicated smoke account");
});

test("deploy smoke authenticates when configured and skips otherwise", () => {
  assert.notEqual(SMOKE_REMOTE_BLOCK, "", "production smoke step is missing its remote block");
  assert.match(SMOKE_REMOTE_BLOCK, /if\s+\[\s+-n\s+"\$SMOKE_TOKEN"\s+\]\s+\|\|\s+\[\s+-n\s+"\$SMOKE_COOKIE"\s+\]/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_REQUIRE_AUTH\s*=\s*1\b/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_RUN_CHAT\s*=\s*\"\$\(/);
  assert.match(SMOKE_REMOTE_BLOCK, /else[\s\S]*?(?:skip|skipped|not configured)[\s\S]*?fi/i);
});

test("authenticated production smoke rejects missing credentials and missing chat mode", () => {
  assert.match(PRODUCTION_SMOKE, /const requireAuth\s*=\s*process\.env\.JUNO_SMOKE_REQUIRE_AUTH\s*===\s*["']1["']/);
  assert.match(
    PRODUCTION_SMOKE,
    /if\s*\(\s*requireAuth\s*&&\s*!token\s*&&\s*!cookie\s*\)\s*\{[\s\S]*?throw new Error\([\s\S]*JUNO_SMOKE_TOKEN[\s\S]*JUNO_SMOKE_COOKIE/,
  );
  assert.match(
    PRODUCTION_SMOKE,
    /if\s*\(\s*requireAuth\s*&&\s*process\.env\.JUNO_SMOKE_RUN_CHAT\s*!==\s*["']1["']\s*\)\s*\{[\s\S]*?throw new Error\([\s\S]*JUNO_SMOKE_RUN_CHAT=1/,
  );
});

test("deploy job has no executable prisma db push or db execute fallback", () => {
  assert.doesNotMatch(
    withoutCommentLines(DEPLOY_JOB),
    /\b(?:npx\s+)?prisma\s+db\s+(?:push|execute)\b/i,
    "production deploys must use the controlled migration path, never db push/db execute",
  );
});
