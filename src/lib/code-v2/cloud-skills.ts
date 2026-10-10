/**
 * Skills on cloud Code runs (skills lane).
 *
 * A cloud run has no Mac behind it, so its skills are of two kinds:
 *
 *   account  the reader's Alevr skills. The task keeps their library ids
 *            (`CodeTask.skills`); runner-context reads their current
 *            instructions when the runner starts, so an edit made between
 *            dispatch and start still applies.
 *   project  the repository's own `.alevr/skills`, `.juno/skills` and
 *            `.claude/skills`, kept by name. The runner reads them from its
 *            clone (runner/agent-core/src/skills/cloud.ts), by the same rules
 *            the Mac's env server uses.
 *
 * The composer offers both: the account's from `/api/skills`, the
 * repository's from `/api/code/github/skills`.
 */
import { z } from "zod";
import type { CodeSkillChoice } from "./skills";

export const CLOUD_SKILLS_MAX = 20;

export type CloudSkillRef = { source: "account"; id: string; name: string } | { source: "project"; name: string };

const name = z.string().trim().min(1).max(128);

/** The `skills` field of a cloud task's create request. */
export const cloudSkillRefsSchema = z
  .array(
    z.discriminatedUnion("source", [
      z.object({ source: z.literal("account"), id: z.string().trim().min(1).max(200), name }),
      z.object({ source: z.literal("project"), name }),
    ]),
  )
  .max(CLOUD_SKILLS_MAX);

/** A stored `CodeTask.skills`, read defensively (a plain JSON column). */
export function readCloudSkillRefs(value: unknown): CloudSkillRef[] {
  const parsed = cloudSkillRefsSchema.safeParse(value);
  return parsed.success ? dedupeRefs(parsed.data) : [];
}

export function dedupeRefs(refs: readonly CloudSkillRef[]): CloudSkillRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = r.source === "account" ? `account:${r.id}` : `project:${r.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What a cloud message runs under, from the composer's choices: the thread's
 * selection and an armed `/name`. Only account and project skills reach a
 * cloud run (a runner has none of the Mac's own folders).
 */
export function cloudSkillRefs(selected: readonly CodeSkillChoice[], once: CodeSkillChoice | null): CloudSkillRef[] {
  const all = [...selected, ...(once && !selected.some((s) => s.id === once.id) ? [once] : [])];
  const refs: CloudSkillRef[] = [];
  for (const c of all) {
    if (c.source === "account" && c.accountId) refs.push({ source: "account", id: c.accountId, name: c.name });
    else if (c.source === "project") refs.push({ source: "project", name: c.name });
  }
  return dedupeRefs(refs).slice(0, CLOUD_SKILLS_MAX);
}

/** What runner-context hands the runner (runner/agent-core `readCloudSkillRequest`). */
export interface CloudSkillContext {
  account: { name: string; title?: string; instructions: string }[];
  project: string[];
}

/** The subset of Prisma the resolver reads. */
export interface CloudSkillsDb {
  workSkill: {
    findMany(args: {
      where: { userId: string; id: { in: string[] }; deletedAt: null };
      select: { id: true; slug: true; name: true; currentVersion: true };
    }): Promise<{ id: string; slug: string; name: string; currentVersion: number }[]>;
  };
  workSkillVersion: {
    findMany(args: {
      where: { OR: { skillId: string; version: number }[] };
      select: { skillId: true; instructions: true; securityStatus: true };
    }): Promise<{ skillId: string; instructions: string; securityStatus: string }[]>;
  };
}

/**
 * The account skills' instructions, read now for `userId` only: a ref naming
 * another user's skill, a deleted one or a version the scanner blocked is
 * dropped. Project refs pass through by name.
 */
export async function resolveCloudSkillContext(db: CloudSkillsDb, userId: string, refs: readonly CloudSkillRef[]): Promise<CloudSkillContext> {
  const accountRefs = refs.filter((r): r is Extract<CloudSkillRef, { source: "account" }> => r.source === "account");
  const project = refs.filter((r) => r.source === "project").map((r) => r.name);
  if (accountRefs.length === 0) return { account: [], project };
  const rows = await db.workSkill.findMany({
    where: { userId, id: { in: accountRefs.map((r) => r.id) }, deletedAt: null },
    select: { id: true, slug: true, name: true, currentVersion: true },
  });
  const versions = rows.length
    ? await db.workSkillVersion.findMany({
        where: { OR: rows.map((r) => ({ skillId: r.id, version: r.currentVersion })) },
        select: { skillId: true, instructions: true, securityStatus: true },
      })
    : [];
  const account: CloudSkillContext["account"] = [];
  for (const ref of accountRefs) {
    const row = rows.find((r) => r.id === ref.id);
    const version = row && versions.find((v) => v.skillId === row.id);
    const instructions = version?.instructions.trim();
    if (!row || !version || version.securityStatus === "blocked" || !instructions) continue;
    account.push({ name: row.slug, ...(row.name && row.name !== row.slug ? { title: row.name } : {}), instructions });
  }
  return { account, project };
}
