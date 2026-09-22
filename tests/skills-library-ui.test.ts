import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LibrarySkill, LibrarySource, SkillLibrary } from "@/lib/skills/library-contract";
import {
  filterLibrary,
  listedSkillCount,
  provenanceSource,
  skillAttention,
  sourceCounts,
  sourceHasUpdate,
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
  assert.equal(skillAttention({ securityStatus: "warning" }), null);
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
