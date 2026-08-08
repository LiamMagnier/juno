/**
 * Plain text, markdown, source code, JSON and YAML → blocks with line ranges.
 *
 * The locator here is `path:lineStart-lineEnd`, because that is the only address
 * a text file has and it is the one a person can act on — they can open the file
 * and go to the line. Everything else in this module exists to make those line
 * numbers *true*: the flavour parsers never reflow, re-indent or re-serialize
 * the source, they only decide where one block ends and the next begins.
 *
 * Markdown additionally carries a heading breadcrumb, which is what lets a
 * citation say "under Setup › Database" instead of just "line 212".
 */

import {
  BlockCollector,
  EXTRACT_LIMITS,
  type ExtractedBlock,
  type ExtractionResult,
  type KnowledgeBlockType,
} from "./types";

export const TEXT_PARSER = "text";
export const TEXT_PARSER_VERSION = "1";

export type TextFlavor = "markdown" | "json" | "yaml" | "code" | "plain";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
  "css", "scss", "less", "toml", "ini", "gradle", "graphql", "proto",
]);

/**
 * Flavour is decided by extension first and MIME second, deliberately.
 *
 * Uploads arrive as `application/octet-stream` far more often than they arrive
 * correctly typed — `planAttachmentUpload` stores every non-image that way on
 * purpose — so the declared type is the weaker signal of the two.
 */
export function textFlavor(fileName: string, mimeType: string): TextFlavor {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (ext === "txt" || ext === "text" || ext === "log" || ext === "csv" || ext === "tsv") return "plain";

  const mime = mimeType.toLowerCase();
  if (mime === "text/markdown") return "markdown";
  if (mime === "application/json") return "json";
  if (mime === "application/x-yaml" || mime === "text/yaml") return "yaml";
  if (mime === "application/javascript" || mime === "text/javascript") return "code";
  return "plain";
}

/**
 * Decode as UTF-8, or report that this is not text at all.
 *
 * A NUL byte early in the file is the giveaway: no UTF-8 text document contains
 * one, and every binary format we do not have an extractor for does. Without
 * this check a JPEG renamed to `.txt` would become several thousand blocks of
 * replacement characters, and they would be indexed and retrieved as if they
 * meant something.
 */
