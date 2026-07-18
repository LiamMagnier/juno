/**
 * Targeted AI edits for an existing Canvas artifact.
 *
 * The model never gets to replace the artifact wholesale in this flow. It
 * returns exact search/replace operations; the server validates every anchor
 * against the current source and applies only those ranges. Everything outside
 * the accepted ranges therefore stays byte-identical.
 */

export interface ArtifactEditRequest {
  artifactId: string;
  identifier: string;
  baseVersion: number;
  kind: "text" | "element";
  text: string;
  lineStart?: number;
  lineEnd?: number;
  selector?: string;
}

export interface ArtifactSourceForEdit {
  identifier: string;
  title: string;
  type: string;
  language?: string | null;
  version: number;
  content: string;
}

export interface ArtifactSourceEdit {
  search: string;
  replace: string;
}

export interface ArtifactPatch {
  summary?: string;
  edits: ArtifactSourceEdit[];
}

const PATCH_RE = /<juno:artifact-patch(?:\s[^>]*)?>([\s\S]*?)<\/juno:artifact-patch>/i;
const MAX_EDITS = 12;

export class ArtifactPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactPatchError";
  }
}

function jsonBody(raw: string): string {
  const tagged = PATCH_RE.exec(raw)?.[1]?.trim();
  if (!tagged) throw new ArtifactPatchError("The model did not return a targeted canvas patch.");
  return tagged.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/** Parse and validate the model-only patch protocol. */
export function parseArtifactPatch(raw: string): ArtifactPatch {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(raw));
  } catch (error) {
    if (error instanceof ArtifactPatchError) throw error;
    throw new ArtifactPatchError("The model returned an invalid canvas patch.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactPatchError("The canvas patch must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.edits) || record.edits.length === 0 || record.edits.length > MAX_EDITS) {
    throw new ArtifactPatchError(`The canvas patch must contain between 1 and ${MAX_EDITS} edits.`);
  }

  const edits = record.edits.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ArtifactPatchError(`Canvas edit ${index + 1} is invalid.`);
    }
    const edit = entry as Record<string, unknown>;
    if (typeof edit.search !== "string" || !edit.search) {
      throw new ArtifactPatchError(`Canvas edit ${index + 1} has no exact search anchor.`);
    }
    if (typeof edit.replace !== "string") {
      throw new ArtifactPatchError(`Canvas edit ${index + 1} has no replacement text.`);
    }
    return { search: edit.search, replace: edit.replace };
  });

  return {
    edits,
    ...(typeof record.summary === "string" && record.summary.trim()
      ? { summary: record.summary.trim().slice(0, 240) }
      : {}),
  };
}

function uniqueIndex(source: string, search: string, editNumber: number): number {
  const first = source.indexOf(search);
  if (first === -1) {
    throw new ArtifactPatchError(`Canvas edit ${editNumber} no longer matches the current source.`);
  }
  if (source.indexOf(search, first + 1) !== -1) {
    throw new ArtifactPatchError(`Canvas edit ${editNumber} is ambiguous in the current source.`);
  }
  return first;
}

/**
 * Apply validated edits against one immutable base. Ranges are resolved before
 * any replacement and applied from the end of the file, so one edit cannot
 * shift or manufacture another edit's anchor.
 */
export function applyArtifactPatch(source: string, patch: ArtifactPatch): string {
  const ranges = patch.edits.map((edit, index) => {
    const start = uniqueIndex(source, edit.search, index + 1);
    return { ...edit, start, end: start + edit.search.length };
  });
  const ordered = [...ranges].sort((a, b) => b.start - a.start);

  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].start < ordered[i].end) {
      throw new ArtifactPatchError("The canvas patch contains overlapping edits.");
    }
  }
  const coveredBytes = ordered.reduce((total, edit) => total + edit.search.length, 0);
  if (source.length >= 400 && coveredBytes > source.length * 0.6) {
    throw new ArtifactPatchError("The proposed canvas patch is too broad for a targeted edit.");
  }

  let updated = source;
  for (const edit of ordered) {
    updated = updated.slice(0, edit.start) + edit.replace + updated.slice(edit.end);
  }
  if (updated === source) throw new ArtifactPatchError("The canvas patch did not change anything.");
  if (updated.length - source.length > Math.max(20_000, source.length * 0.5)) {
    throw new ArtifactPatchError("The proposed canvas patch adds too much code for a targeted edit.");
  }
  if (updated.length > 200_000) throw new ArtifactPatchError("The edited canvas is too large to save.");
  return updated;
}

function sourceFence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Build the turn-specific system contract for a minimal existing-canvas edit. */
export function buildArtifactEditPrompt(target: ArtifactSourceForEdit, selection: ArtifactEditRequest): string {
  const fence = sourceFence(target.content);
  const location =
    selection.kind === "element" && selection.selector
      ? `DOM selector: ${selection.selector}`
      : selection.lineStart != null
        ? `Selected source lines: ${selection.lineStart}${selection.lineEnd && selection.lineEnd !== selection.lineStart ? `-${selection.lineEnd}` : ""}`
        : "Selected source region: use the quoted selection in the latest user message";

  return `# Targeted existing-canvas edit

This turn modifies the EXISTING artifact "${target.identifier}" at version ${target.version}. The normal Canvas instruction to emit a complete artifact does not apply to this turn.

Return ONLY this machine-readable structure, with valid JSON inside the tag:
<juno:artifact-patch>
{"summary":"One short sentence describing the applied change","edits":[{"search":"exact unique text copied byte-for-byte from CURRENT SOURCE","replace":"replacement text"}]}
</juno:artifact-patch>

Rules:
- Make only the change requested in the latest user message and its selection.
- Never return the complete artifact, a new artifact, markdown commentary, or a different identifier.
- Every search value must be a non-empty, byte-exact, unique substring of CURRENT SOURCE.
- Keep each search anchor as small as possible while still unique.
- Include all related minimal edits needed for the requested result, up to ${MAX_EDITS} operations.
- Preserve every byte outside those operations, including formatting, comments, dependencies, content, and behavior.
- For an insertion, include a nearby unique source anchor in both search and replace.

Target: ${target.title} · ${target.type}${target.language ? ` · ${target.language}` : ""}
${location}
Selected preview/source excerpt:
${selection.text}

CURRENT SOURCE (version ${target.version}):
${fence}${target.language ?? "text"}
${target.content}
${fence}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Build normal transcript content after the server has safely applied a patch. */
export function buildArtifactEditMessage(target: ArtifactSourceForEdit, content: string, summary?: string): string {
  const sentence = summary?.trim() || `Updated ${target.title} in the existing canvas.`;
  const attrs = [
    `identifier="${escapeAttribute(target.identifier)}"`,
    `type="${escapeAttribute(target.type)}"`,
    `title="${escapeAttribute(target.title)}"`,
    target.language ? `language="${escapeAttribute(target.language)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `${sentence}\n\n<juno:artifact ${attrs}>\n${content}\n</juno:artifact>`;
}
