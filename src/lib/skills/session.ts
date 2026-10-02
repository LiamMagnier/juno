/**
 * The skill tools for one turn: the database and storage half of
 * `workflow.ts`, shared by chat (`tool-provider.ts`, the `use_skill` and
 * `read_skill_file` specs) and Work runs (`run-tools.ts`).
 *
 * Opened once per turn. It reads the person's skill library once (one indexed
 * query) to decide what is offered, and keeps per turn: the skills loaded so
 * far (so `read_skill_file` works on them without another lookup), a verified
 * copy of each loaded bundle (so ten reads of one skill's files are one
 * storage read), and the mounts registered for the sandbox session.
 *
 * Every refusal is an outcome, never an exception: a turn whose skill could
 * not be loaded still has a request to answer, and the model is told why in
 * words it can pass on.
 */

import "server-only";

import { prisma } from "@/lib/prisma";
import { recordWorkAudit } from "@/lib/work/audit";
import type { WorkActor } from "@/lib/work/domain";
import { scanSkillVersion } from "@/lib/work/skill-security";
import { parseRequestedTools, parseSkillContract } from "@/lib/work/skills";
import { AVAILABLE_SKILL_WHERE } from "@/lib/skills/sources";
import { parseBundleManifest } from "@/lib/skills/bundle-manifest";
import { unpackTar } from "@/lib/skills/bundle";
import { loadSkillBundleTar } from "@/lib/skills/bundle-store";
import { skillMountFor } from "@/lib/skills/mount";
import { clearSkillMounts, mountSkill } from "@/lib/exec/mounts";
import {
  consentReasonsOf,
  discoverableSkills,
  findSkillByName,
  normalizeSkillFilePath,
  readSkillFilePage,
  skillsPromptSection,
  skillLoadRefusal,
  skillLoadRefusalText,
  skillLoadResult,
  type SkillDiscoveryPolicy,
  type SkillLibraryRow,
  type SkillVersionForUse,
} from "@/lib/skills/workflow";
import type { ToolOutcome } from "@/lib/tools/types";

/** How many head rows discovery reads before it decides. Ordered, so stable. */
const LIBRARY_READ_LIMIT = 200;

export interface SkillToolSessionInput {
  userId: string;
  surface: "chat" | "work" | "voice";
  /** The chat generation id or the Work run id: also the sandbox session. */
  sessionId: string;
  projectId: string | null;
  /** The skill the person armed (`/slug`), or the one a Work run already applied. */
  armedSlug?: string | null;
  /**
   * Whether `run_code` is on this turn, when the caller knows (`"unknown"`
   * when it does not; see `skillBundleNote`). A loaded skill's folder is
   * mounted unless this is `false`: a mount is read only by a `run_code` call,
   * so mounting on a turn without one costs nothing and claims nothing.
   */
  code: boolean | "unknown";
  /** `read_skill_file` is on this turn. */
  skillFiles: boolean;
  policy?: SkillDiscoveryPolicy;
  wrapUntrusted: (label: string, content: string) => string;
  /** Who is acting, for the audit row. */
  actor: WorkActor;
  /** Joins a `skill_applied` row to the answer it shaped. */
  generationId?: string | null;
  /** Test seams. */
  deps?: {
    loadTar?: (columns: { bundleKey: string; bundleDigest: string }) => Promise<Uint8Array>;
  };
}

export interface LoadedSkill {
  row: SkillLibraryRow;
  version: SkillVersionForUse;
  via: "slash" | "automatic";
  mounted: boolean;
}

export interface SkillToolSession {
  sessionId: string;
  /** The skills offered to the model by name (discovery), armed skill excluded. */
  offered: readonly SkillLibraryRow[];
  /** The armed skill, when it loaded cleanly. */
  armed: LoadedSkill | null;
  promptSection: string | undefined;
  /** Nothing to offer and nothing armed: the provider says `nothing_to_offer`. */
  empty: boolean;
  loadSkill(name: string): Promise<ToolOutcome>;
  readSkillFile(args: { skill: string; path: string; offset?: number }): Promise<ToolOutcome>;
  /** Skills loaded so far this turn. */
  loaded(): LoadedSkill[];
  close(): Promise<void>;
}

const LIBRARY_COLUMNS = {
  id: true,
  slug: true,
  name: true,
  description: true,
  enabled: true,
  trust: true,
  autoSelect: true,
  currentVersion: true,
  projectId: true,
  securityStatus: true,
} as const;

