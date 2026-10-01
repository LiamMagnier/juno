import "server-only";
import JSZip from "jszip";
import type { Readable } from "node:stream";

import { parseSkillMd, type ParsedSkillMd, type SkillMdRefusal, MAX_SKILL_MD_CHARS, serializeSkillMd } from "@/lib/skills/skill-md";
import { instructionsDigest, PROVENANCE_DIGEST_KEY, partitionTools } from "@/lib/skills/sources";
import { emptySkillContract, type WorkSkillContract } from "@/lib/work/skills";

/*
 * Skills that arrive as FILES rather than as a repository: a `SKILL.md`
 * dropped on the page or pasted in, a `.zip` / `.skill` package (claude.ai's
 * distribution channel: one skill folder zipped, or several), or a link to
 * either on any public host.
 *
 * The same rules as the GitHub importer (`src/app/api/skills/import/github`):
 * every file is parsed by the one `parseSkillMd`, every skill lands untrusted
 * and scanned, and the files beside a `SKILL.md` are LISTED, never imported or
 * executed (docs/skills-audit.md §4.3). What differs is only where the bytes
 * come from, recorded in provenance so a skill's page can say "from
 * weekly-report.zip" or "from example.com" instead of nothing.
 */

/** A zip is a stranger's archive: bound what reading it can cost. */
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 2_000;
const MAX_PACKAGE_SKILLS = 50;
/** Every SKILL.md read, together, uncompressed. */
const MAX_TOTAL_SKILL_BYTES = MAX_PACKAGE_SKILLS * (MAX_SKILL_MD_CHARS * 4);

export type PackageOrigin =
  | { kind: "file"; filename: string }
  | { kind: "url"; url: string }
  | { kind: "paste" };

export interface PackageCandidate {
  /** Path inside the package (`SKILL.md` for a single file). The id a choice is made by. */
  path: string;
  directory: string;
  skill: ParsedSkillMd;
  /** Files beside it in its folder, listed and never read. */
  companionFiles: string[];
}

export interface PackageProblem {
  path: string;
  reason: SkillMdRefusal | "unreadable";
}

export type PackageReadResult =
  | { ok: true; candidates: PackageCandidate[]; problems: PackageProblem[]; total: number; more: boolean }
  | { ok: false; reason: PackageRefusal };

export type PackageRefusal = "too_large" | "not_a_package" | "no_skills" | "corrupt_zip" | "zip_too_large";

export const PACKAGE_REFUSAL_MESSAGES: Record<PackageRefusal, string> = {
  too_large: `That file is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB. A skill package is a few Markdown files, not a download.`,
  not_a_package: "That isn't a skill. Upload a SKILL.md, or a .zip or .skill package with a SKILL.md inside.",
  no_skills: "There's no SKILL.md in that package, so there is no skill in it to add.",
  corrupt_zip: "That archive couldn't be opened. Zip the skill's folder again and try once more.",
  zip_too_large: "That archive unpacks to far more than a skill needs, so Juno didn't open it.",
};

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** One SKILL.md given as text (a paste, an uploaded .md, a fetched link). */
export function readSkillMarkdown(text: string): PackageReadResult {
  const parsed = parseSkillMd(text.replace(/^﻿/, ""));
  if (!parsed.ok) {
    return { ok: true, candidates: [], problems: [{ path: "SKILL.md", reason: parsed.reason }], total: 1, more: false };
  }
  return {
    ok: true,
    candidates: [{ path: "SKILL.md", directory: "", skill: parsed.skill, companionFiles: [] }],
    problems: [],
    total: 1,
    more: false,
  };
}

