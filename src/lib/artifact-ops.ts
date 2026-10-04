/**
 * Incremental edits to semantic artifacts from a chat turn (BRIEF §30:
 * "A conversation should be capable of editing an existing artifact
 * incrementally. Do not regenerate the whole output unless necessary.").
 *
 * The model writes operations, not a new body:
 *
 *   <juno:artifact-ops identifier="growth-model">
 *   {"summary":"Raised conversion to 7.5%","ops":[{"op":"setCell","sheet":"Assumptions","cell":"conversion","value":0.075}]}
 *   </juno:artifact-ops>
 *
 * The server resolves the identifier to the artifact's CURRENT version, applies
 * the operations with the deterministic engine (`work/deliverables/semantic`),
 * and rewrites the block into the ordinary artifact tag carrying the result.
 * From there the existing pipeline takes over unchanged: verification, the
 * re-emit guard (a person's newer edit turns the result into a suggestion
 * rather than a version), version append, undo through restore, the Library.
 *
 * Operations apply to whatever the current version is — they are semantic, so
 * they rebase — and they are all-or-nothing: a failing block is replaced by a
 * one-line notice and nothing is stored.
 */

import {
  applySemanticOps,
  isSemanticArtifactType,
  type SemanticArtifactType,
} from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";

export const ARTIFACT_OPS_RE = /<juno:artifact-ops\s+([^>]*?)>([\s\S]*?)<\/juno:artifact-ops>/g;
/** An ops block still streaming in (no close yet), or its opener still arriving. */
export const OPEN_ARTIFACT_OPS_TAIL_RE = /<juno:artifact-ops(?:\s[^>]*)?>[\s\S]*$|<juno:artifact-o(?:p(?:s)?)?(?:\s[^>]*)?$/;

const MAX_BLOCKS = 6;

export interface ArtifactOpsBlock {
  identifier: string;
  body: string;
}

function attr(raw: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(raw);
  return match ? (match[1] ?? match[2]) : undefined;
}

export function parseArtifactOpsBlocks(text: string): ArtifactOpsBlock[] {
  const out: ArtifactOpsBlock[] = [];
  ARTIFACT_OPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTIFACT_OPS_RE.exec(text))) {
    const identifier = attr(m[1], "identifier")?.trim();
    if (identifier) out.push({ identifier, body: m[2].trim() });
  }
  return out;
}

export function hasArtifactOps(text: string): boolean {
  return text.includes("<juno:artifact-ops");
}

/** The artifact an identifier resolves to, as the route reads it. */
export interface OpsTarget {
  identifier: string;
  type: string;
  title: string;
  version: number;
  content: string;
}

export interface AppliedOps {
  identifier: string;
  type: SemanticArtifactType;
  title: string;
  baseVersion: number;
  summary: string;
  changes: string[];
  content: string;
}

export interface FailedOps {
  identifier: string;
  reason: string;
}

function parseOpsBody(body: string): { summary?: string; ops: unknown } {
  const json = body.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SemanticError("invalid_op", "the operations are not valid JSON");
  }
  if (Array.isArray(value)) return { ops: value };
  if (!value || typeof value !== "object") throw new SemanticError("invalid_op", "expected {\"ops\": [...]}");
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.summary === "string" && record.summary.trim() ? { summary: record.summary.trim().slice(0, 240) } : {}),
    ops: record.ops,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** The artifact tag a successful block becomes; the normal pipeline persists it. */
export function artifactTagFor(applied: AppliedOps): string {
  return (
    `<juno:artifact identifier="${escapeAttribute(applied.identifier)}" type="${applied.type}" ` +
    `title="${escapeAttribute(applied.title)}" language="json">\n${applied.content}\n</juno:artifact>`
  );
}

export function opsFailureNotice(title: string, reason: string): string {
  return `Couldn't apply that edit to “${title}”: ${reason}. Nothing was changed.`;
}

/**
 * Resolve and apply every ops block in a reply, rewriting each into its
 * result. Pure apart from `load`, which the route backs with the database.
 * Consecutive blocks for the same identifier apply in order, each on top of
 * the previous result.
 */
