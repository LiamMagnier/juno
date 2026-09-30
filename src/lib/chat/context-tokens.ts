/**
 * Typed context tokens: the things a person names inside a message.
 *
 * "Compare [Q3 Forecast.xlsx] with [Stripe] and ask [Mira] to flag renewal
 * risk" (docs/rework/PRODUCT_REFOUNDATION.md §5). Each bracket is a token: an
 * atomic object in the sentence that stands for one thing the account owns or
 * can reach — a Library file, a project, an app, a crew member, a skill,
 * another chat, an artifact. The composer draws it with the thing's own mark;
 * the request carries it as data, never as styled text, and the server
 * resolves each one through the mechanism that already exists for that kind
 * (src/lib/chat/context-resolution.ts).
 *
 * THE ENCODING: plain text plus offsets. The message stays the plain sentence a
 * person reads, with every token's label written into it where the chip sits,
 * and each token carries `range: { start, end }` into that text. So:
 *
 *   - history renders without the tokens (the words are all there), and with
 *     them when a client has the ranges;
 *   - search, titles, memory extraction and moderation all keep reading the
 *     same plain text they always have;
 *   - an older client, or a native build that predates tokens, sends and
 *     shows exactly what it does today.
 *
 * Offsets are UTF-16 code units — JavaScript string indices, and
 * `NSString`/`String.utf16` on the Swift side, NOT Swift `Character`s. The
 * slice at a range must equal the token's label exactly (no leading "@"), and
 * ranges may not overlap. A range is presentation only: a token with no range
 * still resolves, and a range that does not fit the stored text is dropped
 * rather than failing the turn.
 *
 * Pure and client-safe: zod only, no Prisma, no `server-only`, no node:crypto.
 * The web composer, the chat hook, the serializer and the tests all import it.
 */
import { z } from "zod";

export const CONTEXT_TOKEN_KINDS = ["file", "project", "app", "crew", "skill", "chat", "artifact"] as const;
export type ContextTokenKind = (typeof CONTEXT_TOKEN_KINDS)[number];

/** Tokens one message may carry. Well above what a sentence names; a bound on lookups, not a product limit. */
export const MAX_CONTEXT_TOKENS = 16;
export const MAX_CONTEXT_TOKEN_LABEL_CHARS = 120;
export const MAX_CONTEXT_TOKEN_ID_CHARS = 128;
/** Above the message ceiling in request-limits.ts; a range past the text is caught against the text itself. */
export const MAX_CONTEXT_TOKEN_OFFSET = 2_000_000;

/**
 * Ids per kind. Every row-backed kind is a Prisma cuid. An app is a connector
 * id, which has three shapes: a built-in (`github`), a Composio app
 * (`composio:gmail`) and a user MCP server (`user_mcp:<cuid>`).
 */
const CUID = /^c[a-z0-9]{7,40}$/i;
const CONNECTOR_ID = /^(?:[a-z0-9][a-z0-9_-]{0,63}|composio:[a-z0-9][a-z0-9_-]{0,63}|user_mcp:c[a-z0-9]{7,40})$/i;

export function isContextTokenId(kind: ContextTokenKind, id: string): boolean {
  if (id.length === 0 || id.length > MAX_CONTEXT_TOKEN_ID_CHARS) return false;
  return kind === "app" ? CONNECTOR_ID.test(id) : CUID.test(id);
}

/** No control characters: a label is a name written into a sentence, and a newline in one is a second line of prompt. */
const LABEL = /^[^\u0000-\u001f\u007f]+$/;

export const contextTokenRangeSchema = z
  .object({
    start: z.number().int().min(0).max(MAX_CONTEXT_TOKEN_OFFSET),
    end: z.number().int().min(1).max(MAX_CONTEXT_TOKEN_OFFSET),
  })
  .refine((range) => range.end > range.start, { message: "A token range must end after it starts." });

export type ContextTokenRange = z.infer<typeof contextTokenRangeSchema>;