function decodeUtf8(bytes: Uint8Array): { text: string } | { error: string } {
  const probe = bytes.subarray(0, 8_000);
  if (probe.includes(0)) {
    return { error: "This file contains binary data, so there is no text to index. If it is a document, upload it in its original format." };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { text: decoded.replace(/^﻿/, "").replace(/\r\n?/g, "\n") };
}

interface Section {
  type: KnowledgeBlockType;
  lineStart: number;
  lineEnd: number;
  text: string;
  heading: string[];
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

function markdownSections(lines: string[]): Section[] {
  const out: Section[] = [];
  // Breadcrumb stack indexed by heading depth. A level-2 heading replaces
  // everything from depth 2 down, which is what makes "Setup › Database ›
  // Migrations" collapse correctly when a new "## Deploy" starts.
  const stack: Array<{ level: number; text: string }> = [];
  const crumb = () => stack.map((s) => s.text);

  let i = 0;

  // YAML front matter, when it is genuinely the first line. Kept as its own
  // block so a citation into a doc's metadata does not land on its prose.
  if (lines[0] === "---") {
    let end = 1;
    while (end < lines.length && lines[end] !== "---") end += 1;
    if (end < lines.length) {
      out.push({
        type: "code",
        lineStart: 1,
        lineEnd: end + 1,
        text: lines.slice(1, end).join("\n"),
        heading: [],
      });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const marker = fence[1];
      let end = i + 1;
      while (end < lines.length && !lines[end].trimStart().startsWith(marker)) end += 1;
      out.push({
        type: "code",
        lineStart: lineNo,
        lineEnd: Math.min(end, lines.length - 1) + 1,
        text: lines.slice(i + 1, end).join("\n"),
        heading: crumb(),
      });
      i = end + 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      // The heading block carries the breadcrumb *above* it — a heading is not
      // its own ancestor, and repeating it would double every citation label.
      out.push({ type: "heading", lineStart: lineNo, lineEnd: lineNo, text, heading: crumb() });
      stack.push({ level, text });
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      let end = i;
      while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
      out.push({
        type: "table",
        lineStart: lineNo,
        lineEnd: end,
        text: lines.slice(i, end).join("\n"),
        heading: crumb(),
      });
      i = end;
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      // One block per item, continuation lines included, so a cited list item is
      // the whole item and not its first line.
      let end = i + 1;
      while (end < lines.length && lines[end].trim() && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[end])) end += 1;
      out.push({
        type: "list_item",
        lineStart: lineNo,
        lineEnd: end,
        text: lines.slice(i, end).join("\n").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""),
        heading: crumb(),
      });
      i = end;
      continue;
    }

    let end = i + 1;
    while (
      end < lines.length &&
      lines[end].trim() &&
      !/^(#{1,6})\s+/.test(lines[end]) &&
      !/^\s*(?:```|~~~)/.test(lines[end]) &&
      !/^\s*\|/.test(lines[end]) &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[end])
    ) {
      end += 1;
    }
    out.push({
      type: "paragraph",
      lineStart: lineNo,
      lineEnd: end,
      text: lines.slice(i, end).join("\n"),
      heading: crumb(),
    });
    i = end;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split a JSON document into its top-level members, keeping the *source* line
 * numbers.
 *
 * Re-serializing with `JSON.stringify` would have been three lines, and would
 * have thrown the line numbers away — the citation would point at a rendering
 * of the file rather than the file. So this scans the raw characters and only
 * tracks what it must: string state (so a `,` inside a value is not a boundary),
 * escape state, and nesting depth.
 */
function jsonSections(source: string): Section[] {
  const out: Section[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let line = 1;
  let memberStart = -1;
  let memberStartLine = 1;
  let rootOpened = false;

  const flush = (endIndex: number, endLine: number) => {
    if (memberStart < 0) return;
    const raw = source.slice(memberStart, endIndex);
    if (!raw.trim()) return;
    const key = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(raw);
    out.push({
      type: "code",
      lineStart: memberStartLine,
      lineEnd: endLine,
      text: raw.trim(),
      heading: key ? [key[1]] : [],
    });
    memberStart = -1;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") line += 1;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth === 1 && memberStart < 0) {
        memberStart = i;
        memberStartLine = line;
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      rootOpened = true;
      if (depth === 1) {
        memberStart = -1;
      } else if (depth === 2 && memberStart < 0) {
        memberStart = i;
        memberStartLine = line;
      }
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth === 1) flush(i, line);
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 1) {
      flush(i, line);
      continue;
    }
    if (depth === 1 && memberStart < 0 && ch.trim()) {
      memberStart = i;
      memberStartLine = line;
    }
  }

  // A bare scalar document ("just a string", 42) never opens a container.
  if (!rootOpened && source.trim()) {
    out.push({ type: "code", lineStart: 1, lineEnd: line, text: source.trim(), heading: [] });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* YAML                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * YAML is split at its top-level keys, without parsing it.
 *
 * A real YAML parse would need a dependency, and would still have to be told
 * which line every node came from. Splitting on column-zero keys gets the two
 * things a citation needs — a line range and the key it lives under — and is
 * wrong only for documents that are one giant unkeyed block, which then
 * correctly become one block.
 */
function yamlSections(lines: string[]): Section[] {
  const out: Section[] = [];
  const isTopKey = (l: string) => /^[^\s#][^:]*:(\s|$)/.test(l) || /^-\s/.test(l);

  let i = 0;
  // Anything before the first top-level key (document marker, leading comments).
  while (i < lines.length && !isTopKey(lines[i])) i += 1;
  if (i > 0) {
    const preamble = lines.slice(0, i).join("\n");
    if (preamble.trim()) out.push({ type: "code", lineStart: 1, lineEnd: i, text: preamble, heading: [] });
  }

  while (i < lines.length) {
    const start = i;
    const key = /^([^\s#][^:]*):/.exec(lines[i]);
    i += 1;
    while (i < lines.length && !isTopKey(lines[i])) i += 1;
    const text = lines.slice(start, i).join("\n");
    if (text.trim()) {
      out.push({
        type: "code",
        lineStart: start + 1,
        lineEnd: i,
        text,
        heading: key ? [key[1].trim()] : [],
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Plain text and source code                                                  */
/* -------------------------------------------------------------------------- */

const MAX_CHUNK_LINES = 80;

/**
 * Blank lines are the only structure plain text and unknown source languages
 * reliably have, so they are the block boundary. The line cap then stops a
 * minified bundle or a single-paragraph novel from becoming one unusable block.
 */
function chunkSections(lines: string[], type: KnowledgeBlockType): Section[] {
  const out: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length) break;
    const start = i;
    while (i < lines.length && lines[i].trim() && i - start < MAX_CHUNK_LINES) i += 1;
    out.push({ type, lineStart: start + 1, lineEnd: i, text: lines.slice(start, i).join("\n"), heading: [] });
  }
  return out;
}

/* -------------------------------------------------------------------------- */

export interface TextExtractInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

export function extractTextDocument(input: TextExtractInput): ExtractionResult {
  const base = { parser: TEXT_PARSER, parserVersion: TEXT_PARSER_VERSION };

  const decoded = decodeUtf8(input.bytes);
  if ("error" in decoded) {
    return { ...base, status: "failed", blocks: [], reason: decoded.error };
  }
  const source = decoded.text;
  if (!source.trim()) {
    return { ...base, status: "degraded", blocks: [], reason: "This file is empty, so there was nothing to index." };
  }

  const lines = source.split("\n");
  if (lines.length > 500_000) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: `This file has ${lines.length.toLocaleString()} lines, which is past the limit Juno can index.`,
    };
  }

  const flavor = textFlavor(input.fileName, input.mimeType);
  let sections: Section[];
  let reason: string | undefined;
  let status: "ok" | "degraded" = "ok";

  if (flavor === "markdown") {
    sections = markdownSections(lines);
  } else if (flavor === "json") {
    try {
      JSON.parse(source);
      sections = jsonSections(source);
    } catch (error) {
      // Still worth indexing: a config file with a trailing comma is not a
      // reason to lose the 400 lines that *are* readable. The user just needs
      // to know the structure was not trusted.
      status = "degraded";
      reason = `This file is not valid JSON (${error instanceof Error ? error.message : "parse failed"}), so it was indexed as plain text without its structure.`;
      sections = chunkSections(lines, "code");
    }
  } else if (flavor === "yaml") {
    sections = yamlSections(lines);
  } else {
    sections = chunkSections(lines, flavor === "code" ? "code" : "paragraph");
  }

  const collector = new BlockCollector();
  for (const section of sections) {
    const block: ExtractedBlock = {
      type: section.type,
      text: section.text,
      path: input.fileName,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      heading: section.heading,
      // Embedded text read verbatim from the file. Nothing was inferred.
      confidence: 1,
    };
    collector.push(block);
  }

  const blocks = collector.done();
  if (!blocks.length) {
    return { ...base, status: "degraded", blocks: [], reason: reason ?? "No readable text was found in this file." };
  }
  if (collector.hitLimit) {
    status = "degraded";
    reason = `This file is larger than the ${EXTRACT_LIMITS.maxBlocks.toLocaleString()}-block indexing limit, so only its first part was indexed.`;
  }

  return { ...base, status, blocks, reason };
}
