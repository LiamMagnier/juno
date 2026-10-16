import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * One working mark everywhere (docs/design/GALAXY_SPEC.md): the galaxy.
 *
 * The run glyph, the thinking matrix, the thinking orb and three text shines
 * each said "working" in their own way, sometimes several in one row. These
 * checks keep them from coming back and keep the status rows that moved to the
 * galaxy on it. Spinners stay inside the button that was just pressed.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) {
      if (rel === "src/app/dev") continue;
      out.push(...sources(rel));
    } else if (/\.(tsx?|css)$/.test(name) && !name.includes(".generated.")) {
      out.push(rel);
    }
  }
  return out;
}

test("the retired working marks are gone", () => {
  for (const file of [
    "src/components/chat/run/run-glyph.tsx",
    "src/components/chat/run/run-sweep.tsx",
    "src/components/effects/phase-orb.tsx",
    "src/components/signature/thinking-dots.tsx",
  ]) {
    assert.equal(existsSync(path.join(root, file)), false, `${file} is back`);
  }
});

test("no product source draws a second working mark", () => {
  const banned: Array<[RegExp, string]> = [
    [/from "thinking-orbs"/, "the third-party thinking orb"],
    [/\bcv2-shine\b/, "Code's text shine"],
    [/\bshimmer-text\b/, "the thinking shimmer"],
    [/\baicss-shine\b/, "the AIcss shine"],
    [/animate-thinking-(?:matrix|pulse)\b/, "the 3x3 thinking matrix"],
    [/animate-gen-sweep\b/, "the hairline progress sweep"],
    [/\brun-(?:glyph|sweep)\b/, "the run glyph or its sweep"],
  ];
  const offenders: string[] = [];
  for (const file of sources("src")) {
    const text = read(file);
    for (const [pattern, what] of banned) if (pattern.test(text)) offenders.push(`${file}: ${what}`);
  }
  assert.deepEqual(offenders, []);
});

test("status rows that say work is running draw the galaxy, not a spinner", () => {
  const rows: Record<string, RegExp> = {
    "src/components/chat/panel/activity-timeline-tab.tsx": /<RunGalaxy\b/,
    "src/components/chat/run/run-line.tsx": /<RunGalaxy\b/,
    "src/components/research/scope-card.tsx": /<RunGalaxy\b/,
    "src/components/app/code-work-list.tsx": /<GalaxyMark\b/,
    "src/components/work/work-timeline.tsx": /<GalaxyMark\b/,
    "src/components/work/detail/work-progress.tsx": /<GalaxyMark\b/,
    "src/components/work/work-vocabulary.tsx": /<GalaxyMark\b/,
    "src/components/ui/agent-status-badge.tsx": /<GalaxyMark\b/,
    "src/components/memory/memory-notices.tsx": /<GalaxyMark\b/,
    "src/components/documents/viewer-ui.tsx": /<GalaxyMark\b/,
    "src/components/ui/sonner.tsx": /<GalaxyMark\b/,
    "src/components/code/v2/thread.tsx": /<LiveMark\b/,
    "src/components/code/v2/dock.tsx": /<LiveMark\b/,
  };
  for (const [file, mark] of Object.entries(rows)) {
    const text = read(file);
    assert.match(text, mark, `${file} lost its galaxy`);
  }
  // These rows had a spinner as their status; none is inside a button.
  for (const file of [
    "src/components/work/work-timeline.tsx",
    "src/components/app/code-work-list.tsx",
    "src/components/memory/memory-notices.tsx",
    "src/components/work/work-documents.tsx",
    "src/components/work/work-site-preview.tsx",
    "src/components/ui/sonner.tsx",
  ]) {
    assert.doesNotMatch(read(file), /<Loader2\b|name="loading"/, `${file} draws a spinner as a status again`);
  }
});

test("an online host is a state, not work: a still dot", () => {
  const row = read("src/components/work/work-host-row.tsx");
  assert.doesNotMatch(row, /GalaxyMark|animate-spin/);
  assert.match(row, /rounded-full bg-presence/);
});

test("the galaxy's spec exists where the code cites it", () => {
  assert.ok(existsSync(path.join(root, "docs/design/GALAXY_SPEC.md")));
  const mark = read("src/components/brand/galaxy-mark.tsx");
  // It sleeps when settled: no frame is requested once the clock has stopped.
  assert.match(mark, /const settled = speed === 0 && dim === targetDim && !entering;/);
  assert.match(mark, /if \(!settled && inView && document\.visibilityState === "visible"\) raf = requestAnimationFrame\(frame\);/);
  // The stop is an exponential ease (tau 0.35 s), never a cut.
  assert.match(mark, /Math\.exp\(-dt \/ 0\.35\)/);
});
