import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SKILLS_SPEC_KEYS,
  MAX_SKILL_MD_CHARS,
  parseSkillMd,
  serializeSkillMd,
  titleFromSkillName,
} from "@/lib/skills/skill-md";

/*
 * Reading a `SKILL.md`.
 *
 * The file is the artefact both Claude and Codex read, and the one Juno's
 * importer is handed from somebody's repository. What is tested here is not
 * "does it parse the happy case" — it is the two failure directions that both
 * matter and pull against each other:
 *
 *   - too strict, and a skill written for Claude Code is refused because it
 *     declares `context: fork`. Most of the skills on GitHub carry host keys
 *     the published spec does not define, and a reader that rejects them can
 *     read almost nothing.
 *   - too loose, and a Markdown file with a horizontal rule in it becomes a
 *     skill whose "name" is a sentence, or a value is invented for a field the
 *     author never wrote.
 *
 * The resolution is: unknown keys are RECORDED and ignored, required fields are
 * enforced, and every value is bounded. `ignoredKeys` is what the preview shows
 * the reader, so a dropped field is visible rather than silent.
 */

const MINIMAL = `---
name: tidy-inbox
description: Sorts an inbox into folders. Use when the user mentions email triage.
---

# Tidy inbox

Move anything older than a month into Archive.`;