/**
 * Hints a client may send so another client can draw the token the same way.
 * Never authority: the server re-reads every name, kind and permission from
 * the account's own rows, and ignores these for anything but echoing.
 * Unknown keys are stripped (not refused) so a newer client never 400s an
 * older server.
 */
export const contextTokenMetaSchema = z.object({
  /** An icon key from the mention search (`file:pdf`, `app:github`, `artifact:html`). */
  icon: z
    .string()
    .max(64)
    .regex(/^[a-z0-9_:.-]+$/i)
    .optional(),
  /** The secondary line the palette showed ("Project", "PDF", a role). */
  subtitle: z.string().max(160).optional(),
});

export const contextTokenSchema = z
  .object({
    kind: z.enum(CONTEXT_TOKEN_KINDS),
    id: z.string().min(1).max(MAX_CONTEXT_TOKEN_ID_CHARS),
    label: z.string().trim().min(1).max(MAX_CONTEXT_TOKEN_LABEL_CHARS).regex(LABEL),
    range: contextTokenRangeSchema.optional(),
    meta: contextTokenMetaSchema.optional(),
  })
  .superRefine((token, ctx) => {
    if (!isContextTokenId(token.kind, token.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: `Not a ${token.kind} id.`,
      });
    }
  });

export type ContextToken = z.infer<typeof contextTokenSchema>;

export const contextTokensSchema = z.array(contextTokenSchema).max(MAX_CONTEXT_TOKENS);

/** The identity a token resolves by. Two chips for the same file are one file. */
export function contextTokenKey(token: Pick<ContextToken, "kind" | "id">): string {
  return `${token.kind}:${token.id}`;
}

// ---------------------------------------------------------------------------
// Ranges against the text
// ---------------------------------------------------------------------------

export type ContextRangeIssueCode = "out_of_bounds" | "overlap" | "label_mismatch";

export interface ContextRangeIssue {
  index: number;
  code: ContextRangeIssueCode;
  message: string;
}

/**
 * Everything wrong with the ranges, against the text they were sent with.
 *
 * Checked by the request schema whenever `message` is present, because a
 * client that sends a range the text cannot carry has a bug the person would
 * otherwise meet as a chip drawn over the wrong words. Tokens without a range
 * are not checked: they are a valid encoding of "this, somewhere in the
 * sentence".
 */
export function contextRangeIssues(text: string, tokens: readonly Pick<ContextToken, "label" | "range">[]): ContextRangeIssue[] {
  const issues: ContextRangeIssue[] = [];
  const placed: Array<{ index: number; start: number; end: number }> = [];
  tokens.forEach((token, index) => {
    const range = token.range;
    if (!range) return;
    if (range.end > text.length) {
      issues.push({ index, code: "out_of_bounds", message: "The token's range runs past the end of the message." });
      return;
    }
    if (text.slice(range.start, range.end) !== token.label) {
      issues.push({ index, code: "label_mismatch", message: "The message text at the token's range is not its label." });
      return;
    }
    placed.push({ index, start: range.start, end: range.end });
  });
  placed.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i].start < placed[i - 1].end) {
      issues.push({ index: placed[i].index, code: "overlap", message: "Two tokens cover the same words." });
    }
  }
  return issues;
}

/**
 * The ranges moved onto the text the server stores.
 *
 * The route persists `message.trim()`, so a range sent against a message with
 * leading whitespace would point a few characters late on every reload. This
 * shifts each range by what the trim removed and drops any that no longer fit
 * the stored text or no longer frame the label — presentation only, so a
 * dropped range costs a chip, never the token.
 */
export function rangesForStoredText<T extends Pick<ContextToken, "label" | "range">>(
  sent: string,
  tokens: readonly T[]
): T[] {
  const stored = sent.trim();
  const shift = sent.length - sent.trimStart().length;
  return tokens.map((token) => {
    if (!token.range) return token;
    const start = token.range.start - shift;
    const end = token.range.end - shift;
    const fits = start >= 0 && end <= stored.length && stored.slice(start, end) === token.label;
    if (fits) return { ...token, range: { start, end } };
    const { range: _dropped, ...rest } = token;
    void _dropped;
    return rest as T;
  });
}