export async function resolveArtifactOps(
  text: string,
  load: (identifier: string) => Promise<OpsTarget | null>,
  options: { now?: Date; author?: string } = {}
): Promise<{ text: string; applied: AppliedOps[]; failed: FailedOps[] } | null> {
  if (!hasArtifactOps(text)) return null;
  const applied: AppliedOps[] = [];
  const failed: FailedOps[] = [];
  const working = new Map<string, OpsTarget>();
  const replacements: string[] = [];

  const blocks: { full: string; attrs: string; body: string }[] = [];
  ARTIFACT_OPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTIFACT_OPS_RE.exec(text))) blocks.push({ full: m[0], attrs: m[1], body: m[2] });

  for (const [index, block] of blocks.entries()) {
    const identifier = attr(block.attrs, "identifier")?.trim() ?? "";
    if (index >= MAX_BLOCKS) {
      replacements.push(opsFailureNotice(identifier || "the artifact", `more than ${MAX_BLOCKS} edit blocks in one reply`));
      continue;
    }
    const target = working.get(identifier) ?? (identifier ? await load(identifier) : null);
    if (!target) {
      failed.push({ identifier, reason: "no such artifact in this chat" });
      replacements.push(opsFailureNotice(identifier || "the artifact", "there is no artifact with that identifier in this chat"));
      continue;
    }
    if (!isSemanticArtifactType(target.type)) {
      failed.push({ identifier, reason: "not a semantic artifact" });
      replacements.push(opsFailureNotice(target.title, "only spreadsheets, documents and decks take operations; re-emit the artifact instead"));
      continue;
    }
    try {
      const parsed = parseOpsBody(block.body);
      const result = applySemanticOps(target.type, target.content, parsed.ops, options);
      const done: AppliedOps = {
        identifier: target.identifier,
        type: target.type,
        title: target.title,
        baseVersion: target.version,
        summary: parsed.summary ?? result.changes.join("; "),
        changes: result.changes,
        content: result.content,
      };
      applied.push(done);
      working.set(identifier, { ...target, content: result.content });
      replacements.push(`${done.summary}\n\n${artifactTagFor(done)}`);
    } catch (error) {
      const reason = error instanceof SemanticError ? error.message : "the operations could not be applied";
      failed.push({ identifier, reason });
      replacements.push(opsFailureNotice(target.title, reason.replace(/\.$/, "")));
    }
  }

  // Several successful blocks for one identifier: only the last carries the
  // body (a turn makes one version per artifact); earlier ones keep their line.
  const lastFor = new Map<string, number>();
  blocks.forEach((block, i) => {
    const identifier = attr(block.attrs, "identifier")?.trim() ?? "";
    if (replacements[i]?.includes("<juno:artifact ")) lastFor.set(identifier, i);
  });
  let cursor = 0;
  let out = "";
  blocks.forEach((block, i) => {
    const at = text.indexOf(block.full, cursor);
    out += text.slice(cursor, at);
    const identifier = attr(block.attrs, "identifier")?.trim() ?? "";
    let replacement = replacements[i] ?? "";
    if (replacement.includes("<juno:artifact ") && lastFor.get(identifier) !== i) {
      replacement = replacement.slice(0, replacement.indexOf("\n\n<juno:artifact "));
    }
    out += replacement;
    cursor = at + block.full.length;
  });
  out += text.slice(cursor);
  // An ops block that never closed (Stop, output limit) is not an edit.
  out = out.replace(OPEN_ARTIFACT_OPS_TAIL_RE, "");
  return { text: out, applied, failed };
}

/** The system-prompt section listing editable semantic artifacts with their outlines. */
export function buildSemanticArtifactContext(
  artifacts: { identifier: string; type: string; title: string; version: number; outline: string }[]
): string | null {
  if (!artifacts.length) return null;
  const sections = artifacts.map(
    (a) => `## ${a.title} — identifier "${a.identifier}", ${a.type}, version ${a.version}\n${a.outline}`
  );
  return `# Editable spreadsheets, documents and decks in this chat
These are the CURRENT versions (the person may have edited them since you last wrote them). To change one, emit operations — never re-emit the whole artifact for an edit:
<juno:artifact-ops identifier="IDENTIFIER">{"summary":"one short sentence","ops":[ ... ]}</juno:artifact-ops>
Address cells, blocks, slides and elements exactly as listed below. Operations are applied all-or-nothing; dependent formulas and charts recalculate by themselves, so change only the inputs that the request is about.

${sections.join("\n\n")}`;
}

/**
 * The targeted-edit contract (a selection in the canvas) for a semantic
 * artifact: operations against the outline instead of a byte patch against
 * the JSON source. Same flow as `artifact-edit.ts`, same base-version check.
 */
export function buildSemanticEditPrompt(
  target: { identifier: string; title: string; type: string; version: number; content: string },
  selection: { text: string },
  outline: string
): string {
  return `# Targeted edit of an existing ${target.type.toLowerCase()}

This turn modifies the EXISTING artifact "${target.identifier}" at version ${target.version}. Do not re-emit it.

Return ONLY this structure, with valid JSON inside the tag:
<juno:artifact-ops identifier="${target.identifier}">
{"summary":"One short sentence describing the change","ops":[ ... ]}
</juno:artifact-ops>

Rules:
- Make only the change the latest user message asks for, at the selection.
- Address cells, blocks, slides and elements exactly as the outline lists them.
- Change inputs, not results: formulas and charts that depend on a cell recalculate by themselves.
- Operations are applied all-or-nothing; one that does not fit the current version rejects the whole edit.

Selected in the canvas:
${selection.text}

CURRENT ${target.type} (version ${target.version}):
${outline}`;
}

/** Apply the ops a targeted-edit reply returned to its target. Throws SemanticError. */
export function applySemanticEditReply(
  target: { identifier: string; type: string; content: string },
  reply: string,
  options: { now?: Date; author?: string } = {}
): { content: string; summary?: string; changes: string[] } {
  if (!isSemanticArtifactType(target.type)) throw new SemanticError("invalid_op", "not a semantic artifact");
  const blocks = parseArtifactOpsBlocks(reply);
  const block = blocks.find((b) => b.identifier === target.identifier) ?? blocks[0];
  if (!block) throw new SemanticError("invalid_op", "The model did not return operations for this artifact");
  const parsed = parseOpsBody(block.body);
  const result = applySemanticOps(target.type, target.content, parsed.ops, options);
  return { content: result.content, ...(parsed.summary ? { summary: parsed.summary } : {}), changes: result.changes };
}
