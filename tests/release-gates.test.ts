import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DEPLOY_WORKFLOW = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const PRODUCTION_SMOKE = readFileSync(new URL("../scripts/production-smoke.mjs", import.meta.url), "utf8");
const DEPLOY_SCRIPT = readFileSync(new URL("../deploy/deploy.sh", import.meta.url), "utf8");

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
  assert.match(RELEASE_PREFLIGHT, /for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS;/);
});

test("production deploy is protected and pins the VM host key", () => {
  assert.match(DEPLOY_WORKFLOW, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(DEPLOY_JOB, /environment:\s+Production/);
  assert.match(DEPLOY_JOB, /VM_KNOWN_HOSTS:/);
  assert.match(DEPLOY_JOB, /StrictHostKeyChecking=yes/);
  assert.match(DEPLOY_JOB, /UserKnownHostsFile=/);
  assert.doesNotMatch(DEPLOY_JOB, /StrictHostKeyChecking=accept-new/);
});

test("the canonical CI deploy uses the immutable VM transaction, not in-place rsync", () => {
  assert.match(DEPLOY_JOB, /Deploy the exact reviewed commit through the immutable VM transaction/);
  assert.match(DEPLOY_JOB, /git archive --format=tar/);
  assert.match(DEPLOY_JOB, /git get-tar-commit-id/);
  assert.match(DEPLOY_JOB, /sha256sum "\$archive"/);
  assert.match(DEPLOY_JOB, /actual_checksum=.*sha256sum/);
  assert.match(DEPLOY_JOB, /JUNO_DEPLOY_ARCHIVE/);
  assert.match(DEPLOY_JOB, /JUNO_APP_HOME=/);
  assert.match(DEPLOY_JOB, /JUNO_INITIAL_RELEASE_TARGET=/);
  assert.match(DEPLOY_JOB, /JUNO_PERSISTENT_DATA_ROOT=/);
  assert.doesNotMatch(DEPLOY_JOB, /git bundle create/);
  for (const marker of [
    "Snapshot the current build for rollback",
    "Ship build to the VM",
    "Post-deploy on the VM (install-if-changed, migrate, reload)",
  ]) {
    const section = sectionAfter(DEPLOY_JOB, `      - name: ${marker}\n`, "\n      - name: ");
    assert.match(section, /if:\s*\$\{\{\s*false\s*\}\}/, `${marker} must remain disabled legacy code`);
  }
});

test("production deploy proves public reachability and attempts code rollback on failed checks", () => {
  assert.match(DEPLOY_JOB, /Verify public production health externally/);
  assert.match(DEPLOY_JOB, /JUNO_PUBLIC_UI_BASE_URL=\"\$PUBLIC_APP_URL\" node scripts\/public-ui-smoke\.mjs/);
  assert.match(DEPLOY_JOB, /Roll back failed application release/);
  assert.match(DEPLOY_JOB, /if: \$\{\{ failure\(\) && steps\.configure_ssh\.outcome ===? 'success' \}\}/);
  assert.match(DEPLOY_JOB, /database state was not rewound/);
});

test("production deploy handles a first-deploy environment without copying a missing file", () => {
  assert.match(DEPLOY_JOB, /INCOMING_ENV=.*\.env\.incoming-/);
  assert.match(DEPLOY_JOB, /install -m 600 "\$INCOMING_ENV" "\$LIVE_ROOT\/\.env"/);
});

test("production nginx changes fail closed and restore the prior configuration", () => {
  assert.match(DEPLOY_JOB, /nginx -t failed; restoring the previous site configuration and aborting the deploy/);
  assert.match(DEPLOY_JOB, /sudo cp \"\$NGINX_BACKUP\" \"\$NGINX_SITE\"/);
  assert.doesNotMatch(DEPLOY_JOB, /WARNING: nginx -t failed/);
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

test("deploy script only applies committed Prisma migrations", () => {
  assert.match(DEPLOY_SCRIPT, /set -Eeuo pipefail/);
  assert.match(DEPLOY_SCRIPT, /reviewed_migrations_exist\(\)/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" ls-tree/);
  assert.match(DEPLOY_SCRIPT, /npx prisma migrate deploy/);
  assert.doesNotMatch(
    withoutCommentLines(DEPLOY_SCRIPT),
    /\b(?:npx\s+)?prisma\s+db\s+(?:push|execute)\b/i,
    "the standalone deploy script must fail closed instead of converging schema outside reviewed migrations",
  );
});

test("manual deployment requires a direct schema connection and never mutates the model registry", () => {
  assert.match(DEPLOY_SCRIPT, /for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS/);
  assert.match(DEPLOY_SCRIPT, /JUNO_APP_HOME/);
  assert.match(DEPLOY_SCRIPT, /verify_source_archive\(\)/);
  assert.match(DEPLOY_SCRIPT, /git get-tar-commit-id/);
  assert.doesNotMatch(DEPLOY_SCRIPT, /sync:models:write/);
  assert.match(DEPLOY_SCRIPT, /JUNO_PERSISTENT_DATA_ROOT/);
  assert.match(DEPLOY_SCRIPT, /mkdir -p -- "\$PERSISTENT_DATA_ROOT\/\.uploads" "\$PERSISTENT_DATA_ROOT\/logs"/);
  assert.match(DEPLOY_SCRIPT, /ln -s -- "\$PERSISTENT_DATA_ROOT\/\.uploads" "\$STAGING_DIR\/\.uploads"/);
  assert.match(DEPLOY_SCRIPT, /ln -s -- "\$PERSISTENT_DATA_ROOT\/logs" "\$STAGING_DIR\/logs"/);
});

test("deploy script builds before atomic activation and has an application rollback path", () => {
  const archive = DEPLOY_SCRIPT.indexOf('git -C "$APP_HOME" archive');
  const migrate = DEPLOY_SCRIPT.indexOf('run_in_release "$STAGING_DIR" npx prisma migrate deploy');
  const materialize = DEPLOY_SCRIPT.indexOf('mv -- "$STAGING_DIR" "$RELEASE_DIR"');
  const switchCurrent = DEPLOY_SCRIPT.indexOf('atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"');
  const activate = DEPLOY_SCRIPT.indexOf('reload_release "$RELEASE_DIR" "$TARGET_SHA"');

  assert.ok(archive >= 0, "the target commit must be archived into a candidate release");
  assert.ok(archive < migrate, "migrations must run from the candidate release");
  assert.ok(migrate < materialize, "the candidate must pass migrations before publication");
  assert.ok(materialize < switchCurrent, "the built candidate must be finalized before current changes");
  assert.ok(switchCurrent < activate, "PM2 must activate only after the current pointer is switched");
  assert.match(DEPLOY_SCRIPT, /atomic_symlink\(\)/);
  assert.match(DEPLOY_SCRIPT, /mv -f -- \"\$temporary\" \"\$pointer\"/);
  assert.match(DEPLOY_SCRIPT, /ROLLBACK_NEEDED=1/);
  assert.match(DEPLOY_SCRIPT, /rollback_release\(\)/);
  assert.match(DEPLOY_SCRIPT, /restore_pointer \"\$CURRENT_LINK\"/);
  assert.match(DEPLOY_SCRIPT, /trap on_exit EXIT/);
});

test("production activation verifies every PM2 service, including workers and the relay", () => {
  const required = [
    "juno-backend",
    "juno-scheduler",
    "juno-work",
    "juno-work-scheduler",
    "juno-research",
    "juno-work-triggers",
    "juno-import-recovery",
    "juno-code-sweeper",
    "juno-voice-relay",
  ];
  for (const name of required) {
    assert.match(DEPLOY_SCRIPT, new RegExp(name));
    assert.match(DEPLOY_JOB, new RegExp(name));
  }
  assert.match(DEPLOY_SCRIPT, /pm2 jlist/);
  assert.match(DEPLOY_JOB, /pm2 jlist/);
  assert.match(DEPLOY_SCRIPT, /pm2_env\?\.status === "online"/);
  assert.match(DEPLOY_JOB, /pm2_env\?\.status === "online"/);
});

test("external release failures use the same verified rollback transaction", () => {
  const rollbackStep = DEPLOY_JOB.slice(DEPLOY_JOB.indexOf("      - name: Roll back failed application release"));
  assert.match(rollbackStep, /bash "\$DEPLOY_SCRIPT" --rollback/);
  assert.match(rollbackStep, /CURRENT_SHA.*GITHUB_SHA/);
  assert.doesNotMatch(rollbackStep, /juno-previous/);
});

test("deploy script does not pull or rewrite the live checkout", () => {
  assert.doesNotMatch(DEPLOY_SCRIPT, /git checkout|git pull/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" fetch --prune origin main/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" diff --quiet/);
});

test("deploy validates the voice relay before shipping it", () => {
  assert.match(DEPLOY_JOB, /npm test --prefix relay/);
  assert.match(DEPLOY_JOB, /npm run build --prefix relay/);
});
