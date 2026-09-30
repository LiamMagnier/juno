/**
 * The mention palette's vocabulary: what GET /api/mentions returns, and how a
 * client turns a row into a context token.
 *
 * Typing "@" in any composer (web, Mac, iPhone) opens one palette over the
 * seven kinds of thing a message can name (docs/rework/PRODUCT_REFOUNDATION.md
 * §5). Each row is enough to insert a token — `{ kind, id, label }` — and to
 * draw it with the thing's own mark (`icon`, and `avatar` for crew). An app row
 * also says whether it needs connecting and what using it will ask first, so
 * the composer can say "Posting to #design will ask you first" before send.
 *
 * Pure and client-safe.
 */
import type { AgentAvatar } from "@/lib/agents/avatar";
import {
  CONTEXT_TOKEN_KINDS,
  isContextTokenId,
  type AppApprovalPreview,
  type ContextToken,
  type ContextTokenKind,
} from "@/lib/chat/context-tokens";

/** The order groups are drawn in, and the tie-break between kinds: who, then what, then where. */
export const MENTION_KIND_ORDER: readonly ContextTokenKind[] = ["crew", "file", "project", "app", "skill", "chat", "artifact"];

export const DEFAULT_MENTION_LIMIT = 6;
export const MAX_MENTION_LIMIT = 10;
export const MAX_MENTION_QUERY_CHARS = 100;
export const MAX_MENTION_IDS = 20;

export interface MentionItem {
  kind: ContextTokenKind;
  id: string;
  /** What the token says in the sentence. */
  label: string;
  /** The palette's second line: a role, a file type, the chat an artifact is in. */
  subtitle?: string;
  /**
   * What to draw. `crew`, `project`, `skill`, `chat`, or a keyed variant:
   * `file:<pdf|image|sheet|slides|doc|code|text|audio|video|archive|generic>`,
   * `app:<connectorId>` (the brand mark every client already draws by id),
   * `artifact:<html|react|code|markdown|svg|mermaid|design>`.
   */
  icon: string;
  /** Crew: the face, as the four closed words every client draws. */
  avatar?: AgentAvatar;
  /** Crew: paused members can be consulted but not handed work. */
  paused?: boolean;
  /** App: the connector id (also `id`), for the brand mark. */
  connectorId?: string;
  /** App: false when it has to be connected (or switched on) before it can be used. */
  connected?: boolean;
  /** App: true when choosing it should offer to connect it in place. */
  needsConnection?: boolean;
  /** App: where connecting starts. */
  connectHref?: string;
  /** App: what using it will ask first, from the account's approval policy. */
  approval?: AppApprovalPreview;
  /** File. */
  mimeType?: string;
  size?: number;
  /** Skill: the slug `/` would arm it by. */
  slug?: string;
  /** Chat: filed under a project. */
  projectId?: string | null;
  /** ISO time of the last change: the recency the palette orders an empty query by. */
  updatedAt?: string;
  /** Rank within the result, higher first. Relative only. */
  score: number;
}

export interface MentionSearchResult {
  query: string;
  kinds: ContextTokenKind[];
  items: MentionItem[];
}

/** The token a palette row inserts, with the row's mark as a hint for other clients. */
export function mentionToToken(item: MentionItem, range?: ContextToken["range"]): ContextToken {
  return {
    kind: item.kind,
    id: item.id,
    label: item.label,
    ...(range ? { range } : {}),
    meta: { icon: item.icon, ...(item.subtitle ? { subtitle: item.subtitle.slice(0, 160) } : {}) },
  };
}

/** `kinds=crew,file` → the kinds asked for, in palette order; unknown names dropped; none → all. */
export function parseMentionKinds(raw: string | null | undefined): ContextTokenKind[] {
  const wanted = new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part): part is ContextTokenKind => (CONTEXT_TOKEN_KINDS as readonly string[]).includes(part))
  );
  return wanted.size === 0 ? [...MENTION_KIND_ORDER] : MENTION_KIND_ORDER.filter((kind) => wanted.has(kind));
}

/**
 * `ids=app:github,file:c123…` → exact lookups, for a client refreshing tokens
 * it already holds (a restored draft, a token whose app was just connected).
 * Malformed pairs are dropped rather than refused, like unknown kinds.
 */
export function parseMentionIds(raw: string | null | undefined): Array<{ kind: ContextTokenKind; id: string }> {
  if (!raw) return [];
  const out: Array<{ kind: ContextTokenKind; id: string }> = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const kind = trimmed.slice(0, colon).toLowerCase();
    const id = trimmed.slice(colon + 1);
    if (!(CONTEXT_TOKEN_KINDS as readonly string[]).includes(kind)) continue;
    if (!isContextTokenId(kind as ContextTokenKind, id)) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as ContextTokenKind, id });
    if (out.length >= MAX_MENTION_IDS) break;
  }
  return out;
}

const EXTENSION_VARIANT: Record<string, string> = {
  pdf: "pdf",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  key: "slides",
  doc: "doc",
  docx: "doc",
  pages: "doc",
  rtf: "doc",
  odt: "doc",
  md: "text",
  txt: "text",
  json: "code",
  js: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  swift: "code",
  go: "code",
  rs: "code",
  java: "code",
  html: "code",
  css: "code",
  sql: "code",
  zip: "archive",
  gz: "archive",
  tar: "archive",
};

/** The file icon variant, from the MIME type first and the extension second. */
export function fileIconKey(mimeType: string | null | undefined, fileName: string): string {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "file:image";
  if (mime.startsWith("audio/")) return "file:audio";
  if (mime.startsWith("video/")) return "file:video";
  if (mime === "application/pdf") return "file:pdf";
  if (mime.includes("spreadsheet") || mime === "text/csv") return "file:sheet";
  if (mime.includes("presentation")) return "file:slides";
  if (mime.includes("wordprocessing") || mime === "application/msword") return "file:doc";
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  const variant = EXTENSION_VARIANT[extension];
  if (variant) return `file:${variant}`;
  if (mime.startsWith("text/")) return "file:text";
  return "file:generic";
}

/** A short type word for a file's second line: "PDF", "Spreadsheet", "Image". */
export function fileSubtitle(icon: string): string | undefined {
  switch (icon) {
    case "file:pdf":
      return "PDF";
    case "file:image":
      return "Image";
    case "file:sheet":
      return "Spreadsheet";
    case "file:slides":
      return "Presentation";
    case "file:doc":
      return "Document";
    case "file:code":
      return "Code";
    case "file:text":
      return "Text";
    case "file:audio":
      return "Audio";
    case "file:video":
      return "Video";
    case "file:archive":
      return "Archive";
    default:
      return undefined;
  }
}
