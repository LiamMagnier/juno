/**
 * A skill's folder, kept: the files beside its `SKILL.md`, stored once as a
 * content-addressed tar with a manifest.
 *
 * Until this existed the importers LISTED a skill's companion files and threw
 * the bytes away (docs/skills-audit.md §4.3), so a skill whose method is "read
 * reference/style.md, then run scripts/build.py" could only be described to a
 * model, never carried out. The owner reversed that decision for the tool
 * runtime (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8): the folder is kept, scanned,
 * consented to when it carries scripts and was imported, and mounted READ-ONLY
 * into the same no-network sandbox `run_code` uses. A skill still never widens
 * what a turn may do; keeping its files only lets it do what it says.
 *
 * WHAT IS REFUSED, AND WHY IT IS A REFUSAL RATHER THAN A FILTER. A symlink, an
 * absolute path or a `..` segment is the zip-slip shape: an archive that names
 * a file outside its own folder. Silently dropping the entry would import a
 * skill that looks complete and is not, and JSZip has already resolved `a/../b`
 * to `b` by the time anybody looks, so the entry may have overwritten a sibling.
 * The whole skill is refused with the path that caused it. Oversized bundles are
 * refused for the reason the package reader bounds a zip: this is a stranger's
 * archive held in the web process.
 *
 * WHAT IS LEFT OUT, AND SAID. A file of a type the sandbox has no use for (an
 * executable, a wheel, a nested zip) is not stored and is listed under
 * `skipped`, so the skill's page can say "2 files were not kept" instead of the
 * skill quietly failing later.
 *
 * DETERMINISTIC. Paths sorted, mode 0644, owner 0, mtime 0, no directory
 * entries: the same folder always produces the same bytes, so the digest names
 * the content and an unchanged re-import stores nothing new.
 *
 * Pure apart from `node:crypto`. No `server-only`, no storage, no Prisma: `bundle-store.ts` writes and
 * reads the bytes, and the tests drive everything here directly.
 */

import { createHash } from "node:crypto";

import {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_FILES,
  MAX_SKIPPED_LISTED,
  SKILL_BUNDLE_MANIFEST_VERSION,
  checkBundlePath,
  isBundleJunk,
  type SkillBundle,
  type SkillBundleFileKind,
  type SkillBundleInputFile,
  type SkillBundleManifest,
  type SkillBundleManifestEntry,
  type SkillBundleProblem,
  type SkillBundleSkipReason,
} from "@/lib/skills/bundle-manifest";

export * from "@/lib/skills/bundle-manifest";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

const SCRIPT_EXTENSIONS: Record<string, string> = {
  py: "text/x-python",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/x-typescript",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  r: "text/x-r",
};

const TEXT_EXTENSIONS: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  rst: "text/plain",
  tex: "text/plain",
  json: "application/json",
  jsonl: "application/jsonl",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain",
  cfg: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  xml: "application/xml",
  svg: "image/svg+xml",
  sql: "text/plain",
  j2: "text/plain",
  jinja: "text/plain",
  tmpl: "text/plain",
};

const TEXT_BASENAMES = new Set(["license", "licence", "notice", "readme", "copying", "authors"]);

const ASSET_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** What a file is to the sandbox and the scanner, or why it is not kept. */
export function classifyBundleFile(
  path: string,
  bytes: Uint8Array
): { kind: SkillBundleFileKind; mime: string } | { skip: SkillBundleSkipReason } {
  if (/^skill\.md$/i.test(path)) {
    return isUtf8Text(bytes) ? { kind: "instructions", mime: "text/markdown" } : { skip: "not_text" };
  }
  const extension = extensionOf(path);
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const inScripts = /(^|\/)scripts?\//i.test(path);

  if (SCRIPT_EXTENSIONS[extension]) {
    return isUtf8Text(bytes) ? { kind: "script", mime: SCRIPT_EXTENSIONS[extension] } : { skip: "not_text" };
  }
  if (TEXT_EXTENSIONS[extension] || (extension === "" && TEXT_BASENAMES.has(base))) {
    if (!isUtf8Text(bytes)) return { skip: "not_text" };
    return { kind: "reference", mime: TEXT_EXTENSIONS[extension] ?? "text/plain" };
  }
  if (ASSET_EXTENSIONS[extension]) return { kind: "asset", mime: ASSET_EXTENSIONS[extension] };
  // An extensionless text file with a shebang, or any text under scripts/, is a script.
  if (extension === "" && isUtf8Text(bytes)) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2));
    if (head === "#!" || inScripts) return { kind: "script", mime: "text/plain" };
  }
  return { skip: "type_not_kept" };
}

/**
 * The kind a file would most likely be kept as, from its path alone, or null
 * when it would not be kept. For a preview that has the tree and not the bytes
 * (a GitHub walk); the import classifies the real bytes with `classifyBundleFile`.
 */