// ---------------------------------------------------------------------------
// Segments, for any client that draws a message
// ---------------------------------------------------------------------------

export type ContextSegment =
  | { kind: "text"; text: string }
  | { kind: "token"; text: string; token: Pick<ContextToken, "kind" | "id" | "label"> };

/**
 * A message split into runs of plain text and tokens, in order.
 *
 * The one function every surface needs to draw a sent message with its chips.
 * Tolerant by design: ranges that do not fit, do not frame their label or
 * overlap an earlier token are ignored, and the words stay plain text, so a
 * reload can never draw a chip over the wrong words. Concatenating every
 * segment's `text` always gives back `text` exactly.
 */
export function segmentWithTokens(
  text: string,
  tokens: readonly Pick<ContextToken, "kind" | "id" | "label" | "range">[]
): ContextSegment[] {
  const placed = tokens
    .filter((token): token is typeof token & { range: ContextTokenRange } => {
      const range = token.range;
      return !!range && range.end <= text.length && text.slice(range.start, range.end) === token.label;
    })
    .sort((a, b) => a.range.start - b.range.start);
  const out: ContextSegment[] = [];
  let cursor = 0;
  for (const token of placed) {
    if (token.range.start < cursor) continue;
    if (token.range.start > cursor) out.push({ kind: "text", text: text.slice(cursor, token.range.start) });
    out.push({
      kind: "token",
      text: text.slice(token.range.start, token.range.end),
      token: { kind: token.kind, id: token.id, label: token.label },
    });
    cursor = token.range.end;
  }
  if (cursor < text.length || out.length === 0) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

// ---------------------------------------------------------------------------
// The approval preview an app token carries
// ---------------------------------------------------------------------------

/**
 * What using an app will ask for, before anything is sent.
 *
 * Computed on the server from the account's approval policy through the same
 * `decideActionPolicy` the broker runs (src/lib/chat/app-approval-preview.ts),
 * so the sentence the composer shows ("Posting to Slack will ask you first")
 * is the rule that will actually apply. `sends` and `deletes` have no "allow":
 * sending, posting, publishing and deleting sit on the always-confirm floor,
 * which no setting lowers.
 */
export const APPROVAL_VERDICTS = ["allow", "ask", "block"] as const;
export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number];

export const appApprovalPreviewSchema = z.object({
  /** Reading from the app (search, list, fetch). */
  reads: z.enum(APPROVAL_VERDICTS),
  /** Changes that can be undone (label, archive, move, draft). */
  changes: z.enum(APPROVAL_VERDICTS),
  /** Sending, posting, publishing, creating things other people see. */
  sends: z.enum(["ask", "block"]),
  /** Deleting, paying, changing permissions or credentials. */
  deletes: z.enum(["ask", "block"]),
  /** One sentence the composer can show as is. */
  summary: z.string().max(300),
});

export type AppApprovalPreview = z.infer<typeof appApprovalPreviewSchema>;

// ---------------------------------------------------------------------------
// The receipt: what became of each token
// ---------------------------------------------------------------------------

/** How a token reached the turn. One per kind, except crew, which is handed off or consulted. */
export const CONTEXT_TOKEN_VIAS = [
  "attachment",
  "project_context",
  "connector",
  "handoff",
  "consult",
  "skill",
  "chat_excerpt",
  "artifact_excerpt",
  "already_in_context",
] as const;
export type ContextTokenVia = (typeof CONTEXT_TOKEN_VIAS)[number];

/** Why a token did not reach the turn, or what it still needs. */
export const CONTEXT_TOKEN_CODES = [
  /** Not the account's, or gone. Deliberately one code: a token must not reveal whether someone else's id exists. */
  "not_found",
  /** An app that is not connected (or whose sign-in expired). `connect` says where to fix it. */
  "needs_connection",
  /** Blocked in Settings › Apps, or Lockdown is on. */
  "blocked",
  /** The project's assistant setup does not allow it in this chat. */
  "workspace_denied",
  /** More apps than one turn may carry. */
  "connector_limit",
  /** More files than one message may carry. */
  "attachment_limit",
  /** More of this kind than one message resolves. */
  "too_many",
  /** Incognito chats resolve only skills: nothing else reads or writes the account's rows. */
  "private_mode",
  /** Another skill was already armed for this message; one skill per message. */
  "skill_conflict",
  /** The skill exists but could not apply (switched off, blocked, awaiting consent). */
  "skill_refused",
  /** This chat, from inside itself. */
  "self",
  /** Known kind, but not available on this server or in this turn. */
  "unavailable",
] as const;
export type ContextTokenCode = (typeof CONTEXT_TOKEN_CODES)[number];

