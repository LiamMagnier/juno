import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { WorkSkill, WorkSkillSource } from "@prisma/client";
import { githubSourceKey, skillIsAvailable, sourceLabel } from "@/lib/skills/library-contract";
import { discoverGithubSkills, parseGithubSkillSource, type GithubDiscovery } from "@/lib/skills/github";
import {
  AVAILABLE_SKILL_WHERE,
  PROVENANCE_DIGEST_KEY,
  buildSkillLibrary,
  chooseImportSource,
  diffSourceSkills,
  discoverySourceKey,
  enabledAfterMint,
  githubSkillContract,
  instructionsDigest,
  sameCommit,
  scopeContains,
  serializeLibrarySkill,
  serializeSkillSource,
  sourceCommitsAfter,
  suggestSkillSlug,
  trustAfterUpstreamChange,
  type InstalledSourceSkill,
} from "@/lib/skills/sources";
import { emptySkillContract, serializeSkill } from "@/lib/work/skills";

/*
 * Skills installed from a repository, grouped into one source.
 *
 * The routes read and write; every decision they make is here, and so are its
 * tests: which source an import joins, what an update check calls changed,
 * added and removed, and the two rules an update must never break (a skill the
 * reader switched off stays off, and new upstream text is not trusted text).
 * Discovery runs against a scripted transport, as in skills-github.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function skill(overrides: Partial<WorkSkill> = {}): WorkSkill {
  return {
    id: "skl_1",
    userId: "usr_1",
    projectId: null,
    slug: "tidy-inbox",
    name: "Tidy inbox",
    description: "Sorts an inbox.",
    currentVersion: 1,
    enabled: true,
    trust: "untrusted",
    autoSelect: false,
    securityStatus: "clear",
    securityUpdatedAt: null,
    kind: "skill",
    sourceId: null,
    sourcePath: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function source(overrides: Partial<WorkSkillSource> = {}): WorkSkillSource {
  return {
    id: "wss_1",
    userId: "usr_1",
    kind: "github",
    owner: "anthropics",
    repo: "skills",
    key: "github:anthropics/skills",
    ref: "main",
    path: "",
    commit: "a".repeat(40),
    latestCommit: null,
    lastCheckedAt: null,
    enabled: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

const skillMd = (name: string, body: string, tools?: string) => `---
name: ${name}
description: ${name} does its job. Use when asked.${tools ? `\nallowed-tools: ${tools}` : ""}
---

${body}`;

/** A discovery of `files` (path → SKILL.md text), plus paths listed but not read. */
async function discover(files: Record<string, string>, extraListed: string[] = []): Promise<GithubDiscovery> {
  const paths = [...Object.keys(files), ...extraListed];
  const f = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/commits/main")) return new Response(JSON.stringify({ sha: "b".repeat(40) }));
    if (href.includes("/git/trees/")) {
      return new Response(JSON.stringify({ tree: paths.map((path) => ({ path, type: "blob" })) }));
    }
    const hit = Object.entries(files).find(([path]) => href.includes(`/contents/${path}`));
    if (hit) return new Response(hit[1]);
    if (href.endsWith("/repos/anthropics/skills")) return new Response(JSON.stringify({ default_branch: "main" }));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("anthropics/skills")!, {
    allowEmpty: true,
  });
  assert.equal(result.ok, true, "the scripted walk failed");
  if (!result.ok) throw new Error("unreachable");
  return result.discovery;
}

