import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  AGENT_MEMORY_FILES,
  AGENT_MEMORY_SENTENCE,
  CLOUD_ENVIRONMENT_FACTS,
  CLOUD_RUNNER_NODE_VERSION,
  CLOUD_RUN_TIMEOUT_MINUTES,
  CLOUD_SANDBOX_NETWORK,
  CODE_PERMISSIONS,
} from "@/lib/code-environment";

/*
 * THE CODE LANDING, PINNED TO THE DECISION IT IMPLEMENTS.
 *
 * `/code` is a greeting and a composer (docs/design/TWO_PRODUCTS.md §3). That
 * is a product decision, and the shape it replaced — a list page with a header,
 * a tab row, a search field, a machine filter and a settled-runs fold — is the
 * shape a page drifts BACK towards, one useful-looking addition at a time. The
 * file-reading assertions below are there so that drift has to be deliberate:
 * putting the list back means deleting a test that says why it went.
 *
 * The second half pins `/code/customize`'s Environments card to the files it
 * describes. That card states a thirty-minute ceiling, a network-isolated
 * sandbox and a Node version, and none of those are facts about the web app —
 * they are facts about `.github/workflows/code-runner.yml` and the vendored
 * agent core, which change without this page being opened. A card that quietly
 * starts lying about the sandbox is worse than no card, so the two halves are
 * read as text here and compared, the way tests/code-runner-workflow.test.ts
 * already compares the workflow with its dispatcher.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/*
 * Hand-written source only. `i18n-catalog.generated.ts` is every user-facing
 * string in the product, re-extracted on every build — a sentence appearing
 * there is that machinery working, not a second copy of it.
 */
const SOURCES = walk(join(ROOT, "src")).filter((file) => !file.endsWith(".generated.ts"));
const sourceOf = new Map(SOURCES.map((file) => [file.slice(ROOT.length), readFileSync(file, "utf8")]));

const LANDING = "src/app/(app)/code/page.tsx";
const COMPOSER = "src/components/code/code-composer.tsx";

/* ───────────────────────── The landing is the composer ──────────────────── */

test("the Code landing is a greeting and the composer, not a page frame", () => {
  const landing = read(LANDING);
  assert.match(landing, /<CodeComposer/, "the landing must mount the composer");
  assert.match(landing, /font-serif/, "the landing opens with the serif greeting");
  // The one route in the app that is deliberately outside AppPage: a composer
  // pinned to the bottom needs the shell's full height, and a page header above
  // a greeting says the page's name twice (PREMIUM_AUDIT.md §3 rule 15).
  assert.ok(!/<AppPageHeader/.test(landing), "the landing must not draw a page header");
  assert.ok(!/from "@\/components\/app\/app-page"/.test(landing), "the landing is not inside AppPage");
});

test("the list page and its chrome are gone, with no import left behind", () => {
  for (const gone of [
    "src/components/code/run-list.tsx",
    "src/components/code/code-surface-nav.tsx",
    "src/components/code/code-presets.tsx",
  ]) {
    assert.ok(!exists(gone), `${gone} is back — the list page's chrome was deleted with the list`);
  }
  for (const [file, source] of sourceOf) {
    for (const dead of ["code/run-list", "code/code-surface-nav", "code/code-presets"]) {
      assert.ok(!source.includes(dead), `${file} still imports ${dead}`);
    }
  }
});