test("reads the minimal spec shape", () => {
  const result = parseSkillMd(MINIMAL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "tidy-inbox");
  assert.match(result.skill.description, /^Sorts an inbox/);
  assert.match(result.skill.instructions, /^# Tidy inbox/);
  assert.deepEqual(result.skill.ignoredKeys, []);
  assert.deepEqual(result.skill.allowedTools, []);
});

test("every spec key is read, and none of them lands in ignoredKeys", () => {
  const source = `---
name: spec-complete
description: Exercises every field the published specification defines.
license: MIT
compatibility: Needs a shell and network access
allowed-tools:
  - Read
  - Bash
metadata:
  entitlement: premium
  version: "2"
---

Do the thing.`;
  const result = parseSkillMd(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.license, "MIT");
  assert.equal(result.skill.compatibility, "Needs a shell and network access");
  assert.deepEqual(result.skill.allowedTools, ["Read", "Bash"]);
  assert.deepEqual(result.skill.metadata, { entitlement: "premium", version: "2" });
  assert.deepEqual(result.skill.ignoredKeys, []);
  // Every key the spec defines is accounted for by the reader, so a new one
  // cannot be added to the constant without a test noticing it is unread.
  for (const key of AGENT_SKILLS_SPEC_KEYS) {
    assert.ok(result.skill.specKeys.includes(key), `${key} was not read`);
  }
});

test("a Claude Code skill is read, and its host-only keys are named rather than dropped silently", () => {
  const source = `---
name: review-pr
description: Reviews a pull request. Use when asked for a code review.
disable-model-invocation: true
context: fork
agent: Explore
model: claude-opus-5
allowed-tools: Bash(gh pr diff) Read
---

Review it.`;
  const result = parseSkillMd(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Not refused: refusing this shape would reject most of what is on GitHub.
  assert.equal(result.skill.name, "review-pr");
  for (const key of ["disable-model-invocation", "context", "agent", "model"]) {
    assert.ok(result.skill.hostKeys.includes(key), `${key} should be a known host key`);
    assert.ok(!result.skill.ignoredKeys.includes(key), `${key} should not read as unrecognised`);
  }
  // The argument pattern survives VERBATIM. Juno matches capability names by
  // exact equality, so `Bash(gh pr diff)` can only ever be withheld — which is
  // the true outcome. Rewriting it to `Bash` would be inventing a broader
  // request than the author made.
  assert.deepEqual(result.skill.allowedTools, ["Bash(gh pr diff)", "Read"]);
});

test("a genuinely unrecognised key is reported", () => {
  const result = parseSkillMd(`---
name: odd
description: Has a field nobody defines.
sandwich: tuna
---

Body.`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.skill.ignoredKeys, ["sandwich"]);
});

test("a folded description spanning lines is joined, not truncated at the first", () => {
  const result = parseSkillMd(`---
name: folded
description: Extracts text and tables from PDF files, fills forms, merges
  documents. Use when the user mentions PDFs.
---

Body.`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.skill.description,
    "Extracts text and tables from PDF files, fills forms, merges documents. Use when the user mentions PDFs."
  );
});

test("block scalars are read in both forms", () => {
  const folded = parseSkillMd(`---
name: folded-block
description: >-
  One sentence
  across two lines.
---

Body.`);
  assert.equal(folded.ok, true);
  if (folded.ok) assert.equal(folded.skill.description, "One sentence across two lines.");

  const kept = parseSkillMd(`---
name: kept-block
description: |
  Line one
  Line two
---

Body.`);
  assert.equal(kept.ok, true);
  if (kept.ok) assert.equal(kept.skill.description, "Line one\nLine two");
});

test("a URL fragment in a value is not read as a comment", () => {
  const result = parseSkillMd(`---
name: linky
description: See https://example.com/docs#usage for the rest. # this part is a comment
---

Body.`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.description, "See https://example.com/docs#usage for the rest.");
});

test("refuses everything that is not a skill, with a reason per case", () => {
  assert.deepEqual(parseSkillMd("# Just a readme\n\nNothing here."), {
    ok: false,
    reason: "no_frontmatter",
  });
  assert.deepEqual(parseSkillMd("---\nname: x\ndescription: y\n\nno close"), {
    ok: false,
    reason: "unterminated_frontmatter",
  });
  assert.deepEqual(parseSkillMd("---\ndescription: no name\n---\n\nBody."), {
    ok: false,
    reason: "missing_name",
  });
  assert.deepEqual(parseSkillMd("---\nname: x\n---\n\nBody."), {
    ok: false,
    reason: "missing_description",
  });
  assert.deepEqual(parseSkillMd("---\nname: x\ndescription: y\n---\n\n   \n"), {
    ok: false,
    reason: "empty_body",
  });
  // The name has to round-trip as something typeable after a slash, so the
  // spec's looser prose is not the rule Juno applies.
  assert.deepEqual(parseSkillMd("---\nname: Not A Slug\ndescription: y\n---\n\nBody."), {
    ok: false,
    reason: "invalid_name",
  });
});

test("a horizontal rule mid-document is not mistaken for a fence", () => {
  const source = "# A readme\n\nSome prose.\n\n---\n\nMore prose.";
  assert.deepEqual(parseSkillMd(source), { ok: false, reason: "no_frontmatter" });
});

test("a BOM does not stop the fence being found", () => {
  const result = parseSkillMd(`﻿${MINIMAL}`);
  assert.equal(result.ok, true);
});

test("CRLF line endings parse identically to LF", () => {
  const crlf = parseSkillMd(MINIMAL.replace(/\n/g, "\r\n"));
  const lf = parseSkillMd(MINIMAL);
  assert.equal(crlf.ok, true);
  assert.equal(lf.ok, true);
  if (crlf.ok && lf.ok) assert.deepEqual(crlf.skill, lf.skill);
});

test("an oversized file is refused rather than truncated into a partial skill", () => {
  const huge = `---\nname: huge\ndescription: Big.\n---\n\n${"x".repeat(MAX_SKILL_MD_CHARS)}`;
  assert.deepEqual(parseSkillMd(huge), { ok: false, reason: "too_large" });
});

test("titles are derived without mangling the acronyms half these names are", () => {
  assert.equal(titleFromSkillName("tidy-inbox"), "Tidy inbox");
  assert.equal(titleFromSkillName("pdf"), "Pdf");
  assert.equal(titleFromSkillName("mcp-server-builder"), "Mcp server builder");
});

test("serializeSkillMd writes a file parseSkillMd reads back", () => {
  const written = serializeSkillMd({
    name: "tidy-inbox",
    description: "Sorts an inbox into folders. Use when the user mentions email triage.",
    instructions: "# Tidy inbox\n\nMove anything older than a month into Archive.",
    license: "MIT",
    compatibility: "Needs a shell",
    allowedTools: ["Read", "Bash(git add *)"],
    metadata: { entitlement: "premium", version: "2" },
  });
  const result = parseSkillMd(written);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "tidy-inbox");
  assert.match(result.skill.description, /^Sorts an inbox/);
  assert.match(result.skill.instructions, /^# Tidy inbox/);
  assert.equal(result.skill.license, "MIT");
  assert.equal(result.skill.compatibility, "Needs a shell");
  assert.deepEqual(result.skill.allowedTools, ["Read", "Bash(git add *)"]);
  assert.deepEqual(result.skill.metadata, { entitlement: "premium", version: "2" });
});

test("serializeSkillMd quotes a description the reader would otherwise split", () => {
  const written = serializeSkillMd({
    name: "quoted",
    description: 'Says "hello": then stops.',
    instructions: "Body.",
  });
  const result = parseSkillMd(written);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.description, 'Says "hello": then stops.');
});
