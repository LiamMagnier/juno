import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const syncUrl = new URL("../.github/workflows/sync-models.yml", import.meta.url);
const SYNC = existsSync(syncUrl) ? readFileSync(syncUrl, "utf8") : "";
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
  assert.match(SYNC, /npm run sync:benchmarks/);
  assert.match(SYNC, /npm run radar:models/);
  assert.match(SYNC, /npm run validate:models/);
  assert.match(SYNC, /cron: "17 4 \* \* \*"/);
});

test("nothing adds models to the catalog automatically", () => {
  // The catalog is curated by hand from each model's documentation. The
  // provider sync that wrote models.generated.ts — and the runtime discovery
  // that merged provider-listed ids into the pickers — guessed routes and
  // thinking-effort ladders and got them wrong, so both are gone.
  for (const gone of [
    "../scripts/sync-models.ts",
    "../src/lib/models.generated.ts",
    "../src/lib/model-discovery.ts",
    "../src/lib/model-discovery-core.ts",
  ]) {
    assert.equal(existsSync(new URL(gone, import.meta.url)), false, `${gone} is back`);
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["sync:models"], undefined);
  assert.equal(pkg.scripts["sync:models:write"], undefined);
  if (SYNC) {
    assert.doesNotMatch(SYNC, /sync:models/);
    assert.doesNotMatch(SYNC, /models\.generated/);
  }
});
