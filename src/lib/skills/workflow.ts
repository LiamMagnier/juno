/**
 * Skills as workflows: what the model is offered, what loading one returns,
 * and how a skill's files are read (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8).
 *
 * The same decisions serve every surface. Chat reaches them through the
 * `use_skill` and `read_skill_file` specs (`src/lib/tools/specs/`), a Work run
 * through `skillToolsFor` (`run-tools.ts`); both are thin shells over the
 * session in `session.ts`, which owns the database and the storage, and over
 * this module, which owns every rule and every sentence.
 *
 * WHAT IS OFFERED. A skill the person armed with `/slug` is applied by the
 * route as before. A skill the MODEL may reach for on its own is one the
 * person opted in to automatic use (`autoSelect`, which a trust floor clamps:
 * an imported skill cannot be auto-selected until the person vouches for it),
 * that is switched on (with its source), clean or warned by the scanner, and
 * filed where this conversation is. At most 30, name and one line each.
 * Whether every user-authored skill is offered too is the owner's decision
 * (design §9.3); `includeUserAuthored` is that switch, off by default.
 *
 * WHAT A SKILL CANNOT DO. Load itself past a refusal: a blocked version, an
 * unscanned one, or one waiting for consent (a widened permission surface, or
 * imported scripts nobody has reviewed) is explained to the model in words it
 * can pass on, and nothing of it is mounted or run. Widen the turn: the tools
 * are the turn's, fixed before the first token, and the sandbox its scripts
 * run in has no network whatever the skill declares.
 *
 * Pure. No `server-only`, no Prisma, no storage.
 */

import {
  coerceSkillTrust,
  skillIsOfferedTo,
  skillSystemSuffix,
  trustPermitsAutoSelection,
  type SkillSelectionVia,
  type WorkSkillContract,
} from "@/lib/work/skills";
import { canonicalSkillToolName, skillBundleNote } from "@/lib/chat/skills";
import {
  bundleCompanionFiles,
  checkBundlePath,
  type SkillBundleManifest,
  type SkillBundleManifestEntry,
} from "@/lib/skills/bundle-manifest";
import { RUN_CODE_TOOL_ID } from "@/lib/tools/types";
import { PRODUCT_NAME } from "@/lib/brand/names";

/** How many skills the model is offered by name. */
export const MAX_DISCOVERABLE_SKILLS = 30;
/** One page of a skill file, in characters. */
export const SKILL_FILE_PAGE_CHARS = 40_000;
/** A description line in the list is cut to this. */
const DESCRIPTION_LINE_CHARS = 160;

/** What a version waits for, read off its stored scan (`securityScan.consentFor`). */
export function consentReasonsOf(scan: unknown): string[] {
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) return [];
  const value = (scan as { consentFor?: unknown }).consentFor;
  return Array.isArray(value) ? value.filter((reason): reason is string => typeof reason === "string") : [];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** A head row as discovery reads it. `enabled` is the skill's switch AND its source's. */
export interface SkillLibraryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  trust: string;
  autoSelect: boolean;
  currentVersion: number;
  projectId: string | null;
  securityStatus: string;
}

export interface SkillDiscoveryPolicy {
  /** Offer every user-authored skill, not only those opted in to automatic use (design §9.3). */
  includeUserAuthored: boolean;
}

export const DEFAULT_SKILL_DISCOVERY_POLICY: SkillDiscoveryPolicy = { includeUserAuthored: false };

/** Whether the model may find this skill on its own in this conversation. */
export function skillIsDiscoverable(
  row: SkillLibraryRow,
  input: { projectId: string | null; policy?: SkillDiscoveryPolicy }
): boolean {
  if (!row.enabled) return false;
  if (row.securityStatus !== "clear" && row.securityStatus !== "warning") return false;
  if (!skillIsOfferedTo(row.projectId, input.projectId)) return false;
  const trust = coerceSkillTrust(row.trust);
  if (row.autoSelect && trustPermitsAutoSelection(trust)) return true;
  return (input.policy ?? DEFAULT_SKILL_DISCOVERY_POLICY).includeUserAuthored && trustPermitsAutoSelection(trust);
}

