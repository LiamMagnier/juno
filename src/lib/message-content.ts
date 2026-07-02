/**
 * Shared, dependency-free parsing of Juno's message wire format.
 * The model wraps artifacts and durable memories in custom tags; both the
 * server (to persist) and the client (to render) parse them with this module.
 *
 *   <juno:artifact identifier="todo-app" type="react" title="Todo App" language="tsx">...</juno:artifact>
 *   <juno:memory>The user prefers concise answers.</juno:memory>
 */

import { findLearningBlocks, type ParsedLearningBlock } from "@/lib/learning-blocks";

export type ArtifactType = "HTML" | "REACT" | "CODE" | "MARKDOWN" | "SVG" | "MERMAID";

export interface ParsedArtifact {
  identifier: string;
  type: ArtifactType;
  title: string;
  language?: string;
  content: string;
}

const ARTIFACT_RE = /<juno:artifact\s+([^>]*?)>([\s\S]*?)<\/juno:artifact>/g;
const OPEN_ARTIFACT_RE = /<juno:artifact\s+([^>]*?)>([\s\S]*)$/; // still streaming (no close yet)
const MEMORY_RE = /<juno:memory>([\s\S]*?)<\/juno:memory>/g;
const CLARIFICATION_WIZARD_RE = /:::clarification-wizard[\s\S]*?:::/gi;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Accept double-quoted, single-quoted, and unquoted attribute values.
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

// Stable id derived from content, used when the model omits `identifier`.
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "art-" + h.toString(36);
}

function artifactId(attrs: Record<string, string>, content: string): string {
  const id = attrs.identifier?.trim();
  return id || hashId(content.slice(0, 500));
}

function normalizeType(t?: string): ArtifactType {
  const up = (t ?? "").toUpperCase();
  if (up === "HTML" || up === "REACT" || up === "CODE" || up === "MARKDOWN" || up === "SVG" || up === "MERMAID") {
    return up;
  }
  return "CODE";
}

/** Extract artifacts from a message. Closed artifacts plus, when the reply was
 *  truncated, a salvaged trailing artifact whose closing tag never arrived. */
export function parseArtifacts(text: string): ParsedArtifact[] {
  const out: ParsedArtifact[] = [];
  let m: RegExpExecArray | null;
  ARTIFACT_RE.lastIndex = 0;
  while ((m = ARTIFACT_RE.exec(text))) {
    const attrs = parseAttrs(m[1]);
    if (!m[2].trim()) continue;
    out.push({
      identifier: artifactId(attrs, m[2]),
      type: normalizeType(attrs.type),
      title: attrs.title || "Untitled",
      language: attrs.language || undefined,
      content: m[2].trim(),
    });
  }

  // Salvage a truncated (unclosed) trailing artifact so it still gets saved
  // and becomes openable instead of being stuck on "Writing…".
  const open = parseStreamingArtifact(text);
  if (open?.identifier && open.content.trim() && !out.some((a) => a.identifier === open.identifier)) {
    out.push({
      identifier: open.identifier,
      type: open.type,
      title: open.title,
      language: open.language,
      content: open.content.trim(),
    });
  }

  return out;
}

/** Detect an artifact that has started streaming but not yet closed. */
export function parseStreamingArtifact(text: string): (Omit<ParsedArtifact, "content"> & { content: string; streaming: true }) | null {
  // Ignore any already-closed artifacts, look only at the tail.
  const lastClose = text.lastIndexOf("</juno:artifact>");
  const tail = lastClose >= 0 ? text.slice(lastClose + "</juno:artifact>".length) : text;
  const m = OPEN_ARTIFACT_RE.exec(tail);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  return {
    identifier: artifactId(attrs, m[2]),
    type: normalizeType(attrs.type),
    title: attrs.title || "Untitled",
    language: attrs.language || undefined,
    content: m[2],
    streaming: true,
  };
}