/** Stop inflation at the byte budget, even when ZIP metadata lies. */
function readBoundedEntry(entry: JSZip.JSZipObject, budget: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let length = 0;
    let stopped = false;
    stream.on("data", (chunk: Buffer) => {
      if (stopped) return;
      length += chunk.byteLength;
      if (length > budget) {
        stopped = true;
        stream.destroy();
        reject(new Error("skill_entry_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => { if (!stopped) resolve(Buffer.concat(chunks, length)); });
  });
}

/**
 * Every SKILL.md in a zip, parsed; everything else listed under the skill
 * whose folder holds it. macOS's `__MACOSX` resource forks and dotfiles are
 * not files anybody put there and are skipped.
 */
export async function readSkillZip(bytes: Uint8Array): Promise<PackageReadResult> {
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return { ok: false, reason: "too_large" };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, reason: "corrupt_zip" };
  }
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").some((part) => part.startsWith("."))
  );
  if (entries.length > MAX_PACKAGE_ENTRIES) return { ok: false, reason: "zip_too_large" };

  const skillEntries = entries
    .filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (skillEntries.length === 0) return { ok: false, reason: "no_skills" };

  const candidates: PackageCandidate[] = [];
  const problems: PackageProblem[] = [];
  let bytesRead = 0;
  for (const entry of skillEntries.slice(0, MAX_PACKAGE_SKILLS)) {
    // The size the archive CLAIMS, checked before inflating: a few kilobytes
    // of zip can claim gigabytes, and the check has to happen before the
    // bytes exist, not after.
    const declared = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (declared > MAX_SKILL_MD_CHARS * 4 || bytesRead + declared > MAX_TOTAL_SKILL_BYTES) {
      problems.push({ path: entry.name, reason: "too_large" });
      continue;
    }
    let text: string;
    try {
      const inflated = await readBoundedEntry(entry, Math.min(MAX_SKILL_MD_CHARS * 4, MAX_TOTAL_SKILL_BYTES - bytesRead));
      bytesRead += inflated.byteLength;
      text = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
    } catch (error) {
      problems.push({ path: entry.name, reason: error instanceof Error && error.message === "skill_entry_too_large" ? "too_large" : "unreadable" });
      continue;
    }
    const parsed = parseSkillMd(text.replace(/^﻿/, ""));
    if (!parsed.ok) {
      problems.push({ path: entry.name, reason: parsed.reason });
      continue;
    }
    const directory = dirname(entry.name);
    const prefix = directory ? `${directory}/` : "";
    // A skill folder nested inside this one owns its own files.
    const nested = skillEntries
      .map((other) => dirname(other.name))
      .filter((dir) => dir !== directory && `${dir}/`.startsWith(prefix));
    const companionFiles = entries
      .filter((other) => other !== entry && other.name.startsWith(prefix))
      .filter((other) => !nested.some((dir) => other.name.startsWith(`${dir}/`)))
      .map((other) => other.name.slice(prefix.length))
      .slice(0, 200);
    candidates.push({ path: entry.name, directory, skill: parsed.skill, companionFiles });
  }
  return {
    ok: true,
    candidates,
    problems,
    total: skillEntries.length,
    more: skillEntries.length > MAX_PACKAGE_SKILLS,
  };
}

/** Bytes of unknown kind (an upload, a download): a zip, or a SKILL.md. */
export async function readSkillPackage(bytes: Uint8Array): Promise<PackageReadResult> {
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return { ok: false, reason: "too_large" };
  if (isZipBytes(bytes)) return readSkillZip(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_a_package" };
  }
  if (!/^﻿?\s*---/.test(text)) return { ok: false, reason: "not_a_package" };
  return readSkillMarkdown(text);
}

/** Where a skill came from, as the contract's provenance records it. */
export function packageSkillContract(
  candidate: PackageCandidate,
  origin: PackageOrigin
): { contract: WorkSkillContract; requestedTools: string[]; droppedTools: string[] } {
  const tools = partitionTools(candidate.skill.allowedTools);
  const where: Record<string, string> =
    origin.kind === "file"
      ? { "source.kind": "file", "source.file": origin.filename.slice(0, 200), "source.path": candidate.path }
      : origin.kind === "url"
        ? { "source.kind": "url", "source.url": origin.url.slice(0, 1_000), "source.path": candidate.path }
        : { "source.kind": "paste" };
  const contract: WorkSkillContract = {
    ...emptySkillContract(),
    provenance: {
      ...where,
      [PROVENANCE_DIGEST_KEY]: instructionsDigest(candidate.skill.instructions),
      ...Object.fromEntries(Object.entries(candidate.skill.metadata).map(([key, value]) => [`skill.${key}`, value])),
      ...(candidate.skill.license ? { "skill.license": candidate.skill.license } : {}),
      ...(candidate.skill.compatibility ? { "skill.compatibility": candidate.skill.compatibility } : {}),
    },
  };
  return { contract, requestedTools: tools.carried, droppedTools: tools.dropped };
}

/** How an origin is named on screen: the file, the host, or "Pasted". */
export function originLabel(origin: PackageOrigin): string {
  if (origin.kind === "file") return origin.filename;
  if (origin.kind === "url") {
    try {
      const url = new URL(origin.url);
      const leaf = url.pathname.split("/").filter(Boolean).pop();
      return leaf ? `${url.host}/…/${leaf}` : url.host;
    } catch {
      return origin.url;
    }
  }
  return "Pasted SKILL.md";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function formatSkillMd(skill: {
  slug: string;
  description: string;
  instructions: string;
  requestedTools?: readonly string[];
  provenance?: Record<string, string>;
}): string {
  const metadata = Object.fromEntries(Object.entries(skill.provenance ?? {})
    .filter(([key]) => key.startsWith("skill.") && key !== "skill.license" && key !== "skill.compatibility")
    .map(([key, value]) => [key.slice("skill.".length), value]));
  return serializeSkillMd({
    name: skill.slug,
    description: skill.description.trim() || skill.slug,
    instructions: skill.instructions,
    license: skill.provenance?.["skill.license"],
    compatibility: skill.provenance?.["skill.compatibility"],
    allowedTools: skill.requestedTools,
    metadata,
  });
}
