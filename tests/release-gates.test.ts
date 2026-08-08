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

test("production release preflight requires one smoke credential", () => {
  const preflight = withoutCommentLines(RELEASE_PREFLIGHT);
  const credentialGuard = Array.from(preflight.matchAll(/(?:^|\n)\s*if\b[\s\S]*?\bfi\b/g)).find(([block]) => {
    const hasToken = /JUNO_SMOKE_TOKEN/.test(block);
    const hasCookie = /JUNO_SMOKE_COOKIE/.test(block);
    const rejectsMissingCredentials = /(?:missing\s*=\s*1|exit\s+1)/.test(block);
    const checksEitherCredential =
      /\|\|/.test(block) || /\|/.test(block) || (/-z/.test(block) && hasToken && hasCookie);
    return hasToken && hasCookie && checksEitherCredential && rejectsMissingCredentials;
  });

  assert.ok(credentialGuard, "the release preflight must require an authenticated smoke credential");
});

test("production release preflight requires an explicit browser origin allowlist", () => {
  assert.match(RELEASE_PREFLIGHT, /for name in DATABASE_URL DIRECT_URL AUTH_SECRET ALLOWED_ORIGINS;/);
});

test("deploy smoke passes authentication and public UI checks without an optional skip", () => {
  assert.notEqual(SMOKE_REMOTE_BLOCK, "", "production smoke step is missing its remote block");
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_REQUIRE_AUTH\s*=\s*1\b/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_TOKEN\s*=\s*"\$SMOKE_TOKEN"/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_COOKIE\s*=\s*"\$SMOKE_COOKIE"/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_RUN_CHAT\s*=\s*1\b/);
  assert.doesNotMatch(
    SMOKE_REMOTE_BLOCK,
    /if[\s\S]*(?:TOKEN|COOKIE)[\s\S]*else[\s\S]*(?:skip|skipped|not configured)[\s\S]*fi/i,
    "authenticated production smoke must fail closed instead of skipping",
  );
  assert.match(SMOKE_REMOTE_BLOCK, /node ~\/juno\/scripts\/public-ui-smoke\.mjs/);
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

test("deploy validates the voice relay before shipping it", () => {
  assert.match(DEPLOY_JOB, /npm test --prefix relay/);
  assert.match(DEPLOY_JOB, /npm run build --prefix relay/);
});
