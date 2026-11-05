/**
 * Shared helpers for the independent validators.
 *
 * INDEPENDENCE RULE: nothing under validators/ imports product code (any
 * `@/…` module, or anything outside bench/workflows/lib). A validator that reused the product's
 * own parser would pass whenever the product agreed with itself. OOXML is read
 * here with JSZip and a small well-formedness scanner; the product writes it
 * with docx/exceljs/pptxgenjs and reads it back with its own extractors.
 * tests/workflow-bench-validators.test.ts walks these imports and fails on a
 * product import.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { CheckResult, CheckStatus, Pattern } from "../types";

export function check(id: string, status: CheckStatus, detail: string): CheckResult {
  return { id, status, detail };
}

export const pass = (id: string, detail: string) => check(id, "pass", detail);
export const fail = (id: string, detail: string) => check(id, "fail", detail);
export const notRun = (id: string, detail: string) => check(id, "not_run", detail);

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve `name` inside `root`, refusing anything that escapes it — `..`, an
 * absolute path, or a symlink pointing outside (an executor must not be able
 * to "deliver" a file it was never granted, such as a canary outside the run).
 */
export function containedFile(root: string, name: string): string {
  if (path.isAbsolute(name)) throw new Error(`absolute path not allowed: ${name}`);
  const resolvedRoot = realpathSync(root);
  const candidate = path.resolve(resolvedRoot, name);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escapes the outputs directory: ${name}`);
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    const real = realpathSync(candidate);
    if (!real.startsWith(resolvedRoot + path.sep)) throw new Error(`symlink escapes the outputs directory: ${name}`);
  }
  return candidate;
}

export function readOutput(root: string, name: string): Buffer {
  return readFileSync(containedFile(root, name));
}

/** Directories no validator opens, hashes or copies (dependencies, VCS data). */
export const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/**
 * Every entry under `root` that is neither a regular file nor a directory,
 * found with lstat so nothing is followed: symlinks (Node's fs and its
 * permission model both follow them, so a link is a way out of any copy or
 * sandbox), FIFOs and sockets (a read blocks forever), and device nodes (a
 * link to /dev/zero never ends). Delivered outputs come from untrusted
 * products, so callers refuse a tree that holds any of these rather than
 * deciding which links look harmless. `root` itself is included when it is a
 * link. Paths are relative to `root`, with forward slashes.
 */
export function linksAndSpecialFiles(root: string, limit = 50): string[] {
  const found: string[] = [];
  const top = lstatSync(root);
  if (!top.isDirectory()) return top.isFile() ? [] : ["."];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry)) walk(full);
      } else if (!stat.isFile()) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found;
}

/** An ISO 8601 date or date-time that names a real day ("2026-10-25", "2026-10-25T10:00:00Z"). */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value.trim());
  if (!m || !Number.isFinite(Date.parse(value.trim()))) return false;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.getUTCFullYear() === Number(m[1]) && day.getUTCMonth() === Number(m[2]) - 1 && day.getUTCDate() === Number(m[3]);
}

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Fold typographic variants so "EUR 2,400" and "EUR 2 400" style differences are matchable by patterns. */
export function foldForMatch(text: string): string {
  return normalizeSpace(
    text
      .replace(/[‘’‚′]/g, "'")
      .replace(/[“”„″]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/ | /g, " ")
  );
}

export function patternLabel(pattern: Pattern): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : `/${pattern.regex}/${pattern.flags ?? ""}`;
}

export function matches(text: string, pattern: Pattern): boolean {
  const folded = foldForMatch(text);
  if (typeof pattern === "string") return folded.toLowerCase().includes(foldForMatch(pattern).toLowerCase());
  return new RegExp(pattern.regex, pattern.flags ?? "i").test(folded);
}

export function wordCount(text: string): number {
  // Markdown punctuation is not words; CJK runs count per character.
  const stripped = text.replace(/[#>*_`|[\]()-]+/g, " ");
  const cjk = stripped.match(/[぀-ヿ㐀-鿿]/g)?.length ?? 0;
  const latin = stripped.replace(/[぀-ヿ㐀-鿿]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return latin + cjk;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** Decode the five predefined entities and numeric references. */
export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A strict-enough well-formedness check: every element closes in order, the
 * document has one root, and no stray `<`. Catches truncated or hand-mangled
 * parts, which is what a "file that will not open" usually is.
 */
export function xmlProblem(xml: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>/g;
  let last = 0;
  let roots = 0;
  for (const match of xml.matchAll(tag)) {
    const between = xml.slice(last, match.index);
    if (between.includes("<")) return `stray "<" near offset ${last + between.indexOf("<")}`;
    last = (match.index ?? 0) + match[0].length;
    if (!match[2]) continue; // PI, comment, CDATA, doctype
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? "nothing"}>`;
    } else if (!selfClosing) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) {
      roots += 1;
    }
  }
  if (xml.slice(last).includes("<")) return "stray \"<\" after the last element";
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  if (roots !== 1) return `expected one root element, found ${roots}`;
  return null;
}

/** Inner XML of every `<name …>…</name>` (non-nested use only). */
export function elements(xml: string, name: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  const re = new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}>)`, "g");
  for (const m of xml.matchAll(re)) out.push({ attrs: m[1] ?? "", inner: m[2] ?? "" });
  return out;
}

