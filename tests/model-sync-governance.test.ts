import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The nightly model watch must not be able to deploy.
 *
 * `.github/workflows/sync-models.yml` runs unattended at 04:17 UTC, rewrites
 * `src/lib/models.generated.ts` from fifteen third parties' model APIs, and
 * used to commit and push the result to main. `.github/workflows/deploy.yml`
 * triggers on `push: branches: [main]`. So a model discovered by a bot from a
 * vendor's JSON was built and shipped to production before anybody read the
 * diff — and the registry it rewrites is what the picker offers, what tokens
 * are priced at, and what the per-run spend ceilings are computed from.
 *
 * It opens a pull request now. That is a property of a YAML file, which no unit
 * test can exercise behaviourally, and it is also exactly the kind of change
 * that gets undone by somebody debugging a failing nightly at midnight. Reading
 * the file is the only check available, so it is the check.
 */

const SYNC = readFileSync(new URL("../.github/workflows/sync-models.yml", import.meta.url), "utf8");
const DEPLOY = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

/** Every `git push` in the workflow, less its indentation. */
function pushes(yaml: string): string[] {
  return yaml
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("git push"));
}

test("deploy still ships every push to main, which is why this matters", () => {
  // If this stops being true the rule below is still worth keeping, but the
  // reason stated in every comment around it has changed and should be reread.
  assert.match(DEPLOY, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
});

test("the nightly model sync never pushes to main", () => {
  const branchless = pushes(SYNC).filter(
    (line) => !/git push (--force )?origin "\$SYNC_BRANCH"/.test(line)
  );
  assert.deepEqual(
    branchless,
    [],
    `the model sync pushes somewhere other than its own branch: ${branchless.join(" | ")}`
  );
  assert.ok(!/\$SYNC_BRANCH:\s*main\b/.test(SYNC));
  assert.match(SYNC, /SYNC_BRANCH:\s*model-sync\//);
});

test("it opens a pull request against main and keeps the model-watch issue", () => {
  assert.match(SYNC, /gh pr create/, "the sync no longer opens a pull request");
  assert.match(SYNC, /--base main/, "the pull request does not target main");
  assert.match(SYNC, /pull-requests:\s*write/, "the job cannot open a pull request");

  // The issue is the notification channel the curator agent watches, and the
  // point of this change was to add a gate, not to remove the alert.
  assert.match(SYNC, /gh issue create/, "the model-watch issue was dropped");
  assert.match(SYNC, /--label model-watch/);
});

test("nothing about what the watch detects was weakened", () => {
  // The three layers, the blackout guard that makes an all-provider failure go
  // red rather than look like a quiet night, and the registry validation that
  // runs before anything is proposed.
  assert.match(SYNC, /npm run sync:models:write/);
  assert.match(SYNC, /npm run sync:benchmarks/);
  assert.match(SYNC, /npm run radar:models/);
  assert.match(SYNC, /npm run validate:models/);
  assert.match(SYNC, /Every provider failed to respond/);
  assert.match(SYNC, /cron: "17 4 \* \* \*"/);
});
