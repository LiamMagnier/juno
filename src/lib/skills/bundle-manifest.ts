/**
 * The parts of a skill bundle that are only data: limits, the manifest shape,
 * path rules and the refusal sentences. No Node built-ins, so client code (the
 * skill's page, the import dialog) and pure modules (`work/skills.ts`) can read
 * a manifest without pulling `node:crypto` into a browser bundle. Building and
 * packing live in `bundle.ts`, which re-exports everything here.
 */

/** At most this many files in one skill folder, SKILL.md included. */
export const MAX_BUNDLE_FILES = 200;
/** Every kept file together, uncompressed. Equal to the package reader's archive cap. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
/** One file. A template or a reference, not a dataset. */
export const MAX_BUNDLE_FILE_BYTES = 2 * 1024 * 1024;
/** A path as the tar can carry it (ustar name + prefix), with room to spare. */
export const MAX_BUNDLE_PATH_CHARS = 240;
/** Version of the manifest shape stored on `WorkSkillVersion.bundleManifest`. */
export const SKILL_BUNDLE_MANIFEST_VERSION = 1;

export type SkillBundleFileKind = "instructions" | "reference" | "script" | "asset";

export interface SkillBundleInputFile {
  /** Relative to the skill's folder, `/`-separated, as the source spelled it. */
  path: string;
  bytes: Uint8Array;
  /** The source said this entry is a symbolic link (zip mode, git tree mode 120000). */
  symlink?: boolean;
}

export interface SkillBundleManifestEntry {
  path: string;
  size: number;
  sha256: string;
  kind: SkillBundleFileKind;
  mime: string;
}

export type SkillBundleSkipReason = "type_not_kept" | "not_text";

export interface SkillBundleManifest {
  version: typeof SKILL_BUNDLE_MANIFEST_VERSION;
  /** sha256 of the tar. Also the object's name in storage. */
  digest: string;
  totalBytes: number;
  files: SkillBundleManifestEntry[];
  /** Files in the folder that were not stored, with the reason. Bounded. */
  skipped: { path: string; reason: SkillBundleSkipReason }[];
}

export interface SkillBundle {
  tar: Uint8Array;
  digest: string;
  manifest: SkillBundleManifest;
}

export type SkillBundleRefusal =
  | "symlink"
  | "unsafe_path"
  | "path_too_long"
  | "duplicate_path"
  | "too_many_files"
  | "file_too_large"
  | "too_large";

export interface SkillBundleProblem {
  reason: SkillBundleRefusal;
  /** The offending path, when one file caused it. */
  path?: string;
}

const MB = 1024 * 1024;

/** A sentence for the reader, naming the file when there is one. */
export function skillBundleRefusalMessage(problem: SkillBundleProblem): string {
  const file = problem.path ? `“${problem.path.slice(0, 120)}”` : "A file";
  switch (problem.reason) {
    case "symlink":
      return `${file} is a symbolic link. A skill folder has to hold its own files, so this skill was not imported.`;
    case "unsafe_path":
      return `${file} points outside the skill's folder (an absolute path or “..”). That is how an archive overwrites files it shouldn't, so this skill was not imported.`;
    case "path_too_long":
      return `${file} has a path longer than ${MAX_BUNDLE_PATH_CHARS} characters, so this skill was not imported.`;
    case "duplicate_path":
      return `${file} appears twice in the archive, so it is unclear which copy is the skill's. This skill was not imported.`;
    case "too_many_files":
      return `This skill's folder holds more than ${MAX_BUNDLE_FILES} files. A skill is instructions, a few references and scripts, so it was not imported.`;
    case "file_too_large":
      return `${file} is larger than ${MAX_BUNDLE_FILE_BYTES / MB} MB. A skill carries templates and references, not datasets, so it was not imported.`;
    case "too_large":
      return `This skill's files add up to more than ${MAX_BUNDLE_BYTES / MB} MB, so it was not imported.`;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A path as a bundle may hold it, or the reason it may not.
 *
 * Checked on the path the SOURCE wrote (`unsafeOriginalName` for a zip), never
 * on a library's normalised copy: normalisation is what turns `x/../SKILL.md`
 * into a plausible `SKILL.md`.
 */
export function checkBundlePath(raw: string): { ok: true; path: string } | { ok: false; reason: "unsafe_path" | "path_too_long" } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "unsafe_path" };
  if (raw.includes("\0") || raw.includes("\\")) return { ok: false, reason: "unsafe_path" };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: "unsafe_path" };
  // A trailing slash is a directory entry, which is not a file and not ours to keep.
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return { ok: false, reason: "unsafe_path" };
    // Control characters in a file name are a terminal escape waiting to be printed.
    for (let i = 0; i < segment.length; i++) {
      const code = segment.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return { ok: false, reason: "unsafe_path" };
    }
  }
  if (raw.length > MAX_BUNDLE_PATH_CHARS || new TextEncoder().encode(raw).byteLength > MAX_BUNDLE_PATH_CHARS) {
    return { ok: false, reason: "path_too_long" };
  }
  return { ok: true, path: raw };
}