async function readVersion(skillId: string, version: number, row: SkillLibraryRow): Promise<SkillVersionForUse | null> {
  const found = await prisma.workSkillVersion.findUnique({
    where: { skillId_version: { skillId, version } },
    select: {
      id: true,
      version: true,
      instructions: true,
      contract: true,
      requestedTools: true,
      securityStatus: true,
      securityScan: true,
      requiresConsent: true,
      bundleKey: true,
      bundleDigest: true,
      bundleManifest: true,
    },
  });
  if (!found) return null;
  const contract = parseSkillContract(found.contract);
  const requestedTools = parseRequestedTools(found.requestedTools);
  // A version from before the scanner reads `pending`: scanned here, as chat
  // and the Work runner do at their own boundary, never let through unread.
  const securityStatus =
    found.securityStatus === "pending"
      ? scanSkillVersion({ name: row.name, description: row.description, instructions: found.instructions, requestedTools, contract }).status
      : found.securityStatus;
  const manifest = found.bundleDigest ? parseBundleManifest(found.bundleManifest) : null;
  return {
    id: found.id,
    version: found.version,
    instructions: found.instructions,
    contract,
    requestedTools,
    securityStatus,
    requiresConsent: found.requiresConsent,
    consentFor: consentReasonsOf(found.securityScan),
    bundle:
      found.bundleKey && found.bundleDigest && manifest && manifest.digest === found.bundleDigest
        ? { key: found.bundleKey, digest: found.bundleDigest, manifest }
        : null,
  };
}

function refused(text: string, code: "not_permitted" | "invalid_args" | "unavailable" | "blocked"): ToolOutcome {
  return { status: "failed", text, body: text, error: { code } };
}