/** The skills offered to the model, by name, at most `MAX_DISCOVERABLE_SKILLS`. */
export function discoverableSkills<T extends SkillLibraryRow>(
  rows: readonly T[],
  input: { projectId: string | null; policy?: SkillDiscoveryPolicy }
): T[] {
  return rows
    .filter((row) => skillIsDiscoverable(row, input))
    .sort((a, b) => (a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)))
    .slice(0, MAX_DISCOVERABLE_SKILLS);
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "- slug: one line" per skill, for the tool description and the prompt section. */
export function skillListLines(rows: readonly Pick<SkillLibraryRow, "slug" | "description" | "name">[]): string {
  return rows.map((row) => `- ${row.slug}: ${oneLine(row.description || row.name, DESCRIPTION_LINE_CHARS)}`).join("\n");
}

/** The `use_skill` description: what it does, when to use it, and the list. */
export function skillToolDescription(rows: readonly Pick<SkillLibraryRow, "slug" | "description" | "name">[]): string {
  const list = rows.length > 0 ? `\n\nSkills available in this conversation:\n${skillListLines(rows)}` : "";
  return (
    "Load one of the person's skills: a saved method (instructions, and sometimes reference files and scripts) " +
    "for a kind of task. Call it when a task matches a skill's description below, BEFORE doing the task, then " +
    "follow what it returns. Pass the skill's name exactly as listed. It returns the skill's instructions and a " +
    "list of its files; read those with read_skill_file and run its scripts with run_code when you have it. " +
    "Do not call it for a skill that is not listed, and do not load a skill that does not fit the request." +
    list
  );
}

/**
 * The short system-prompt section the provider contributes: the skills on
 * offer, and for an armed skill with a folder, what is in it and whether its
 * scripts can run on this turn (the one place that is said; see
 * `applyChatSkill`).
 */
