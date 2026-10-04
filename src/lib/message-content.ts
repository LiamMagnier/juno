/**
 * Shared, dependency-free parsing of Juno's message wire format.
 * The model wraps artifacts and durable memories in custom tags; both the
 * server (to persist) and the client (to render) parse them with this module.
 *
 *   <juno:artifact identifier="todo-app" type="react" title="Todo App" language="tsx">...</juno:artifact>
 *   <juno:memory>The user prefers concise answers.</juno:memory>
 *   <juno:forget>The user works at Acme.</juno:forget>
 */

import { findLearningBlocks, type ParsedLearningBlock } from "@/lib/learning-blocks";

export type ArtifactType =
  | "HTML"
  | "REACT"
  | "CODE"
  | "MARKDOWN"
  | "SVG"
  | "MERMAID"
  | "DESIGN"
  | "SPREADSHEET"
  | "DOCUMENT"
  | "PRESENTATION";

export interface ParsedArtifact {
  identifier: string;
  type: ArtifactType;
  title: string;
  language?: string;
  content: string;
  /**
   * The closing tag never arrived: the reply was stopped, or cut off at the
   * output limit, inside this block. What did arrive is kept so a reader can
   * still show it, but it is not a finished artifact and must never become a
   * version — chat verification refuses it (X-07). Absent on a closed block.
   */
  incomplete?: boolean;
}

export interface ArtifactMarkupUpdate {
  identifier: string;
  content?: string;
  refusal?: string;
}

const ARTIFACT_RE = /<juno:artifact\s+([^>]*?)>([\s\S]*?)<\/juno:artifact>/g;
const OPEN_ARTIFACT_RE = /<juno:artifact\s+([^>]*?)>([\s\S]*)$/; // still streaming (no close yet)
const MEMORY_RE = /<juno:memory>([\s\S]*?)<\/juno:memory>/g;
const FORGET_RE = /<juno:forget>([\s\S]*?)<\/juno:forget>/g;
/**
 * A memory or forget tag that has not finished arriving: opened and not yet
 * closed, or the opener itself still streaming in a few characters at a time.
 *
 * Without this, a reply's closing tags were visible for as long as they took
 * to stream — "<juno:memory>The user works at" sitting under the answer until
 * the closing tag landed and the render pass could finally match it. The tags
 * are always the last thing in a reply, so "everything from an unclosed opener
 * to the end" is exactly the tag and never the answer. A bare `<juno:` is left
 * alone on purpose: it is also how an artifact begins, and the artifact branch
 * below owns that case.
 */
const OPEN_MEMORY_TAIL_RE =
  /<juno:(?:memory|forget)>[\s\S]*$|<juno:(?:m(?:e(?:m(?:o(?:r(?:y)?)?)?)?)?|f(?:o(?:r(?:g(?:e(?:t)?)?)?)?)?)$/;
const CLARIFICATION_WIZARD_RE = /:::clarification-wizard[\s\S]*?:::/gi;
/** A closed semantic-edit block, and one still arriving (src/lib/artifact-ops.ts owns the protocol). */
const ARTIFACT_OPS_BLOCK_RE = /<juno:artifact-ops\s+([^>]*?)>[\s\S]*?<\/juno:artifact-ops>/g;
const ARTIFACT_OPS_TAIL_RE = /<juno:artifact-ops(?:\s[^>]*)?>(?:(?!<\/juno:artifact-ops>)[\s\S])*$|<juno:artifact-o(?:p(?:s)?)?(?:\s[^>]*)?$/;

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
  if (
    up === "HTML" ||
    up === "REACT" ||
    up === "CODE" ||
    up === "MARKDOWN" ||
    up === "SVG" ||
    up === "MERMAID" ||
    up === "DESIGN" ||
    up === "SPREADSHEET" ||
    up === "DOCUMENT" ||
    up === "PRESENTATION"
  ) {
    return up;
  }
  return "CODE";
}

/** Extract artifacts from a message: every closed block plus, when the reply
 *  ended inside one, the trailing block whose closing tag never arrived,
 *  flagged `incomplete`. */
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

  // A reply that ended inside an artifact, at Stop or at the output limit,
  // still returns its trailing block, so a reader can show what arrived (the
  // research report dialog does). It is flagged instead of passed off as
  // finished: it used to come back indistinguishable from a closed block, so
  // verification passed it and a half-written revision was saved as the
  // artifact's current version, labelled "verified" (X-07).
  const open = parseStreamingArtifact(text);
  if (open?.identifier && open.content.trim() && !out.some((a) => a.identifier === open.identifier)) {
    out.push({
      identifier: open.identifier,
      type: open.type,
      title: open.title,
      language: open.language,
      content: open.content.trim(),
      incomplete: true,
    });
  }

  return out;
}