test("the review pane kept an entry point when the list that opened it went", () => {
  /*
   * THE DEFECT THIS EXISTS FOR. Deleting run-list.tsx removed the only thing
   * that mounted `RunReviewPane`, and the assertions above would all have
   * passed with nine hundred lines of review vocabulary left unreachable —
   * per-file verdicts, per-line notes at three severities, bundled into the
   * agent's next instruction, which the product has nowhere else. A deletion
   * that quietly takes a capability with it is the expensive kind, so the pane
   * has to be reachable from somewhere that is itself reachable.
   */
  const importers = [...sourceOf].filter(
    ([file, source]) => file !== "src/components/code/run-review.tsx" && /["']@\/components\/code\/run-review["']/.test(source),
  );
  assert.ok(
    importers.length > 0,
    "nothing imports run-review.tsx — the review pane has no entry point again",
  );
  // The session's changed-files card is that entry point: it is the one place
  // that knows a run has written something worth reading.
  assert.match(
    read("src/components/code/code-session-view.tsx"),
    /<RunReviewPane/,
    "the session view no longer mounts the review pane",
  );
  /*
   * The entry point is the SESSION BANNER, not the changed-files card. This
   * assertion named the card while the review was a cover the card opened;
   * the pane is a docked column now and the control that opens it is the
   * banner's diff indicator — the `+N −M` a reader presses to read the change.
   * The card states what was touched, which is a different sentence.
   */
  assert.match(
    read("src/components/code/code-session-banner.tsx"),
    /onToggleReview/,
    "the session banner no longer offers a way into the review",
  );
});

test("/code/new is a redirect rather than a second composer", () => {
  const route = read("src/app/(app)/code/new/page.tsx");
  /*
   * The destination, not the exact call: this route forwards the query
   * parameters `/code` prefills its composer from (tests/code-prefill.test.ts
   * pins which, and that the list has a reader), so the redirect is written
   * with or without a search string. What must not change is where it goes.
   */
  assert.match(route, /redirect\(/, "/code/new must redirect");
  assert.match(route, /"\/code"/, "/code/new must send its visitors to the landing");
  assert.ok(!/ComposerShell/.test(route), "the composer lives in one component, not in a route");
  // A redirect draws nothing and fails at nothing, so a skeleton or an error
  // boundary beside it would describe a page that does not exist.
  assert.ok(!exists("src/app/(app)/code/new/loading.tsx"));
  assert.ok(!exists("src/app/(app)/code/new/error.tsx"));
});

/* ─────────────────────── The composer's row, as specified ───────────────── */

test("the composer puts the context chips above the field and the model below it", () => {
  const composer = read(COMPOSER);
  const above = composer.indexOf("above={");
  const field = composer.indexOf("field={");
  const leading = composer.indexOf("leading={");
  const trailing = composer.indexOf("trailing={");
  assert.ok(above > 0 && field > above && leading > field && trailing > leading, "the shell's slots are in order");
  const aboveSlot = composer.slice(above, field);
  assert.match(aboveSlot, /<CodeEnvironmentChip/, "the environment chip sits above the field");
  assert.match(aboveSlot, /<CodeTargetPicker/, "the repository chip sits above the field");
  const leadingSlot = composer.slice(leading, trailing);
  assert.match(leadingSlot, /<ComposerAddMenu/, "`+` is on the left of the controls row");
  assert.match(leadingSlot, /<PermissionChip/, "the permission mode is on the left of the controls row");
  assert.match(composer.slice(trailing), /<ModelSelector/, "the model chip is on the right");
});

test("thinking effort stays inside the model popover", () => {
  const composer = read(COMPOSER);
  // FLAT_UI.md §4: the controls row is three objects, and effort is a segmented
  // control under the model list inside the picker — never a chip of its own.
  assert.match(composer, /thinking=\{thinkingControl\}/, "effort is passed into the model selector");
  const trailing = composer.slice(composer.indexOf("trailing={"));
  assert.ok(!/<ReasoningSlider/.test(trailing), "effort must not be mounted on the controls row");
});

/* ──────────────────── One home for the permission sentences ─────────────── */

test("what a run may do is said once, and the two places that say it agree", () => {
  for (const target of ["device", "cloud"] as const) {
    const { mode, detail } = CODE_PERMISSIONS[target];
    assert.ok(mode.length > 0 && detail.length > 0);
    const copies = [...sourceOf].filter(
      ([file, source]) => file !== "src/lib/code-environment.ts" && source.includes(detail),
    );
    assert.deepEqual(
      copies.map(([file]) => file),
      [],
      `the ${target} permission sentence is written out again — it has one home`,
    );
  }
  for (const file of [COMPOSER, "src/components/code/code-customize.tsx"]) {
    assert.match(read(file), /CODE_PERMISSIONS/, `${file} must read the permission vocabulary, not restate it`);
  }
});

test("the permission chip explains the mode and does not pretend to set it", () => {
  const composer = read(COMPOSER);
  const chip = composer.slice(composer.indexOf("function PermissionChip"), composer.indexOf("* THE CODE COMPOSER"));
  // Nothing between this browser and a runner carries a permission choice:
  // `CodeTask` has no column for one. A picker here would decide nothing.
  assert.ok(!/onValueChange|onSelect|useState/.test(chip), "the permission chip must not offer a choice");
});

/* ───────────────── The Environments card, pinned to its sources ─────────── */

const WORKFLOW = ".github/workflows/code-runner.yml";
const workflow = exists(WORKFLOW) ? read(WORKFLOW) : null;

test("the stated cloud ceiling is the workflow's timeout", () => {
  assert.ok(workflow, `${WORKFLOW} is missing`);
  const timeout = /timeout-minutes:\s*(\d+)/.exec(workflow);
  assert.ok(timeout, "the runner job declares no timeout-minutes");
  assert.equal(Number(timeout[1]), CLOUD_RUN_TIMEOUT_MINUTES);
});

test("the stated sandbox network and runtime are the workflow's", () => {
  assert.ok(workflow);
  const network = /JUNO_RUNNER_SANDBOX_NETWORK:\s*(\S+)/.exec(workflow);
  assert.ok(network, "the workflow no longer sets the sandbox network");
  assert.equal(network[1], CLOUD_SANDBOX_NETWORK);
  const node = /node-version:\s*(\d+)/.exec(workflow);
  assert.ok(node, "the workflow no longer pins a Node version");
  assert.equal(Number(node[1]), CLOUD_RUNNER_NODE_VERSION);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
});

test("the files a run reads at start are the agent core's memory files", () => {
  const agent = read("runner/agent-core/src/agent.ts");
  const declared = /const MEMORY_FILES = \[([^\]]+)\]/.exec(agent);
  assert.ok(declared, "agent.ts no longer declares MEMORY_FILES");
  const names = [...declared[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(names, [...AGENT_MEMORY_FILES]);
});

test("the memory sentence promises precedence, because the loop stops at the first hit", () => {
  /*
   * The names and their order were already pinned above, and that was not
   * enough: the card said a run reads all three while `buildSystemPrompt`
   * reads exactly one, so a repository with both AGENTS.md and CLAUDE.md was
   * told its CLAUDE.md applied when nothing had opened it. Both halves of that
   * are asserted here — the loop still breaks, and the sentence still says so
   * — because either one drifting on its own puts the lie back.
   */
  const agent = read("runner/agent-core/src/agent.ts");
  const loop = /for \(const name of MEMORY_FILES\) \{([\s\S]*?)\n  \}/.exec(agent);
  assert.ok(loop, "agent.ts no longer loops MEMORY_FILES");
  assert.match(loop[1], /\bbreak;/, "the loop reads every memory file it finds — the sentence says it reads one");

  assert.match(AGENT_MEMORY_SENTENCE, /the first of/, "the sentence must state precedence, not a list");
  for (const name of AGENT_MEMORY_FILES) {
    assert.ok(AGENT_MEMORY_SENTENCE.includes(name), `the sentence no longer names ${name}`);
  }
});

test("every fact the card states carries the constant it came from", () => {
  const value = (label: string) => {
    const fact = CLOUD_ENVIRONMENT_FACTS.find((f) => f.label === label);
    assert.ok(fact, `the environment card lost its "${label}" row`);
    return fact.value;
  };
  assert.match(value("Ceiling"), new RegExp(`\\b${CLOUD_RUN_TIMEOUT_MINUTES}\\b`));
  assert.match(value("Shell"), new RegExp(CLOUD_SANDBOX_NETWORK));
  assert.match(value("Runtime"), new RegExp(`\\b${CLOUD_RUNNER_NODE_VERSION}\\b`));
  assert.match(value("Machine"), /ubuntu-latest/);
});
