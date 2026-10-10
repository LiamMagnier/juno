/**
 * Skills on cloud Code runs (skills lane): what the composer sends
 * (`cloudSkillRefs`), what the create route accepts and stores
 * (`cloudSkillRefsSchema`, `readCloudSkillRefs`), what runner-context hands
 * the runner (`resolveCloudSkillContext`: this user's skills only, current
 * text, nothing blocked or deleted), and the repository listing the cloud
 * composer offers (`listRepoSkills`, by the runner's own parser and folders).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudSkillRefs, cloudSkillRefsSchema, readCloudSkillRefs, resolveCloudSkillContext, type CloudSkillsDb } from "@/lib/code-v2/cloud-skills";
import { listRepoSkills } from "@/lib/code-v2/repo-skills";
import { choiceFromAccount, choiceFromLocal } from "@/lib/code-v2/skills";
import { PROJECT_SKILL_DIRS } from "@/lib/code-v2/skill-parse";

const account = choiceFromAccount({ id: "sk_1", slug: "tidy-commits", name: "Tidy commits", description: "Squash fixups" });
const project = choiceFromLocal({ name: "repo-rules", description: "Rules", source: "project", origin: "alevr", path: ".alevr/skills/repo-rules/SKILL.md" });
const mac = choiceFromLocal({ name: "taste", description: "Taste", source: "user", origin: "claude", path: "/Users/me/.claude/skills/taste/SKILL.md" });

test("cloud skills: the composer sends account skills by id and the repository's by name; the Mac's own never reach a runner", () => {
  assert.deepEqual(cloudSkillRefs([account, project, mac], null), [
    { source: "account", id: "sk_1", name: "tidy-commits" },
    { source: "project", name: "repo-rules" },
  ]);
  const armed = choiceFromLocal({ name: "release", description: "", source: "project", origin: "juno", path: ".juno/skills/release/SKILL.md" });
  assert.deepEqual(cloudSkillRefs([account], armed).map((r) => r.name), ["tidy-commits", "release"], "an armed /name rides along");
  assert.deepEqual(cloudSkillRefs([account], account).length, 1, "once");
  assert.deepEqual(cloudSkillRefs([], null), []);
});

test("cloud skills: the create route's schema and the stored column", () => {
  assert.ok(cloudSkillRefsSchema.safeParse([{ source: "account", id: "a", name: "x" }, { source: "project", name: "y" }]).success);
  assert.ok(!cloudSkillRefsSchema.safeParse([{ source: "user", name: "y" }]).success, "a Mac skill is not a cloud skill");
  assert.ok(!cloudSkillRefsSchema.safeParse([{ source: "account", name: "x" }]).success, "an account skill needs its id");
  assert.ok(!cloudSkillRefsSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ source: "project", name: `s${i}` }))).success);
  assert.deepEqual(readCloudSkillRefs(null), []);
  assert.deepEqual(readCloudSkillRefs("junk"), []);
  assert.deepEqual(readCloudSkillRefs([{ source: "project", name: "a" }, { source: "project", name: "A" }, { source: "account", id: "1", name: "t" }, { source: "account", id: "1", name: "t" }]), [
    { source: "project", name: "a" },
    { source: "account", id: "1", name: "t" },
  ]);
});

function fakeDb(): { db: CloudSkillsDb; queries: unknown[] } {
  const skills = [
    { id: "sk_1", userId: "u1", slug: "tidy-commits", name: "Tidy commits", currentVersion: 2, deletedAt: null },
    { id: "sk_2", userId: "u1", slug: "blocked", name: "blocked", currentVersion: 1, deletedAt: null },
    { id: "sk_3", userId: "u2", slug: "theirs", name: "theirs", currentVersion: 1, deletedAt: null },
  ];
  const versions = [
    { skillId: "sk_1", version: 1, instructions: "OLD TEXT", securityStatus: "clear" },
    { skillId: "sk_1", version: 2, instructions: "  CURRENT TEXT  ", securityStatus: "clear" },
    { skillId: "sk_2", version: 1, instructions: "BLOCKED TEXT", securityStatus: "blocked" },
    { skillId: "sk_3", version: 1, instructions: "THEIR TEXT", securityStatus: "clear" },
  ];
  const queries: unknown[] = [];
  const db: CloudSkillsDb = {
    workSkill: {
      async findMany(args) {
        queries.push(args);
        return skills.filter((s) => s.userId === args.where.userId && args.where.id.in.includes(s.id) && s.deletedAt === null);
      },
    },
    workSkillVersion: {
      async findMany(args) {
        queries.push(args);
        return versions.filter((v) => args.where.OR.some((o) => o.skillId === v.skillId && o.version === v.version));
      },
    },
  };
  return { db, queries };
}

test("runner-context: account skills are read now, for this user only, never blocked; project names pass through", async () => {
  const { db } = fakeDb();
  const context = await resolveCloudSkillContext(db, "u1", [
    { source: "account", id: "sk_1", name: "tidy-commits" },
    { source: "account", id: "sk_2", name: "blocked" },
    { source: "account", id: "sk_3", name: "theirs" },
    { source: "account", id: "sk_gone", name: "gone" },
    { source: "project", name: "repo-rules" },
  ]);
  assert.deepEqual(context, {
    account: [{ name: "tidy-commits", title: "Tidy commits", instructions: "CURRENT TEXT" }],
    project: ["repo-rules"],
  });
  const { db: quiet, queries } = fakeDb();
  assert.deepEqual(await resolveCloudSkillContext(quiet, "u1", [{ source: "project", name: "x" }]), { account: [], project: ["x"] });
  assert.equal(queries.length, 0, "no account skills, no queries");
});

test("repo skills: the runner's folders, nearest first, by its parser; names, descriptions and paths only", async () => {
  const tree: Record<string, { name: string; type: string }[]> = {
    ".alevr/skills": [{ name: "repo-rules", type: "dir" }, { name: ".hidden", type: "dir" }, { name: "README.md", type: "file" }],
    ".claude/skills": [{ name: "repo-rules", type: "dir" }, { name: "testing", type: "dir" }, { name: "Bad Name!", type: "dir" }, { name: "empty", type: "dir" }],
  };
  const files: Record<string, string> = {
    ".alevr/skills/repo-rules/SKILL.md": "---\nname: repo-rules\ndescription: The nearest copy\n---\nALEVR BODY",
    ".claude/skills/repo-rules/SKILL.md": "---\nname: repo-rules\ndescription: shadowed\n---\nCLAUDE BODY",
    ".claude/skills/testing/SKILL.md": "---\ndescription: >\n  Write tests\n  first.\n---\nTESTING BODY",
    ".claude/skills/Bad Name!/SKILL.md": "---\nname: ../escape\n---\nX",
  };
  const listed: string[] = [];
  const skills = await listRepoSkills({
    async list(dir) {
      listed.push(dir);
      return tree[dir] ?? null;
    },
    async read(file) {
      return files[file] ?? null;
    },
  });
  assert.deepEqual(listed.sort(), PROJECT_SKILL_DIRS.map((d) => d.dir).sort());
  assert.deepEqual(skills, [
    { name: "repo-rules", description: "The nearest copy", source: "project", origin: "alevr", path: ".alevr/skills/repo-rules/SKILL.md" },
    { name: "testing", description: "Write tests first.", source: "project", origin: "claude", path: ".claude/skills/testing/SKILL.md" },
  ]);
  assert.ok(!JSON.stringify(skills).includes("BODY"));
  // GitHub failing on one folder lists the rest.
  const partial = await listRepoSkills({
    async list(dir) {
      if (dir === ".alevr/skills") throw new Error("502");
      return tree[dir] ?? null;
    },
    async read(file) {
      return files[file] ?? null;
    },
  });
  assert.equal(partial.find((s) => s.name === "repo-rules")?.origin, "claude");
});