function installed(overrides: Partial<InstalledSourceSkill> & { path: string }): InstalledSourceSkill {
  return {
    skillId: `skl_${overrides.path}`,
    slug: "x",
    name: "X",
    description: "Installed.",
    instructions: "Old body.",
    requestedTools: [],
    contract: emptySkillContract(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("two spellings of one repository are one source", () => {
  assert.equal(githubSourceKey("Anthropics", "Skills"), "github:anthropics/skills");
  assert.equal(githubSourceKey(" anthropics ", "skills.git"), "github:anthropics/skills");
  assert.equal(discoverySourceKey({ owner: "OpenAI", repo: "Skills" }), "github:openai/skills");
});

test("an import joins the source that already covers its folder", () => {
  const whole = source({ id: "whole", path: "" });
  const docs = source({ id: "docs", path: "skills/docs" });
  const tagged = source({ id: "tagged", path: "skills/pdf", ref: "v2" });
  const other = source({ id: "other", key: "github:openai/skills" });
  const all = [whole, docs, tagged, other];
  const key = "github:anthropics/skills";

  // The same folder is the same source whatever ref it was read at: the
  // unique index allows nothing else.
  assert.equal(chooseImportSource(all, { key, path: "skills/pdf", ref: "main" })?.id, "tagged");
  // A folder inside one already installed joins the narrowest covering source.
  assert.equal(chooseImportSource(all, { key, path: "skills/docs/word", ref: "main" })?.id, "docs");
  assert.equal(chooseImportSource(all, { key, path: "skills/xlsx", ref: "main" })?.id, "whole");
  // A different ref does not join a covering source; it gets its own.
  assert.equal(chooseImportSource([whole], { key, path: "skills/xlsx", ref: "v3" }), null);
  // A different repository never does.
  assert.equal(chooseImportSource([other], { key, path: "", ref: "main" }), null);

  assert.equal(scopeContains("", "anything"), true);
  assert.equal(scopeContains("skills", "skills-extra"), false);
});

test("a taken slash name is offered back as <repo>-<name>, then numbered", () => {
  assert.equal(suggestSkillSlug("skills", "pdf", new Set(["pdf"])), "skills-pdf");
  assert.equal(suggestSkillSlug("skills", "pdf", new Set(["pdf", "skills-pdf"])), "skills-pdf-2");
  assert.equal(suggestSkillSlug("My.Skills", "pdf", new Set()), "my-skills-pdf");
  assert.equal(suggestSkillSlug("技能", "", new Set()), null);
  const long = suggestSkillSlug("r", "a".repeat(80), new Set([`r-${"a".repeat(62)}`]));
  assert.ok(long && long.length <= 64 && long.endsWith("-2"));
});

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

test("the library groups skills by source and sorts both levels", () => {
  const pdf = skill({ id: "s1", name: "Pdf", slug: "pdf", sourceId: "wss_a", sourcePath: "skills/pdf/SKILL.md" });
  const docx = skill({ id: "s2", name: "docx", slug: "docx", sourceId: "wss_a", sourcePath: "skills/docx/SKILL.md" });
  const mine = skill({ id: "s3", name: "Weekly review", slug: "weekly-review" });
  const alsoMine = skill({ id: "s4", name: "Budget", slug: "budget" });
  const openai = skill({ id: "s5", name: "Slides", slug: "slides", sourceId: "wss_b" });
  const library = buildSkillLibrary({
    skills: [pdf, mine, docx, openai, alsoMine],
    sources: [
      source({ id: "wss_b", owner: "openai", repo: "skills", key: "github:openai/skills" }),
      source({ id: "wss_a" }),
      source({ id: "wss_empty", owner: "vercel-labs", repo: "agent-skills", key: "github:vercel-labs/agent-skills" }),
    ],
    total: 5,
  });

  assert.deepEqual(library.yours.map((entry) => entry.slug), ["budget", "weekly-review"]);
  assert.deepEqual(library.sources.map((entry) => sourceLabel(entry)), [
    "anthropics/skills",
    "openai/skills",
    "vercel-labs/agent-skills",
  ]);
  assert.deepEqual(library.sources[0].skills.map((entry) => entry.slug), ["docx", "pdf"]);
  assert.equal(library.sources[0].skills[1].sourcePath, "skills/pdf/SKILL.md");
  // A source whose skills are all gone is still listed, so it can be removed.
  assert.deepEqual(library.sources[2].skills, []);
  assert.equal(library.truncated, false);

  const capped = buildSkillLibrary({ skills: [mine], sources: [], total: 501 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.total, 501);
});

test("a library skill is the wire skill plus where it lives, and serializeSkill is unchanged", () => {
  const row = skill({ sourceId: "wss_1", sourcePath: "a/SKILL.md", kind: "skill" });
  const wire = serializeSkill(row);
  // Native sync and the Electron schema read this shape; the source belongs to
  // the library view, not to the skill's own record.
  assert.equal("sourceId" in wire, false);
  assert.equal("kind" in wire, false);
  assert.deepEqual(serializeLibrarySkill(row), { ...wire, sourceId: "wss_1", sourcePath: "a/SKILL.md" });
});

test("a source links to its repository, or to the folder it was scoped to", () => {
  assert.equal(serializeSkillSource(source()).url, "https://github.com/anthropics/skills");
  assert.equal(
    serializeSkillSource(source({ ref: "release/2026", path: "skills/docs" })).url,
    "https://github.com/anthropics/skills/tree/release/2026/skills/docs"
  );
  const wire = serializeSkillSource(source({ lastCheckedAt: new Date("2026-09-20T10:00:00.000Z") }));
  assert.equal(wire.lastCheckedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(wire.kind, "github");
  assert.equal("userId" in wire, false);
});

test("available means the skill's own switch AND its source's", () => {
  assert.equal(skillIsAvailable({ enabled: true, sourceId: null }, null), true);
  assert.equal(skillIsAvailable({ enabled: true, sourceId: "wss_1" }, { enabled: true }), true);
  assert.equal(skillIsAvailable({ enabled: true, sourceId: "wss_1" }, { enabled: false }), false);
  assert.equal(skillIsAvailable({ enabled: false, sourceId: "wss_1" }, { enabled: true }), false);
  // The query form every reader uses says the same thing.
  assert.deepEqual(AVAILABLE_SKILL_WHERE, {
    enabled: true,
    OR: [{ sourceId: null }, { source: { is: { enabled: true } } }],
  });
});

// ---------------------------------------------------------------------------
// Installing and updating
// ---------------------------------------------------------------------------

test("an installed skill records where it came from, and a digest of what it read", async () => {
  const discovery = await discover({
    "skills/pdf/SKILL.md": `---
name: pdf
description: Reads PDFs. Use when asked.
license: MIT
allowed-tools: web_search Bash(git add *)
metadata:
  commit: forged
---

Read the PDF.`,
  });
  const base = { ...emptySkillContract(), resourceAttachmentIds: ["att_1"] };
  const { contract, requestedTools, droppedTools } = githubSkillContract(discovery.candidates[0], base);

  assert.deepEqual(requestedTools, ["web_search"]);
  assert.deepEqual(droppedTools, ["Bash(git add *)"]);
  // What the reader added in Juno survives an update.
  assert.deepEqual(contract.resourceAttachmentIds, ["att_1"]);
  const keys = Object.keys(contract.provenance);
  // Source keys first, so the 16-entry cap can never push them out.
  assert.deepEqual(keys.slice(0, 8), [
    "source.kind",
    "source.owner",
    "source.repo",
    "source.ref",
    "source.commit",
    "source.path",
    "source.url",
    PROVENANCE_DIGEST_KEY,
  ]);
  assert.equal(contract.provenance[PROVENANCE_DIGEST_KEY], instructionsDigest("Read the PDF."));
  // The author's metadata cannot overwrite the record of where the file came from.
  assert.equal(contract.provenance["source.commit"], "b".repeat(40));
  assert.equal(contract.provenance["skill.commit"], "forged");
  assert.equal(contract.provenance["skill.license"], "MIT");
});

test("an update check sorts upstream into changed, added and removed", async () => {
  const discovery = await discover(
    {
      "skills/pdf/SKILL.md": skillMd("pdf", "New body."),
      "skills/docx/SKILL.md": skillMd("docx", "Same body."),
      "skills/xlsx/SKILL.md": skillMd("xlsx", "Brand new."),
      "skills/pptx/SKILL.md": skillMd("pptx", "Installed through another source."),
      "skills/broken/SKILL.md": "no frontmatter at all",
    },
    // Listed in the tree but not read this time: never "removed". (Reading
    // past the cap is covered in skills-github.test.ts.)
    ["skills/unread/SKILL.md"]
  );
  const diff = diffSourceSkills({
    installed: [
      installed({ path: "skills/pdf/SKILL.md", name: "Pdf", slug: "pdf", instructions: "Old body." }),
      installed({ path: "skills/docx/SKILL.md", name: "Docx", slug: "docx", instructions: "Same body." }),
      installed({ path: "skills/gone/SKILL.md", name: "Gone", slug: "gone" }),
      installed({ path: "skills/unread/SKILL.md", name: "Unread", slug: "unread" }),
      installed({ path: "skills/broken/SKILL.md", name: "Broken", slug: "broken" }),
    ],
    discovery,
    elsewhere: new Set(["skills/pptx/SKILL.md"]),
  });

  assert.deepEqual(
    diff.changed.map((change) => [change.path, change.slug, change.widensPermissions]),
    [["skills/pdf/SKILL.md", "pdf", false]]
  );
  assert.deepEqual(diff.added.map((change) => [change.path, change.name, change.skillId]), [
    ["skills/xlsx/SKILL.md", "Xlsx", undefined],
  ]);
  assert.deepEqual(diff.removed.map((change) => change.path), ["skills/gone/SKILL.md"]);
});

test("a local edit is not an upstream change, and an upstream change is one either way", async () => {
  const read = "The body as it was installed.";
  const recorded = {
    ...emptySkillContract(),
    provenance: { [PROVENANCE_DIGEST_KEY]: instructionsDigest(read) },
  };
  const edited = installed({
    path: "skills/pdf/SKILL.md",
    instructions: "The reader rewrote this in Juno.",
    contract: recorded,
  });

  const unchanged = await discover({ "skills/pdf/SKILL.md": skillMd("pdf", read) });
  assert.deepEqual(diffSourceSkills({ installed: [edited], discovery: unchanged }).changed, []);

  const moved = await discover({ "skills/pdf/SKILL.md": skillMd("pdf", "Upstream moved on.") });
  assert.equal(diffSourceSkills({ installed: [edited], discovery: moved }).changed.length, 1);
});

test("a file that only asks for more tools is a change, and says it widens permissions", async () => {
  const discovery = await discover({
    "skills/pdf/SKILL.md": skillMd("pdf", "Same body.", "web_search canvas"),
  });
  const [change] = diffSourceSkills({
    installed: [installed({ path: "skills/pdf/SKILL.md", instructions: "Same body.", requestedTools: ["web_search"] })],
    discovery,
  }).changed;
  assert.equal(change?.widensPermissions, true);
});

test("a folder emptied upstream reports everything installed as removed", async () => {
  const discovery = await discover({});
  const diff = diffSourceSkills({
    installed: [installed({ path: "skills/pdf/SKILL.md", name: "Pdf" })],
    discovery,
  });
  assert.deepEqual(diff.removed.map((change) => change.name), ["Pdf"]);
  assert.deepEqual(diff.added, []);
});

test("a new version never switches back on a skill the reader switched off", () => {
  // The reader's switch.
  assert.equal(enabledAfterMint({ enabled: false, previousStatus: "clear", nextStatus: "clear" }), false);
  assert.equal(enabledAfterMint({ enabled: false, previousStatus: "warning", nextStatus: "clear" }), false);
  assert.equal(enabledAfterMint({ enabled: true, previousStatus: "clear", nextStatus: "warning" }), true);
  // The scanner's: a blocked version always lands off...
  assert.equal(enabledAfterMint({ enabled: true, previousStatus: "clear", nextStatus: "blocked" }), false);
  // ...and a blocked skill cannot be switched on by hand, so a clean version
  // is the scanner handing back a switch that was never the reader's.
  assert.equal(enabledAfterMint({ enabled: false, previousStatus: "blocked", nextStatus: "clear" }), true);
});

test("new upstream instructions withdraw trust; a tools-only change does not", () => {
  assert.equal(trustAfterUpstreamChange("user_authored", true), "untrusted");
  assert.equal(trustAfterUpstreamChange("verified", true), "untrusted");
  assert.equal(trustAfterUpstreamChange("user_authored", false), "user_authored");
  assert.equal(trustAfterUpstreamChange("untrusted", true), "untrusted");
});

test("a source is flagged out of date only while an installed skill differs", () => {
  const old = "a".repeat(40);
  const head = "b".repeat(40);
  // Commits that touched no installed skill move the source up quietly.
  assert.deepEqual(sourceCommitsAfter({ commit: old, upstreamCommit: head, stillChanged: 0 }), {
    commit: head,
    latestCommit: null,
  });
  assert.deepEqual(sourceCommitsAfter({ commit: old, upstreamCommit: head, stillChanged: 2 }), {
    commit: old,
    latestCommit: head,
  });
  assert.equal(sameCommit(head, head), true);
  assert.equal(sameCommit(head.slice(0, 7).toUpperCase(), head), true);
  assert.equal(sameCommit("bbb", head), false);
  assert.equal(sameCommit(old, head), false);
});

// ---------------------------------------------------------------------------
// The migration and the kind split
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the backfill folds keys the way githubSourceKey does, and can run twice", () => {
  const sql = read("prisma/migrations/20260923000000_skill_sources/migration.sql");
  // lower(trim(owner)) / lower(trim(repo)) without ".git", as in the contract.
  assert.match(sql, /'github:' \|\| lower\(btrim\(v\."contract" -> 'provenance' ->> 'source\.owner'\)\)/);
  assert.match(sql, /regexp_replace\(lower\(btrim\(v\."contract" -> 'provenance' ->> 'source\.repo'\)\), '\\\.git\$', ''\)/);
  // Deterministic ids and guarded DDL, so a second run changes nothing.
  assert.match(sql, /'wss_' \|\| md5\(/);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "WorkSkillSource"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'skill'/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/);
  // Only live skills are grouped; a deleted one keeps no source.
  assert.match(sql, /s\."deletedAt" IS NULL/);
});

test("the backfill recognises assistants by the keys createAssistant writes", () => {
  const sql = read("prisma/migrations/20260923000000_skill_sources/migration.sql");
  const assistants = read("src/lib/assistants.ts");
  const writer = assistants.slice(assistants.indexOf("export async function createAssistant"));
  assert.match(writer, /icon: input\.avatarIcon/);
  assert.match(writer, /starterPrompts: input\.starterPrompts/);
  assert.match(sql, /\(v\."contract" -> 'icon'\) IS NOT NULL/);
  assert.match(sql, /\(v\."contract" -> 'starterPrompts'\) IS NOT NULL/);
  // And a skill contract can never carry them: it is rebuilt field by field.
  const contractJson = read("src/lib/work/skills.ts");
  const builder = contractJson.slice(contractJson.indexOf("export function skillContractToJson"));
  assert.doesNotMatch(builder.slice(0, builder.indexOf("\n}\n")), /icon|starterPrompts/);
});

test("skill readers never see assistants, and assistant readers never see skills", () => {
  // Every query that lists or invokes skills names the kind. A source-shape
  // assertion, like the security gate's: none of these can run without a
  // database, and a dropped filter is the regression this guards.
  assert.match(read("src/lib/skills/store.ts"), /deletedAt: null, kind: "skill" \} satisfies/);
  assert.match(read("src/app/api/work/skills/route.ts"), /kind: "skill",/);
  assert.match(read("src/lib/chat/skill-runtime.ts"), /deletedAt: null, kind: "skill" \}/);
  const runner = read("scripts/work-runner.ts");
  assert.match(runner, /where: \{ userId, slug, deletedAt: null, kind: "skill" \}/);
  assert.match(runner, /kind: "skill",\n\s+autoSelect: true,/);

  const assistants = read("src/lib/assistants.ts");
  const queries = assistants.match(/prisma\.workSkill\.(findMany|findFirst|updateMany)\(\{\s*where: \{[^}]*\}/g) ?? [];
  assert.ok(queries.length >= 4, "expected the assistant queries to be found");
  for (const query of queries) assert.match(query, /\.\.\.ASSISTANT/, query);
  assert.match(assistants, /trust: "user_authored",\s*\.\.\.ASSISTANT,/);
});

test("chat refuses a version whose verdict this build does not know", async () => {
  // The loader scans a legacy `pending` version before this point (as the Work
  // runner does), so an unknown status here was written by something newer.
  const { applyChatSkill } = await import("@/lib/chat/skills");
  const candidate = {
    id: "skl_1",
    slug: "pdf",
    enabled: true,
    trust: "untrusted",
    autoSelect: false,
    currentVersion: 1,
    projectId: null,
  };
  const outcome = (securityStatus: string) =>
    applyChatSkill({
      slug: "pdf",
      candidates: [candidate],
      version: {
        version: 1,
        instructions: "Read the PDF.",
        contract: emptySkillContract(),
        requestedTools: [],
        securityStatus,
        requiresConsent: false,
      },
      capabilities: { webSearch: false, canvas: false, documents: false, images: false, connectors: [] },
      wrapUntrusted: (_label, content) => content,
    });
  assert.equal(outcome("clear").applied, true);
  assert.equal(outcome("warning").applied, true);
  assert.deepEqual(outcome("pending"), { applied: false, reason: "unscanned" });
  assert.deepEqual(outcome("quarantined"), { applied: false, reason: "unscanned" });
  assert.deepEqual(outcome("blocked"), { applied: false, reason: "blocked" });
});