export function parseMemories(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MEMORY_RE.lastIndex = 0;
  while ((m = MEMORY_RE.exec(text))) {
    const fact = m[1].trim();
    if (fact) out.push(fact);
  }
  return out;
}

/** Remove memory tags entirely and replace artifact blocks with a marker for display. */
export function cleanForDisplay(text: string): string {
  return text
    .replace(MEMORY_RE, "")
    .replace(CLARIFICATION_WIZARD_RE, "")
    .replace(ARTIFACT_RE, (_full, attrsRaw) => {
      const attrs = parseAttrs(attrsRaw);
      return `\n\n:::artifact{identifier="${attrs.identifier ?? ""}"}\n\n`;
    })
    // strip a partially-streamed (unclosed) artifact opener from the visible text
    .replace(OPEN_ARTIFACT_RE, (full, attrsRaw) => {
      const attrs = parseAttrs(attrsRaw);
      return attrs.identifier ? `\n\n:::artifact{identifier="${attrs.identifier}"}\n\n` : full;
    })
    .trim();
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "artifact"; identifier: string; streaming?: boolean }
  | { type: "learning"; parsed: ParsedLearningBlock };

function pushTextParts(parts: ContentPart[], text: string) {
  if (!text.trim()) return;
  const blocks = findLearningBlocks(text);
  if (blocks.length === 0) {
    parts.push({ type: "text", text });
    return;
  }

  let lastIndex = 0;
  for (const entry of blocks) {
    const before = text.slice(lastIndex, entry.start);
    if (before.trim()) parts.push({ type: "text", text: before });
    parts.push({ type: "learning", parsed: entry });
    lastIndex = entry.end;
  }
  const rest = text.slice(lastIndex);
  if (rest.trim()) parts.push({ type: "text", text: rest });
}

/** Split a message into ordered text + artifact-reference parts for rendering. */
export function splitMessageContent(raw: string): ContentPart[] {
  const text = raw.replace(MEMORY_RE, "").replace(CLARIFICATION_WIZARD_RE, "");
  const parts: ContentPart[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  ARTIFACT_RE.lastIndex = 0;
  while ((m = ARTIFACT_RE.exec(text))) {
    const before = text.slice(lastIndex, m.index);
    pushTextParts(parts, before);
    const attrs = parseAttrs(m[1]);
    parts.push({ type: "artifact", identifier: artifactId(attrs, m[2]) });
    lastIndex = m.index + m[0].length;
  }

  const rest = text.slice(lastIndex);
  const open = OPEN_ARTIFACT_RE.exec(rest);
  if (open) {
    const before = rest.slice(0, open.index);
    pushTextParts(parts, before);
    const attrs = parseAttrs(open[1]);
    parts.push({ type: "artifact", identifier: artifactId(attrs, open[2]), streaming: true });
  } else {
    const partialIdx = rest.indexOf("<juno:artifact");
    if (partialIdx !== -1 && !rest.slice(partialIdx).includes(">")) {
      const before = rest.slice(0, partialIdx);
      pushTextParts(parts, before);
      parts.push({ type: "artifact", identifier: "", streaming: true });
    } else if (rest.trim()) {
      pushTextParts(parts, rest);
    }
  }

  return parts;
}

/** Strip tags and TTS-unfriendly characters so spoken replies sound natural. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(MEMORY_RE, "")
    .replace(ARTIFACT_RE, " I've added that to the canvas. ")
    .replace(CLARIFICATION_WIZARD_RE, "")
    .replace(
      /:::(?:step-lab|learning-card|process-timeline|comparison|quiz|deep-dive)[\s\S]*?(?::::|$)/gi,
      " (interactive visual explanation shown on screen) "
    )
    .replace(/```(?:juno-visual|juno-ui|juno-block|visual|visual-block)[\s\S]*?```/gi, " (visual explanation shown on screen) ")
    .replace(/```[\s\S]*?```/g, " (code shown on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>~|]/g, "")
    .replace(/\.\.\./g, ",")
    .replace(/—/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}