/** Opens the skill tools for one turn. */
export async function openSkillToolSession(input: SkillToolSessionInput): Promise<SkillToolSession> {
  const loadTar = input.deps?.loadTar ?? loadSkillBundleTar;
  const rows = await prisma.workSkill.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      kind: "skill",
      // Every available skill, wherever it is filed: an armed skill reaches the
      // whole library (a slash invocation always has), and discovery applies
      // `skillIsOfferedTo` itself.
      ...AVAILABLE_SKILL_WHERE,
    },
    select: LIBRARY_COLUMNS,
    orderBy: { slug: "asc" },
    take: LIBRARY_READ_LIMIT,
  });
  // `AVAILABLE_SKILL_WHERE` already required the skill AND its source to be on.
  const library: SkillLibraryRow[] = rows.map((row) => ({ ...row, enabled: true }));
  const offered = discoverableSkills(library, { projectId: input.projectId, policy: input.policy });

  const loaded = new Map<string, LoadedSkill>();
  const tars = new Map<string, Promise<Map<string, Uint8Array>>>();

  const mount = (row: SkillLibraryRow, version: SkillVersionForUse): boolean => {
    if (input.code === false || !version.bundle) return false;
    return mountSkill(
      input.surface,
      input.sessionId,
      skillMountFor({
        slug: row.slug,
        skillVersionId: version.id,
        bundleKey: version.bundle.key,
        bundleDigest: version.bundle.digest,
        load: loadTar,
      })
    );
  };

  // The armed skill: the route applied its instructions already (and audited
  // that); here it only becomes readable and, when it has a folder, mounted.
  // It is looked up by slug across the account's whole available library, as a
  // slash invocation always has been, not only among the offered.
  let armed: LoadedSkill | null = null;
  if (input.armedSlug) {
    // Past the library read's cap, the armed skill is looked up on its own.
    const row =
      library.find((candidate) => candidate.slug === input.armedSlug) ??
      (await prisma.workSkill
        .findFirst({
          where: { userId: input.userId, slug: input.armedSlug, deletedAt: null, kind: "skill", ...AVAILABLE_SKILL_WHERE },
          select: LIBRARY_COLUMNS,
        })
        .then((found) => (found ? { ...found, enabled: true } : null)));
    if (row) {
      const version = await readVersion(row.id, row.currentVersion, row);
      if (version && skillLoadRefusal(version) === null) {
        armed = { row, version, via: "slash", mounted: mount(row, version) };
        loaded.set(row.slug, armed);
      }
    }
  }

  const filesOf = (skill: LoadedSkill): Promise<Map<string, Uint8Array>> => {
    const bundle = skill.version.bundle;
    if (!bundle) return Promise.resolve(new Map());
    let pending = tars.get(bundle.digest);
    if (!pending) {
      pending = loadTar({ bundleKey: bundle.key, bundleDigest: bundle.digest }).then(unpackTar);
      pending.catch(() => tars.delete(bundle.digest));
      tars.set(bundle.digest, pending);
    }
    return pending;
  };

  return {
    sessionId: input.sessionId,
    offered,
    armed,
    promptSection: skillsPromptSection({
      rows: offered.filter((row) => row.slug !== armed?.row.slug),
      armed: armed ? { slug: armed.row.slug, manifest: armed.version.bundle?.manifest } : null,
      code: input.code,
      skillFiles: input.skillFiles,
    }),
    empty: offered.length === 0 && !armed,

    async loadSkill(name) {
      const already = findSkillByName(name, [...loaded.values()].map((skill) => skill.row));
      if (already) {
        const skill = loaded.get(already.slug)!;
        const text = `The ${already.slug} skill is already loaded in this conversation turn; follow the instructions it returned.${
          skill.version.bundle ? ` Read its files with read_skill_file (skill: "${already.slug}").` : ""
        }`;
        return { status: "succeeded", text, body: text };
      }
      const row = findSkillByName(name, offered);
      if (!row) {
        const list = offered.map((candidate) => candidate.slug).join(", ");
        return refused(
          `There is no skill called “${name.slice(0, 80)}” available in this conversation. Nothing was loaded.${
            list ? ` Available: ${list}.` : " No skills are available for automatic use here."
          }`,
          "invalid_args"
        );
      }
      const version = await readVersion(row.id, row.currentVersion, row);
      const refusal = skillLoadRefusal(version);
      if (refusal || !version) {
        void recordWorkAudit({
          userId: input.userId,
          kind: "skill_applied",
          actor: input.actor,
          severity: "warning",
          detail: { skillSlug: row.slug, outcome: refusal ?? "missing_version", action: "use_skill", generationId: input.generationId ?? undefined },
        });
        return refused(skillLoadRefusalText(row, refusal ?? "missing_version"), refusal === "blocked" ? "blocked" : "not_permitted");
      }
      const skill: LoadedSkill = { row, version, via: "automatic", mounted: mount(row, version) };
      loaded.set(row.slug, skill);
      const result = skillLoadResult({
        row,
        version,
        via: "automatic",
        code: input.code,
        skillFiles: input.skillFiles,
        wrapUntrusted: input.wrapUntrusted,
      });
      const body = skillLoadResult({
        row,
        version,
        via: "automatic",
        code: input.code,
        skillFiles: input.skillFiles,
        wrapUntrusted: (_label, content) => content,
      }).text;
      void recordWorkAudit({
        userId: input.userId,
        kind: "skill_applied",
        actor: input.actor,
        severity: "info",
        detail: {
          skillId: row.id,
          skillSlug: row.slug,
          skillVersion: version.version,
          untrusted: result.untrusted,
          action: "use_skill",
          generationId: input.generationId ?? undefined,
          ...(version.bundle ? { contentHash: version.bundle.digest, fileCount: version.bundle.manifest.files.length } : {}),
        },
      });
      return { status: "succeeded", text: result.text, body };
    },

    async readSkillFile(args) {
      const known = findSkillByName(args.skill, [...loaded.values()].map((skill) => skill.row));
      if (!known) {
        const offeredRow = findSkillByName(args.skill, offered);
        return refused(
          offeredRow
            ? `Load the ${offeredRow.slug} skill with use_skill before reading its files. Nothing was read.`
            : `No skill called “${args.skill.slice(0, 80)}” is loaded in this conversation. Nothing was read.`,
          "invalid_args"
        );
      }
      const skill = loaded.get(known.slug)!;
      let contents: Uint8Array | null = null;
      const path = normalizeSkillFilePath(known.slug, args.path);
      const entry = path ? skill.version.bundle?.manifest.files.find((file) => file.path === path) : undefined;
      if (entry && entry.kind !== "asset" && entry.kind !== "instructions") {
        try {
          contents = (await filesOf(skill)).get(entry.path) ?? null;
        } catch {
          return refused(`The ${known.slug} skill's files could not be read right now. Nothing was read; try again, or continue without them and say so.`, "unavailable");
        }
      }
      const page = readSkillFilePage({
        row: skill.row,
        version: skill.version,
        path: args.path,
        offset: args.offset,
        contents,
        code: skill.mounted,
        wrapUntrusted: input.wrapUntrusted,
      });
      // A path that is not there is the model's to fix, like any invalid argument.
      if (!page.ok) return refused(page.text, "invalid_args");
      return { status: "succeeded", text: page.text, body: page.body };
    },

    loaded() {
      return [...loaded.values()];
    },

    async close() {
      clearSkillMounts(input.surface, input.sessionId);
      tars.clear();
    },
  };
}