/**
 * Entries nobody put in a skill on purpose: macOS resource forks and dotfiles
 * (`.DS_Store`, `.git/`). Skipped without a note, as the package reader always has.
 * `..` is NOT junk: it is checked, and refused, before this is asked.
 */
export function isBundleJunk(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  return path.split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}


/** How many left-out files a manifest lists by name. */
export const MAX_SKIPPED_LISTED = 50;

/** True when anything in the bundle is something the sandbox could execute. */
export function bundleHasScripts(manifest: Pick<SkillBundleManifest, "files"> | null | undefined): boolean {
  return !!manifest?.files.some((file) => file.kind === "script");
}

/** Counts per kind, for a sentence ("3 files, 1 script") and the audit log. */
export function bundleCounts(manifest: Pick<SkillBundleManifest, "files" | "skipped"> | null | undefined): {
  files: number;
  scripts: number;
  references: number;
  assets: number;
  skipped: number;
} {
  const files = manifest?.files ?? [];
  return {
    files: files.length,
    scripts: files.filter((file) => file.kind === "script").length,
    references: files.filter((file) => file.kind === "reference").length,
    assets: files.filter((file) => file.kind === "asset").length,
    skipped: manifest?.skipped.length ?? 0,
  };
}

/** Companion files only: everything but the folder's own SKILL.md. */
export function bundleCompanionFiles(manifest: Pick<SkillBundleManifest, "files"> | null | undefined): SkillBundleManifestEntry[] {
  return (manifest?.files ?? []).filter((file) => file.kind !== "instructions");
}

// ---------------------------------------------------------------------------
// The stored manifest
// ---------------------------------------------------------------------------

const KINDS = new Set<SkillBundleFileKind>(["instructions", "reference", "script", "asset"]);

/**
 * Reads `WorkSkillVersion.bundleManifest` back, or null.
 *
 * A row is JSON written by some build of this code, possibly a newer one; an
 * entry this build cannot read makes the WHOLE manifest unreadable rather than
 * a shorter one, because a manifest missing a script is a manifest that would
 * tell the consent screen there is nothing to review.
 */
export function parseBundleManifest(raw: unknown): SkillBundleManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== SKILL_BUNDLE_MANIFEST_VERSION) return null;
  if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) return null;
  if (!Array.isArray(value.files) || value.files.length > MAX_BUNDLE_FILES) return null;
  const files: SkillBundleManifestEntry[] = [];
  for (const item of value.files) {
    if (!item || typeof item !== "object") return null;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !checkBundlePath(file.path).ok) return null;
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) return null;
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return null;
    if (typeof file.kind !== "string" || !KINDS.has(file.kind as SkillBundleFileKind)) return null;
    files.push({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      kind: file.kind as SkillBundleFileKind,
      mime: typeof file.mime === "string" ? file.mime.slice(0, 120) : "application/octet-stream",
    });
  }
  const skipped: SkillBundleManifest["skipped"] = [];
  if (Array.isArray(value.skipped)) {
    for (const item of value.skipped.slice(0, MAX_SKIPPED_LISTED)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.path !== "string") continue;
      skipped.push({
        path: entry.path.slice(0, MAX_BUNDLE_PATH_CHARS),
        reason: entry.reason === "not_text" ? "not_text" : "type_not_kept",
      });
    }
  }
  const totalBytes = typeof value.totalBytes === "number" && Number.isFinite(value.totalBytes)
    ? value.totalBytes
    : files.reduce((sum, file) => sum + file.size, 0);
  return { version: SKILL_BUNDLE_MANIFEST_VERSION, digest: value.digest, totalBytes, files, skipped };
}

/** Where a user's bundle lives. Outside `uploads/`, so `/api/files` never serves it. */
export function skillBundleObjectKey(userId: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid bundle digest");
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `skill-bundles/${safeUser}/${digest}.tar`;
}