export function bundleKindForPath(path: string): SkillBundleFileKind | null {
  if (isBundleJunk(path)) return null;
  if (/^skill\.md$/i.test(path)) return "instructions";
  const extension = extensionOf(path);
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (SCRIPT_EXTENSIONS[extension]) return "script";
  if (TEXT_EXTENSIONS[extension] || (extension === "" && TEXT_BASENAMES.has(base))) return "reference";
  if (ASSET_EXTENSIONS[extension]) return "asset";
  if (extension === "" && /(^|\/)scripts?\//i.test(path)) return "script";
  return null;
}

export function isTextKind(kind: SkillBundleFileKind): boolean {
  return kind !== "asset";
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validates a skill's folder and packs what is kept.
 *
 * Refusals are checked across EVERY entry before anything is packed, so the
 * reason returned is the first one in path order and the same archive always
 * gets the same sentence.
 */
export function buildSkillBundle(
  input: readonly SkillBundleInputFile[]
): { ok: true; bundle: SkillBundle } | { ok: false; problem: SkillBundleProblem } {
  const entries = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  let candidates = 0;
  for (const entry of entries) {
    const checked = checkBundlePath(entry.path);
    if (!checked.ok) return { ok: false, problem: { reason: checked.reason, path: entry.path } };
    if (entry.symlink) return { ok: false, problem: { reason: "symlink", path: entry.path } };
    if (isBundleJunk(entry.path)) continue;
    if (seen.has(entry.path)) return { ok: false, problem: { reason: "duplicate_path", path: entry.path } };
    seen.add(entry.path);
    candidates++;
    if (entry.bytes.byteLength > MAX_BUNDLE_FILE_BYTES) {
      return { ok: false, problem: { reason: "file_too_large", path: entry.path } };
    }
  }
  if (candidates > MAX_BUNDLE_FILES) return { ok: false, problem: { reason: "too_many_files" } };

  const kept: { path: string; bytes: Uint8Array; entry: SkillBundleManifestEntry }[] = [];
  const skipped: SkillBundleManifest["skipped"] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (isBundleJunk(entry.path)) continue;
    const kind = classifyBundleFile(entry.path, entry.bytes);
    if ("skip" in kind) {
      if (skipped.length < MAX_SKIPPED_LISTED) skipped.push({ path: entry.path, reason: kind.skip });
      continue;
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) return { ok: false, problem: { reason: "too_large" } };
    kept.push({
      path: entry.path,
      bytes: entry.bytes,
      entry: {
        path: entry.path,
        size: entry.bytes.byteLength,
        sha256: sha256Hex(entry.bytes),
        kind: kind.kind,
        mime: kind.mime,
      },
    });
  }

  const tar = packTar(kept.map(({ path, bytes }) => ({ path, bytes })));
  const digest = sha256Hex(tar);
  return {
    ok: true,
    bundle: {
      tar,
      digest,
      manifest: {
        version: SKILL_BUNDLE_MANIFEST_VERSION,
        digest,
        totalBytes,
        files: kept.map(({ entry }) => entry),
        skipped,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// tar (ustar), deterministic
// ---------------------------------------------------------------------------

const BLOCK = 512;

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("tar field overflow");
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  // length - 1 digits and a NUL, the form every tar reads.
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** ustar splits a long path into `prefix/name` at a slash. */
function splitTarPath(path: string): { name: string; prefix: string } {
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength <= 100) return { name: path, prefix: "" };
  for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (new TextEncoder().encode(name).byteLength <= 100 && new TextEncoder().encode(prefix).byteLength <= 155) {
      return { name, prefix };
    }
  }
  throw new Error("tar path cannot be split");
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitTarPath(path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  // Checksum field counts as spaces while the sum is taken.
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // '0', a regular file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Packs files (already validated and sorted) into a tar. */
export function packTar(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const blocks = files.reduce((sum, file) => sum + 1 + Math.ceil(file.bytes.byteLength / BLOCK), 2);
  const out = new Uint8Array(blocks * BLOCK);
  let offset = 0;
  for (const file of files) {
    out.set(tarHeader(file.path, file.bytes.byteLength), offset);
    offset += BLOCK;
    out.set(file.bytes, offset);
    offset += Math.ceil(file.bytes.byteLength / BLOCK) * BLOCK;
  }
  return out;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) return Number.NaN;
  return text === "" ? 0 : parseInt(text, 8);
}

/**
 * Reads a bundle tar back into its files.
 *
 * Only what `packTar` writes is accepted: regular files with safe paths, valid
 * checksums and a size inside the bundle limits. Anything else throws, because
 * a stored bundle that does not read the way it was written has been changed
 * by something other than this code.
 */
export function unpackTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let total = 0;
  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (stored !== sum) throw new Error("bundle tar checksum mismatch");
    const type = header[156];
    if (type !== 0x30 && type !== 0) throw new Error("bundle tar holds a non-file entry");
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!checkBundlePath(path).ok) throw new Error("bundle tar holds an unsafe path");
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error("bundle tar entry has an invalid size");
    }
    total += size;
    if (total > MAX_BUNDLE_BYTES || files.size >= MAX_BUNDLE_FILES) throw new Error("bundle tar exceeds its limits");
    offset += BLOCK;
    if (offset + size > tar.byteLength) throw new Error("bundle tar is truncated");
    if (files.has(path)) throw new Error("bundle tar repeats a path");
    files.set(path, tar.slice(offset, offset + size));
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** Verifies a tar against the digest it is stored under. */
export function bundleDigestMatches(tar: Uint8Array, digest: string): boolean {
  return sha256Hex(tar) === digest;
}

/**
 * The scanner's view of a bundle: every file with its kind, and the text of
 * the ones that have text. Built from the packed tar so what is scanned is
 * byte-for-byte what will be mounted.
 */
export function skillBundleScanInput(bundle: Pick<SkillBundle, "tar" | "digest" | "manifest">): {
  digest: string;
  files: { path: string; kind: SkillBundleFileKind; text?: string }[];
} {
  const contents = unpackTar(bundle.tar);
  return {
    digest: bundle.digest,
    files: bundle.manifest.files.map((file) => {
      const bytes = contents.get(file.path);
      return isTextKind(file.kind) && bytes
        ? { path: file.path, kind: file.kind, text: new TextDecoder().decode(bytes) }
        : { path: file.path, kind: file.kind };
    }),
  };
}
