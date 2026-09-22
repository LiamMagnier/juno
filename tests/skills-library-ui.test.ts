import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LibrarySkill, LibrarySource, SkillLibrary } from "@/lib/skills/library-contract";
import {
  filterLibrary,
  listedSkillCount,
  provenanceSource,
  skillAttention,
  sourceAttention,
  sourceCounts,
  sourceHasUpdate,
  renameProblems,
  skillUsagePatch,
  updateCheckHasChoices,
  updateOutcomeMessage,
} from "@/components/skills/skill-library-model";
import { chatSkillsFromLibrary } from "@/components/chat/use-chat-skills";
import { skillUsage } from "@/components/skills/skill-detail-view";

/*
 * The skills library as the list page and the composer read it: which rows a
 * search leaves, when a folder says "Update available", which skills the
 * composer may offer, and which usage the detail page shows for a stored
 * trust/autoSelect pair.
 */

function skill(id: string, name: string, extra: Partial<LibrarySkill> = {}): LibrarySkill {
  return {
    id,
    projectId: null,
    slug: name.toLowerCase().replace(/ /g, "-"),
    name,
    description: `${name} does its job.`,
    currentVersion: 1,
    enabled: true,
    trust: "untrusted",
    autoSelect: false,
    securityStatus: "clear",
    securityUpdatedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    sourceId: null,
    sourcePath: null,
    requiresConsent: false,
    ...extra,
  };
}