/** Rewrite only the artifact bodies in a message after verification. This is
 * the presentation boundary: a repaired body must match what was persisted,
 * and a refused body must not remain renderable as an unsaved canvas card. */
export function rewriteArtifactMarkup(text: string, updates: readonly ArtifactMarkupUpdate[]): string {
  const byId = new Map(updates.map((update) => [update.identifier, update]));
  const replace = (rawAttrs: string, originalContent: string) => {
    const attrs = parseAttrs(rawAttrs);
    const id = artifactId(attrs, originalContent);
    const update = byId.get(id);
    if (!update) return null;
    if (update.refusal) return `\n\n${update.refusal}\n\n`;
    if (update.content === undefined) return null;
    const opening = `<juno:artifact ${rawAttrs.trim()}>`;
    return `${opening}${update.content}</juno:artifact>`;
  };

  ARTIFACT_RE.lastIndex = 0;
  let rewritten = text.replace(ARTIFACT_RE, (full, rawAttrs: string, content: string) => {
    return replace(rawAttrs, content) ?? full;
  });

  // A trailing block that never closed can be withdrawn, never rewritten.
  // Writing a body into it used to add the missing closing tag, so a stopped
  // revision read as complete on every later load (X-07). The verifier
  // refuses such a block; a content update that names it anyway (its
  // identifier was also used by an earlier, closed block) leaves it exactly
  // as it arrived rather than sealing it.
  const lastClose = rewritten.lastIndexOf("</juno:artifact>");
  const tailStart = lastClose >= 0 ? lastClose + "</juno:artifact>".length : 0;
  const tail = rewritten.slice(tailStart);
  const open = OPEN_ARTIFACT_RE.exec(tail);
  if (open) {
    const update = byId.get(artifactId(parseAttrs(open[1]), open[2]));
    if (update?.refusal) rewritten = `${rewritten.slice(0, tailStart + open.index)}\n\n${update.refusal}\n\n`;
  }
  return rewritten;
}

/**
 * The attribute a held tag carries: the id of the `ArtifactProposal` that holds
 * the body instead of the message (the re-emit guard, src/lib/artifact-proposals.ts).
 */
export const HELD_ARTIFACT_ATTR = "suggestion";