export const contextTokenResolutionSchema = z.object({
  kind: z.enum(CONTEXT_TOKEN_KINDS),
  id: z.string().min(1).max(MAX_CONTEXT_TOKEN_ID_CHARS),
  /** The account's own name for it when it resolved; the sent label otherwise. */
  label: z.string().min(1).max(MAX_CONTEXT_TOKEN_LABEL_CHARS),
  /** Every place in the stored user message this token was drawn. */
  ranges: z.array(contextTokenRangeSchema).max(MAX_CONTEXT_TOKENS).optional(),
  outcome: z.enum(["applied", "dropped"]),
  via: z.enum(CONTEXT_TOKEN_VIAS).optional(),
  code: z.enum(CONTEXT_TOKEN_CODES).optional(),
  /** One sentence for a person, already written. */
  message: z.string().max(400).optional(),
  /** For `needs_connection`: where connecting it starts. */
  connect: z
    .object({
      connectorId: z.string().min(1).max(MAX_CONTEXT_TOKEN_ID_CHARS),
      href: z.string().min(1).max(300),
    })
    .optional(),
  /** For apps: what using it will ask for. */
  approval: appApprovalPreviewSchema.optional(),
});

export type ContextTokenResolution = z.infer<typeof contextTokenResolutionSchema>;

export const contextReceiptSchema = z.object({
  version: z.literal(1),
  tokens: z.array(contextTokenResolutionSchema).max(MAX_CONTEXT_TOKENS),
});

export type ContextReceipt = z.infer<typeof contextReceiptSchema>;

/**
 * A stored receipt, or undefined.
 *
 * The serializer's activity whitelist calls this for the `contextReceipt` key,
 * so a row that does not parse is dropped from the reload rather than handed
 * to a renderer that trusts its shape.
 */
export function readContextReceipt(value: unknown): ContextReceipt | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = contextReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The tokens a receipt stood for, as a request would carry them again.
 *
 * Two readers: a regenerate that did not re-send its tokens (the server
 * re-resolves what the answer being replaced was given, ownership checked
 * again), and a client drawing the chips of a sent message from the reply's
 * receipt. Only APPLIED tokens come back: a token that was dropped last time
 * is not quietly retried. Ranges come back one token per range, since that is
 * how a request carries them.
 */
export function contextTokensFromReceipt(receipt: ContextReceipt | undefined): ContextToken[] {
  if (!receipt) return [];
  const out: ContextToken[] = [];
  for (const entry of receipt.tokens) {
    if (entry.outcome !== "applied") continue;
    if (!isContextTokenId(entry.kind, entry.id)) continue;
    const label = entry.label.trim().slice(0, MAX_CONTEXT_TOKEN_LABEL_CHARS);
    if (!label || !LABEL.test(label)) continue;
    const ranges = entry.ranges ?? [];
    if (ranges.length === 0) out.push({ kind: entry.kind, id: entry.id, label });
    for (const range of ranges) out.push({ kind: entry.kind, id: entry.id, label, range });
  }
  return out.slice(0, MAX_CONTEXT_TOKENS);
}

/** The receipt inside a reply's activity log, if it has one. */
export function contextReceiptFromActivity(
  activity: readonly { contextReceipt?: unknown }[] | null | undefined
): ContextReceipt | undefined {
  if (!activity) return undefined;
  for (const event of activity) {
    const receipt = readContextReceipt(event?.contextReceipt);
    if (receipt) return receipt;
  }
  return undefined;
}