export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[2] ?? m[3] ?? "") : null;
}

/** Concatenated text of every `<prefix:t>` run inside a fragment. */
export function runText(fragment: string, prefix: "w" | "a"): string {
  const parts: string[] = [];
  const re = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>|<${prefix}:tab\\s*/>|<${prefix}:br\\s*/>`, "g");
  for (const m of fragment.matchAll(re)) parts.push(m[1] !== undefined ? decodeXml(m[1]) : m[0].includes("tab") ? "\t" : "\n");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Zip packages
// ---------------------------------------------------------------------------

export interface OpenedPackage {
  zip: JSZip;
  names: string[];
  text(name: string): Promise<string | null>;
}

export async function openPackage(bytes: Buffer): Promise<OpenedPackage> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return {
    zip,
    names,
    async text(name) {
      const file = zip.file(name);
      return file ? file.async("string") : null;
    },
  };
}

/**
 * The checks every OOXML package gets: it unzips, declares the expected main
 * content type, and every XML part is well formed.
 */
export async function packageChecks(
  prefix: string,
  bytes: Buffer,
  mainContentType: string,
  mainPart: string
): Promise<{ pkg: OpenedPackage | null; checks: CheckResult[] }> {
  const checks: CheckResult[] = [];
  let pkg: OpenedPackage;
  try {
    pkg = await openPackage(bytes);
  } catch (error) {
    return { pkg: null, checks: [fail(`${prefix}:zip`, `not a readable zip package: ${(error as Error).message}`)] };
  }
  checks.push(pass(`${prefix}:zip`, `${pkg.names.length} parts`));
  const types = await pkg.text("[Content_Types].xml");
  if (!types || !types.includes(mainContentType)) {
    checks.push(fail(`${prefix}:content-type`, `[Content_Types].xml does not declare ${mainContentType}`));
  } else {
    checks.push(pass(`${prefix}:content-type`, mainContentType));
  }
  if (!pkg.names.includes(mainPart)) checks.push(fail(`${prefix}:main-part`, `missing ${mainPart}`));
  const broken: string[] = [];
  for (const name of pkg.names.filter((n) => /\.(xml|rels)$/.test(n))) {
    const problem = xmlProblem((await pkg.text(name)) ?? "");
    if (problem) broken.push(`${name}: ${problem}`);
  }
  checks.push(
    broken.length
      ? fail(`${prefix}:well-formed`, broken.slice(0, 5).join("; "))
      : pass(`${prefix}:well-formed`, "every XML part is well formed")
  );
  return { pkg, checks };
}