function source(id: string, owner: string, repo: string, skills: LibrarySkill[], extra: Partial<LibrarySource> = {}): LibrarySource {
  return {
    id,
    kind: "github",
    owner,
    repo,
    key: `github:${owner}/${repo}`,
    ref: "main",
    path: "",
    commit: "aaaaaaa",
    latestCommit: null,
    lastCheckedAt: null,
    enabled: true,
    url: `https://github.com/${owner}/${repo}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    skills: skills.map((entry) => ({ ...entry, sourceId: id })),
    ...extra,
  };
}

const library: SkillLibrary = {
  yours: [skill("y1", "Weekly update", { trust: "user_authored" }), skill("y2", "Invoice filing", { enabled: false })],
  sources: [
    source("s1", "anthropics", "skills", [skill("a1", "Pdf"), skill("a2", "Docx", { enabled: false }), skill("a3", "Xlsx")]),
    source("s2", "vercel-labs", "agent-skills", [skill("v1", "React best practices")], { enabled: false }),
  ],
  total: 7,
  truncated: false,
};

test("no query keeps every row and every folder", () => {
  const view = filterLibrary(library, "  ");
  assert.equal(view.searching, false);
  assert.equal(view.yours.length, 2);
  assert.deepEqual(
    view.sources.map((entry) => entry.skills.length),
    [3, 1]
  );
  assert.equal(listedSkillCount(library), 6);
});

test("a skill query leaves only matching skills, in their folders", () => {
  const view = filterLibrary(library, "PDF");
  assert.equal(view.searching, true);
  assert.equal(view.yours.length, 0);
  assert.deepEqual(
    view.sources.map((entry) => [entry.source.id, entry.skills.map((s) => s.id)]),
    [["s1", ["a1"]]]
  );
});

test("a query naming a repository keeps the whole folder", () => {
  const view = filterLibrary(library, "anthropics");
  assert.deepEqual(view.sources.map((entry) => entry.skills.length), [3]);
});

test("a query that matches nothing says so", () => {
  assert.equal(filterLibrary(library, "zzz").empty, true);
  assert.equal(filterLibrary({ yours: [], sources: [], total: 0, truncated: false }, "").empty, true);
});

test("only a different latest commit is an update", () => {
  assert.equal(sourceHasUpdate({ commit: "abc", latestCommit: null }), false);
  assert.equal(sourceHasUpdate({ commit: "abc", latestCommit: "abc" }), false);
  assert.equal(sourceHasUpdate({ commit: "abc", latestCommit: "def" }), true);
});

test("a folder counts its skills and the ones switched on", () => {
  assert.deepEqual(sourceCounts(library.sources[0]), { total: 3, on: 2 });
});

test("blocked outranks waiting for consent", () => {
  assert.equal(skillAttention({ securityStatus: "blocked", requiresConsent: true }), "blocked");
  assert.equal(skillAttention({ securityStatus: "clear", requiresConsent: true }), "consent");
  assert.equal(skillAttention({ securityStatus: "warning", requiresConsent: false }), null);
});

test("a skill waiting for consent marks its row and its folder", () => {
  const waiting = skill("a4", "Mcp builder", { requiresConsent: true });
  assert.equal(skillAttention(waiting), "consent");
  assert.equal(sourceAttention(source("s3", "anthropics", "skills", [skill("a5", "Pdf"), waiting])), true);
  assert.equal(sourceAttention(library.sources[0]), false);
});

test("provenance names a GitHub source only when it has an owner and a repository", () => {
  assert.deepEqual(
    provenanceSource({
      "source.kind": "github",
      "source.owner": "anthropics",
      "source.repo": "skills",
      "source.commit": "abc1234",
    }),
    { owner: "anthropics", repo: "skills", ref: null, commit: "abc1234", path: null, url: null }
  );
  assert.equal(provenanceSource({ "source.kind": "github", "source.owner": "anthropics" }), null);
  // The link is only ever a GitHub page, whatever a contract says.
  const base = { "source.kind": "github", "source.owner": "anthropics", "source.repo": "skills" };
  assert.equal(provenanceSource({ ...base, "source.url": "javascript:alert(1)" })?.url, null);
  assert.equal(provenanceSource({ ...base, "source.url": "https://evil.example/skills" })?.url, null);
  assert.equal(
    provenanceSource({ ...base, "source.url": "https://github.com/anthropics/skills/blob/abc/SKILL.md" })?.url,
    "https://github.com/anthropics/skills/blob/abc/SKILL.md"
  );
  assert.equal(provenanceSource({}), null);
  assert.equal(provenanceSource(null), null);
});

test("the composer offers only what chat can use, yours first, labelled by source", () => {
  const offered = chatSkillsFromLibrary(library);
  assert.deepEqual(
    offered.map((entry) => [entry.id, entry.yours, entry.sourceLabel]),
    [
      ["y1", true, null],
      ["a1", false, "anthropics/skills"],
      ["a3", false, "anthropics/skills"],
    ]
  );
});

test("usage is automatic only for a trusted skill that may be picked", () => {
  assert.equal(skillUsage({ autoSelect: true, trust: "user_authored" }), "auto");
  assert.equal(skillUsage({ autoSelect: true, trust: "untrusted" }), "manual");
  assert.equal(skillUsage({ autoSelect: false, trust: "verified" }), "manual");
});

test("the chat hook asks for the library, and the flat fallback states the route's ceiling", () => {
  const hook = readFileSync(new URL("../src/components/chat/use-chat-skills.ts", import.meta.url), "utf8");
  assert.match(hook, /fetch\("\/api\/skills"\)/);
  assert.match(hook, /\/api\/work\/skills\?enabled=true&limit=200/);
  const work = readFileSync(new URL("../src/components/work/composer-home/use-work-skills.ts", import.meta.url), "utf8");
  assert.match(work, /\/api\/work\/skills\?enabled=true&limit=200/);
});

test("an update check with only new upstream skills still has something to offer", () => {
  const change = (path: string) => ({ path, name: path, description: "" });
  // The server calls this `upToDate` (no installed skill differs), and the
  // dialog used to read that as "nothing to show", hiding the new skills.
  assert.equal(updateCheckHasChoices({ changed: [], added: [change("skills/new/SKILL.md")] }), true);
  assert.equal(updateCheckHasChoices({ changed: [change("skills/pdf/SKILL.md")], added: [] }), true);
  assert.equal(updateCheckHasChoices({ changed: [], added: [] }), false);
});

test("an update's toast words its skip reasons and says when nothing landed", () => {
  const landed = skill("a1", "Pdf");
  const mixed = updateOutcomeMessage(
    {
      updated: [landed],
      installed: [],
      skipped: [
        { path: "a", reason: "up_to_date" },
        { path: "b", reason: "up_to_date" },
        { path: "c", reason: "version_conflict" },
      ],
    },
    "anthropics/skills"
  );
  assert.equal(mixed.ok, true);
  assert.equal(mixed.title, "Updated 1 skill from anthropics/skills");
  assert.equal(
    mixed.description,
    "2 skipped because they were already up to date. 1 skipped because it was being saved somewhere else at the same moment."
  );
  // No code ever reaches the reader, including one this build does not know.
  const unknown = updateOutcomeMessage({ updated: [], installed: [], skipped: [{ path: "a", reason: "brand_new" }] }, "x/y");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.title, "Nothing was updated.");
  assert.doesNotMatch(unknown.description ?? "", /brand_new|_/);
  assert.equal(
    updateOutcomeMessage({ updated: [landed], installed: [skill("a2", "Docx")], skipped: [] }, "x/y").title,
    "Updated 1 and installed 1 from x/y"
  );
  assert.equal(updateOutcomeMessage({ updated: [], installed: [landed], skipped: [] }, "x/y").description, undefined);
});

test("the usage choice trusts on the way in and, for an installed skill, takes it back on the way out", () => {
  const github = { "source.kind": "github", "source.owner": "anthropics", "source.repo": "skills" };
  assert.deepEqual(skillUsagePatch("auto", { trust: "untrusted" }, github), { trust: "user_authored", autoSelect: true });
  // Installed and trusted by this choice: back to how it was installed.
  assert.deepEqual(skillUsagePatch("manual", { trust: "user_authored" }, github), { trust: "untrusted", autoSelect: false });
  // A skill you wrote keeps its trust; a verified one is never downgraded here.
  assert.deepEqual(skillUsagePatch("manual", { trust: "user_authored" }, {}), { autoSelect: false });
  assert.deepEqual(skillUsagePatch("manual", { trust: "verified" }, github), { autoSelect: false });
});

test("an import catches two chosen skills that would install under one slash name", () => {
  const row = (path: string, slug: string, slugTaken = false) => ({ path, slug, installed: false, slugTaken });
  const skills = [row("a/SKILL.md", "pdf", true), row("b/SKILL.md", "skills-pdf"), row("c/SKILL.md", "docx", true)];
  const all = new Set(skills.map((skill) => skill.path));
  // The suggestion collides with another chosen skill's own name.
  assert.deepEqual(
    [...renameProblems(skills, all, { "a/SKILL.md": "skills-pdf", "c/SKILL.md": "skills-docx" })],
    [["a/SKILL.md", "duplicate"]]
  );
  // Two renames to one name; a rename back to the taken name; a name no one can type.
  assert.deepEqual(
    [...renameProblems(skills, all, { "a/SKILL.md": "mine", "c/SKILL.md": "mine" })],
    [
      ["a/SKILL.md", "duplicate"],
      ["c/SKILL.md", "duplicate"],
    ]
  );
  assert.equal(renameProblems(skills, all, { "a/SKILL.md": "pdf", "c/SKILL.md": "d" }).get("a/SKILL.md"), "taken");
  assert.equal(renameProblems(skills, all, { "a/SKILL.md": "PDF tools", "c/SKILL.md": "d" }).get("a/SKILL.md"), "invalid");
  // An unchosen row claims nothing.
  assert.equal(renameProblems(skills, new Set(["a/SKILL.md"]), { "a/SKILL.md": "skills-pdf" }).size, 0);
});