export function skillsPromptSection(input: {
  rows: readonly Pick<SkillLibraryRow, "slug" | "description" | "name">[];
  armed?: { slug: string; manifest: Pick<SkillBundleManifest, "files"> | null | undefined } | null;
  code: boolean | "unknown";
  skillFiles: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (input.rows.length > 0) {
    parts.push(
      `The person keeps skills: saved methods for kinds of task. When a request matches one, call use_skill with its name first, then follow it.\n${skillListLines(input.rows)}`
    );
  }
  if (input.armed) {
    const note = skillBundleNote({ slug: input.armed.slug, manifest: input.armed.manifest, code: input.code, skillFiles: input.skillFiles });
    if (note) parts.push(`About the /${input.armed.slug} skill in force for this request: ${note}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The listed (or armed) skill a model's `name` means: the slug exactly (a
 * leading slash and case forgiven), else the display name. Nothing else: a
 * model guessing at a skill that is not offered is told so, not matched.
 */
export function findSkillByName<T extends Pick<SkillLibraryRow, "slug" | "name">>(name: string, rows: readonly T[]): T | null {
  const wanted = name.trim().replace(/^\/+/, "").toLowerCase();
  if (!wanted) return null;
  return (
    rows.find((row) => row.slug.toLowerCase() === wanted) ??
    rows.find((row) => row.name.trim().toLowerCase() === wanted) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The version a turn loads, with everything that can refuse it. */
export interface SkillVersionForUse {
  id: string;
  version: number;
  instructions: string;
  contract: WorkSkillContract;
  requestedTools: readonly string[];
  securityStatus: string;
  requiresConsent: boolean;
  consentFor: readonly string[];
  bundle: { key: string; digest: string; manifest: SkillBundleManifest } | null;
}

export type SkillLoadRefusal = "missing_version" | "blocked" | "unscanned" | "consent_required" | "scripts_unreviewed";

/** Why this version may not be loaded, or null. The order matches `applyChatSkill`. */
export function skillLoadRefusal(version: SkillVersionForUse | null): SkillLoadRefusal | null {
  if (!version) return "missing_version";
  if (version.securityStatus === "blocked") return "blocked";
  if (version.securityStatus !== "clear" && version.securityStatus !== "warning") return "unscanned";
  if (version.requiresConsent) return version.consentFor.includes("scripts") ? "scripts_unreviewed" : "consent_required";
  return null;
}

/**
 * A refusal in words the model can pass on. Nothing was loaded, mounted or
 * run, and the sentence says so, so a turn cannot report a skill's output it
 * never had.
 */
export function skillLoadRefusalText(row: Pick<SkillLibraryRow, "slug" | "name">, reason: SkillLoadRefusal): string {
  const name = row.name || row.slug;
  const open = `Tell the person to open Skills → ${name} in ${PRODUCT_NAME}`;
  switch (reason) {
    case "scripts_unreviewed":
      return (
        `The ${name} skill was not loaded. It was imported with scripts that nobody has reviewed yet, so none of ` +
        `its instructions were read and none of its scripts ran. ${open}, read its files and approve them; until ` +
        `then, do the task without it and say that the skill could not be used.`
      );
    case "consent_required":
      return (
        `The ${name} skill was not loaded: its current version asks for more than the version the person approved. ` +
        `${open} and review what changed. Do the task without it and say so.`
      );
    case "blocked":
      return `The ${name} skill was not loaded: ${PRODUCT_NAME}'s scanner refused its current version. ${open} to see why. Do the task without it and say so.`;
    case "unscanned":
      return `The ${name} skill was not loaded: ${PRODUCT_NAME} could not confirm its current version is safe to use. ${open} to check it. Do the task without it and say so.`;
    case "missing_version":
      return `The ${name} skill could not be loaded because its current version is missing. Do the task without it and say so.`;
  }
}

/**
 * What loading a skill returns to the model: its instructions (inside the
 * untrusted-content envelope when nobody has vouched for it, through the same
 * `skillSystemSuffix` every surface uses), what its folder holds and what may
 * be done with it on this turn, and a note when the skill asks for code
 * execution the turn does not have.
 */
export function skillLoadResult(input: {
  row: Pick<SkillLibraryRow, "slug" | "trust">;
  version: Pick<SkillVersionForUse, "version" | "instructions" | "requestedTools" | "bundle">;
  via: SkillSelectionVia;
  code: boolean | "unknown";
  skillFiles: boolean;
  wrapUntrusted: (label: string, content: string) => string;
}): { text: string; untrusted: boolean } {
  const block = skillSystemSuffix({
    slug: input.row.slug,
    version: input.version.version,
    trust: input.row.trust,
    via: input.via,
    instructions: input.version.instructions,
    wrapUntrusted: input.wrapUntrusted,
  });
  const wantsCode = input.version.requestedTools.some((tool) => canonicalSkillToolName(tool) === RUN_CODE_TOOL_ID);
  const codeNote =
    wantsCode && input.code === false
      ? "This skill expects to run code, and this conversation cannot run code. Do the steps you can, and say plainly which ones you could not carry out."
      : null;
  const bundleNote = skillBundleNote({
    slug: input.row.slug,
    manifest: input.version.bundle?.manifest,
    code: input.code,
    skillFiles: input.skillFiles,
  });
  return {
    text: [block.systemSuffix, codeNote, bundleNote].filter(Boolean).join("\n\n"),
    untrusted: block.untrusted,
  };
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

export type ReadSkillFileResult =
  | { ok: true; text: string; body: string; nextOffset: number | null; entry: SkillBundleManifestEntry | null }
  | { ok: false; code: "not_found" | "invalid_args"; text: string };

/**
 * A bundle path as the model may write it: relative to the skill's folder, or
 * through its mount (`/skills/<slug>/…`), or with a leading `./`.
 */
export function normalizeSkillFilePath(slug: string, raw: string): string | null {
  let path = raw.trim();
  const mount = `/skills/${slug}/`;
  if (path.startsWith(mount)) path = path.slice(mount.length);
  while (path.startsWith("./")) path = path.slice(2);
  const checked = checkBundlePath(path);
  return checked.ok ? checked.path : null;
}

function listing(manifest: Pick<SkillBundleManifest, "files"> | null | undefined): string {
  const files = bundleCompanionFiles(manifest);
  if (files.length === 0) return "This skill keeps no files beside its instructions.";
  return `Its files: ${files.slice(0, 40).map((file) => file.path).join(", ")}${files.length > 40 ? ", …" : ""}.`;
}

/**
 * One page of one of a skill's files.
 *
 * `SKILL.md` returns the loaded version's instructions, not the folder's copy:
 * an edit to the instructions keeps the folder, and the model must never be
 * shown two disagreeing copies of the method. A binary asset is described (its
 * type, size and mount path), not dumped. Text from a skill nobody vouched for
 * is enveloped, exactly as its instructions are.
 */
export function readSkillFilePage(input: {
  row: Pick<SkillLibraryRow, "slug" | "trust">;
  version: Pick<SkillVersionForUse, "version" | "instructions" | "bundle">;
  path: string;
  offset?: number;
  /** The file's bytes, from the verified bundle; null when the path is SKILL.md or an asset. */
  contents: Uint8Array | null;
  /** Whether the skill's folder is mounted for this turn's runs. */
  code: boolean;
  wrapUntrusted: (label: string, content: string) => string;
}): ReadSkillFileResult {
  const { slug } = input.row;
  const path = normalizeSkillFilePath(slug, input.path);
  if (!path) {
    return { ok: false, code: "invalid_args", text: `“${input.path.slice(0, 120)}” is not a path inside the ${slug} skill. Nothing was read. ${listing(input.version.bundle?.manifest)}` };
  }
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const untrusted = coerceSkillTrust(input.row.trust) === "untrusted";
  const label = `file ${path} of imported skill ${slug} v${input.version.version}`;

  let text: string;
  let entry: SkillBundleManifestEntry | null = null;
  if (/^skill\.md$/i.test(path)) {
    text = input.version.instructions;
  } else {
    entry = input.version.bundle?.manifest.files.find((file) => file.path === path) ?? null;
    if (!entry) {
      return { ok: false, code: "not_found", text: `The ${slug} skill has no file “${path}”. Nothing was read. ${listing(input.version.bundle?.manifest)}` };
    }
    if (entry.kind === "asset") {
      const where = input.code ? ` Scripts can open it at /skills/${slug}/${path}.` : "";
      const body = `${path} is a binary file (${entry.mime}, ${entry.size} bytes), so it cannot be shown as text.${where}`;
      return { ok: true, text: body, body, nextOffset: null, entry };
    }
    if (!input.contents) {
      return { ok: false, code: "not_found", text: `The ${slug} skill's file “${path}” could not be read right now. Nothing was read.` };
    }
    text = new TextDecoder().decode(input.contents);
  }

  if (offset > 0 && offset >= text.length) {
    const body = `${path} has ${text.length} characters; offset ${offset} is past the end.`;
    return { ok: true, text: body, body, nextOffset: null, entry };
  }
  const page = text.slice(offset, offset + SKILL_FILE_PAGE_CHARS);
  const end = offset + page.length;
  const nextOffset = end < text.length ? end : null;
  const header = `${path} (${text.length} characters${offset > 0 || nextOffset !== null ? `, showing ${offset}–${end}` : ""})`;
  const more = nextOffset !== null ? `\n\n[More of this file: call read_skill_file again with offset ${nextOffset}.]` : "";
  return {
    ok: true,
    text: `${header}\n\n${untrusted ? input.wrapUntrusted(label, page) : page}${more}`,
    body: `${header}\n\n${page}${more}`,
    nextOffset,
    entry,
  };
}
