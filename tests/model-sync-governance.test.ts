import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const syncUrl = new URL("../.github/workflows/sync-models.yml", import.meta.url);
const SYNC = existsSync(syncUrl) ? readFileSync(syncUrl, "utf8") : "";
const SYNC_SCRIPT = readFileSync(new URL("../scripts/sync-models.ts", import.meta.url), "utf8");
const DEPLOY = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

/** Every `git push` in the workflow, less its indentation. */
function pushes(yaml: string): string[] {
  return yaml
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("git push"));
}

test("deploy still ships every push to main, which is why this matters", () => {
  assert.match(DEPLOY, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
});

test("the nightly model sync never pushes to main", (t) => {
  if (!SYNC) {
    t.skip("sync-models.yml not present");
    return;
  }
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

test("it opens a pull request against main and keeps the model-watch issue", (t) => {
  if (!SYNC) {
    t.skip("sync-models.yml not present");
    return;
  }
  assert.match(SYNC, /gh pr create/, "the sync no longer opens a pull request");
  assert.match(SYNC, /--base main/, "the pull request does not target main");
  assert.match(SYNC, /pull-requests:\s*write/, "the job cannot open a pull request");

  assert.match(SYNC, /gh issue create/, "the model-watch issue was dropped");
  assert.match(SYNC, /--label model-watch/);
});

test("nothing about what the watch detects was weakened", (t) => {
  if (!SYNC) {
    t.skip("sync-models.yml not present");
    return;
  }
  assert.match(SYNC, /npm run sync:models:write/);
  assert.match(SYNC, /npm run sync:benchmarks/);
  assert.match(SYNC, /npm run radar:models/);
  assert.match(SYNC, /npm run validate:models/);
  assert.match(SYNC, /Every provider failed to respond/);
  assert.match(SYNC, /cron: "17 4 \* \* \*"/);
});

test("a no-op provider sync does not create timestamp-only pull requests", () => {
  assert.match(SYNC_SCRIPT, /attempted\.length === 0/);
  assert.match(SYNC_SCRIPT, /added\.length === 0 && pruneDelta === 0/);
  assert.match(SYNC_SCRIPT, /generated catalog left unchanged/);
  assert.match(SYNC_SCRIPT, /no generated catalog changes to write/);
});