/** An attribute value, quoted so `parseAttrs` reads it back unchanged. */
function quoteAttr(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  // Neither quote survives inside the other; a title is the only value that
  // could hold both, and losing its double quotes beats breaking the tag.
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * Save a held re-emit in the legacy tag form, with its body left out.
 *
 * Every tag whose identifier is in `held` becomes a closed, EMPTY-body tag that
 * keeps `identifier`, `type` and `title` and gains `suggestion="<proposal id>"`
 * (04-MERGE-PLAN §3.7 E). The body lives in the proposal until a person
 * applies it, so the message never carries content that is not a version:
 *  - `parseArtifacts` skips an empty body, so no later re-parse (a reload, an
 *    import, a re-run) can turn it into a version by accident;
 *  - `splitMessageContent` still yields a card part, and the web card resolves
 *    the artifact by identifier and shows its current version with the bar;
 *  - installed Mac and iPhone builds draw no card and no tag text for an empty
 *    body, so they never show unapplied work as the artifact.
 * The identifier is always written out, even when the model omitted it: the
 * fallback hashes the body, and the body is what is being removed.
 *
 * Only closed tags are held; an unfinished one is never a version or a
 * suggestion (X-07). Every other tag is left exactly as it was.
 */
export function holdArtifactBodies(text: string, held: ReadonlyMap<string, string>): string {
  if (held.size === 0) return text;
  ARTIFACT_RE.lastIndex = 0;
  return text.replace(ARTIFACT_RE, (full, rawAttrs: string, content: string) => {
    const attrs = parseAttrs(rawAttrs);
    const identifier = artifactId(attrs, content);
    const suggestion = held.get(identifier);
    if (!suggestion) return full;
    const title = attrs.title || "Untitled";
    const type = attrs.type || normalizeType(attrs.type).toLowerCase();
    return (
      `<juno:artifact identifier=${quoteAttr(identifier)} type=${quoteAttr(type)} title=${quoteAttr(title)} ` +
      `${HELD_ARTIFACT_ATTR}=${quoteAttr(suggestion)}></juno:artifact>`
    );
  });
}

/**
 * The model's view of a held tag: one line that says a suggestion is waiting,
 * instead of an empty artifact.
 *
 * Without it the next turn reads an empty `<juno:artifact>` in its own history
 * and has no way to tell "I wrote nothing" from "the person has not reviewed
 * what I wrote", and either re-emits blind or believes the change landed. A
 * tag counts as held only when it carries `suggestion` AND has no body: a body
 * means the server did not write it, and describing it as waiting would be
 * false.
 */
export function describeHeldArtifactsForModel(text: string): string {
  if (!text.includes(`${HELD_ARTIFACT_ATTR}=`)) return text;
  ARTIFACT_RE.lastIndex = 0;
  return text.replace(ARTIFACT_RE, (full, rawAttrs: string, content: string) => {
    if (content.trim()) return full;
    const attrs = parseAttrs(rawAttrs);
    if (!attrs[HELD_ARTIFACT_ATTR] || !attrs.identifier?.trim()) return full;
    const title = attrs.title || "Untitled";
    return `[Suggested revision of "${title}" (${attrs.identifier.trim()}) is waiting for the person's review; not applied.]`;
  });
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

/**
 * The statements the model was asked to forget, one per tag.
 *
 * Same shape as `parseMemories` and for the same reason: the model's own
 * output is the only channel it has for acting on memory, so the parse is the
 * whole contract. What a statement then MATCHES is decided server-side by the
 * suppression rule, not here.
 */
export function parseForgets(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  FORGET_RE.lastIndex = 0;
  while ((m = FORGET_RE.exec(text))) {
    const statement = m[1].trim();
    if (statement) out.push(statement);
  }
  return out;
}

/**
 * The reply as the user should see, hear or copy it: memory and forget tags
 * removed, including one still streaming in.
 *
 * One function for every surface on purpose. Rendering stripped the memory tag
 * and nothing else did — both copy actions put the raw reply on the clipboard,
 * so pasting an answer anywhere pasted "<juno:memory>The user …</juno:memory>"
 * with it, the user's own profile in a document they may be sending to
 * someone else.
 */
export function stripMemoryTags(text: string): string {
  return text.replace(MEMORY_RE, "").replace(FORGET_RE, "").replace(OPEN_MEMORY_TAIL_RE, "");
}

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "artifact";
      identifier: string;
      streaming?: boolean;
      title?: string;
      artifactType?: ArtifactType;
      language?: string;
      content?: string;
    }
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
  const stripped = stripMemoryTags(raw).replace(CLARIFICATION_WIZARD_RE, "");
  // An edit to a semantic artifact (src/lib/artifact-ops.ts) streams as an
  // operations block; the server rewrites it into the artifact tag before the
  // message is saved. While it streams it is shown as a reference to the
  // artifact being edited, never as raw JSON.
  const pendingEdit = ARTIFACT_OPS_TAIL_RE.exec(stripped);
  const text = (pendingEdit ? stripped.slice(0, pendingEdit.index) : stripped).replace(
    ARTIFACT_OPS_BLOCK_RE,
    (_full, rawAttrs: string) => `<juno:artifact ${rawAttrs.trim()}></juno:artifact>`
  );
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
    parts.push({
      type: "artifact",
      identifier: artifactId(attrs, open[2]),
      streaming: true,
      title: attrs.title || "Untitled artifact",
      artifactType: normalizeType(attrs.type),
      language: attrs.language || undefined,
      content: open[2],
    });
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

  if (pendingEdit) {
    const identifier = /identifier\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(pendingEdit[0]);
    parts.push({ type: "artifact", identifier: identifier?.[1] ?? identifier?.[2] ?? "", streaming: true, title: "Editing", content: "" });
  }
  return parts;
}

/** Strip tags and TTS-unfriendly characters so spoken replies sound natural. */
export function cleanForSpeech(text: string): string {
  return stripMemoryTags(text)
    .replace(ARTIFACT_OPS_BLOCK_RE, " I've updated that in the canvas. ")
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
