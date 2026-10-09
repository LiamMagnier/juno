/**
 * The semantic document model (BRIEF §29/§30).
 *
 * A document is stored as this model, not as Markdown: an ordered list of typed
 * blocks with stable ids, the sources its citations point at, the comments
 * anchored on its blocks and the tracked changes suggested against them. The
 * chat model edits it through `ops.ts` by naming block ids it read in
 * `outlineDocument`, the canvas renders it, and `docx-export.ts` writes and
 * reads it as a real .docx.
 *
 * Pure: no `docx` import, because the browser canvas imports this file.
 *
 * Inline text is a string with a deliberately small markup, parsed by
 * `parseInline` (shared by the preview and the DOCX writer) and written back by
 * `runsToMarkup` (used by the DOCX reader):
 *
 *   **bold**   *italic*   `code`   [label](https://url)   [@sourceId]
 *
 * A backslash escapes the next markup character (`\*`, `` \` ``, `\[`, `\]`,
 * `\\`); any other backslash is literal text.
 */

import { z } from "zod";
import {
  SemanticError,
  cloneModel,
  describeIssues,
  isAllowedImageSource,
  nextId,
  oneLine,
} from "@/lib/work/deliverables/semantic/shared";
import { LIVE_UI_MAX_SOURCE } from "@/lib/live-ui/json";
import { parseLiveUI, type LiveSpec } from "@/lib/live-ui/spec";
import { liveUISummaryLines } from "@/lib/live-ui/summary";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const DOCUMENT_LIMITS = {
  blocks: 2_000,
  textChars: 20_000,
  tableRows: 200,
  tableColumns: 20,
  listItems: 500,
  comments: 1_000,
  revisions: 1_000,
  sources: 500,
  /** A figure's data URI. Big enough for a real chart, small enough to store. */
  imageSrcChars: 8_000_000,
} as const;

/** Ids are short and readable in an outline: `b7`, `c2`, `r1`, `src3`, or an author-chosen slug. */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CITATION = /\[@([A-Za-z][A-Za-z0-9_-]{0,63})\]/g;

const idSchema = z.string().regex(ID_PATTERN, "ids are a letter followed by letters, digits, _ or -");
const textSchema = z.string().max(DOCUMENT_LIMITS.textChars);
const requiredTextSchema = textSchema.refine((value) => value.trim().length > 0, "text cannot be empty");
const shortTextSchema = z.string().trim().max(300);
const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date")
  .transform((value) => new Date(value).toISOString());

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A Live UI view (docs/design/LIVE_UI.md) living in a document: the same JSON
 * a ```live-ui fence holds in chat. The canvas runs it; the .docx export and
 * the plain text keep its readable parts (``interactiveSummary``).
 */
const liveViewSchema = z
  .record(z.string(), z.unknown())
  .refine((view) => JSON.stringify(view).length <= LIVE_UI_MAX_SOURCE, `a view is at most ${LIVE_UI_MAX_SOURCE} characters of JSON`)
  .refine((view) => (parseLiveUI(JSON.stringify(view)).spec?.ui.length ?? 0) > 0, "view must be a Live UI view with at least one component");

const listItemSchema = z.object({
  text: requiredTextSchema,
  level: z.number().int().min(0).max(2).default(0),
});

/** The authoring form also takes a bare string for a level-0 item. */
const authoringListItemSchema = z.union([
  requiredTextSchema.transform((text) => ({ text, level: 0 })),
  listItemSchema,
]);

function blockVariants<I extends z.ZodType, L extends z.ZodType>(id: I, listItem: L) {
  return z.discriminatedUnion("type", [
    z.object({
      id,
      type: z.literal("heading"),
      level: z.number().int().min(1).max(4),
      text: requiredTextSchema,
    }),
    z.object({
      id,
      type: z.literal("paragraph"),
      text: requiredTextSchema,
      style: z.enum(["normal", "lead", "quote"]).optional(),
    }),
    z.object({
      id,
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(listItem).min(1).max(DOCUMENT_LIMITS.listItems),
    }),
    z.object({
      id,
      type: z.literal("table"),
      header: z.array(textSchema).min(1).max(DOCUMENT_LIMITS.tableColumns),
      rows: z.array(z.array(textSchema).max(DOCUMENT_LIMITS.tableColumns)).max(DOCUMENT_LIMITS.tableRows),
      caption: shortTextSchema.optional(),
    }),
    z.object({
      id,
      type: z.literal("callout"),
      tone: z.enum(["note", "tip", "warning"]),
      title: shortTextSchema.optional(),
      text: requiredTextSchema,
    }),
    z.object({
      id,
      type: z.literal("figure"),
      src: z
        .string()
        .max(DOCUMENT_LIMITS.imageSrcChars)
        .refine(isAllowedImageSource, "an image must be a PNG, JPEG, GIF or WebP data URI or an https URL"),
      alt: z.string().trim().min(1).max(500),
      caption: shortTextSchema.optional(),
      widthPct: z.number().int().min(10).max(100).optional(),
    }),
    z.object({
      id,
      type: z.literal("interactive"),
      view: liveViewSchema,
      caption: shortTextSchema.optional(),
    }),
    z.object({ id, type: z.literal("pageBreak") }),
  ]);
}

export const blockSchema = blockVariants(idSchema, listItemSchema);
/** A block as the chat model writes it: `id` optional, list items may be bare strings. */
export const authoringBlockSchema = blockVariants(idSchema.optional(), authoringListItemSchema);

export type Block = z.infer<typeof blockSchema>;
export type AuthoringBlock = z.input<typeof authoringBlockSchema>;
export type BlockType = Block["type"];
export type ListItem = z.infer<typeof listItemSchema>;
export type HeadingBlock = Extract<Block, { type: "heading" }>;
export type ParagraphBlock = Extract<Block, { type: "paragraph" }>;
export type ListBlock = Extract<Block, { type: "list" }>;
export type TableBlock = Extract<Block, { type: "table" }>;
export type CalloutBlock = Extract<Block, { type: "callout" }>;
export type FigureBlock = Extract<Block, { type: "figure" }>;
export type InteractiveBlock = Extract<Block, { type: "interactive" }>;

/** An interactive block's view, parsed; null only if the stored JSON stopped parsing. */
export function interactiveSpec(block: InteractiveBlock): LiveSpec | null {
  return parseLiveUI(JSON.stringify(block.view)).spec;
}

/** An interactive block as a title and readable lines, for export and plain text. */
export function interactiveSummary(block: InteractiveBlock): { title: string; lines: string[] } {
  const spec = interactiveSpec(block);
  return { title: spec?.title ?? block.caption ?? "Interactive view", lines: spec ? liveUISummaryLines(spec) : [] };
}
/** The blocks whose single `text` an edit or a tracked change can rewrite. */
export type TextBlock = HeadingBlock | ParagraphBlock | CalloutBlock;

export function isTextBlock(block: Block): block is TextBlock {
  return block.type === "heading" || block.type === "paragraph" || block.type === "callout";
}

// ---------------------------------------------------------------------------
// Sources, comments, revisions, metadata, styles
// ---------------------------------------------------------------------------

function sourceVariant<I extends z.ZodType>(id: I) {
  return z.object({
    id,
    title: z.string().trim().min(1).max(500),
    url: z
      .string()
      .max(2_000)
      .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), "a source url must be http(s)")
      .optional(),
    publisher: shortTextSchema.optional(),
    accessed: z.string().trim().max(40).optional(),
  });
}

export const sourceSchema = sourceVariant(idSchema);
export const authoringSourceSchema = sourceVariant(idSchema.optional());
export type Source = z.infer<typeof sourceSchema>;

const authorSchema = z.string().trim().min(1).max(120);

function commentVariant<I extends z.ZodType, A extends z.ZodType, D extends z.ZodType>(id: I, author: A, date: D) {
  return z.object({
    id,
    blockId: idSchema,
    author,
    text: requiredTextSchema,
    createdAt: date,
    resolved: z.boolean().optional(),
    quote: z.string().max(2_000).optional(),
  });
}

export const commentSchema = commentVariant(idSchema, authorSchema, isoDateSchema);
export type Comment = z.infer<typeof commentSchema>;

export const revisionKinds = ["replace", "insert", "delete"] as const;
export type RevisionKind = (typeof revisionKinds)[number];

function revisionVariant<I extends z.ZodType, A extends z.ZodType, D extends z.ZodType, S extends z.ZodType>(
  id: I,
  author: A,
  date: D,
  status: S
) {
  return z.object({
    id,
    blockId: idSchema,
    kind: z.enum(revisionKinds),
    /** The new text for `replace`, the new paragraph for `insert`, empty for `delete`. */
    text: textSchema,
    author,
    createdAt: date,
    status,
  });
}

const revisionStatusSchema = z.enum(["pending", "accepted", "rejected"]);
export const revisionSchema = revisionVariant(idSchema, authorSchema, isoDateSchema, revisionStatusSchema);
export type Revision = z.infer<typeof revisionSchema>;
export type RevisionStatus = Revision["status"];

const fontSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 ._-]+$/, "a font name is letters, digits, spaces, dots, _ or -");

export const metadataSchema = z.object({
  author: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(300).optional(),
  description: z.string().trim().max(2_000).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language is a BCP 47 tag like en-GB")
    .optional(),
});
export type DocumentMetadata = z.infer<typeof metadataSchema>;

export const stylesSchema = z.object({
  bodyFont: fontSchema.optional(),
  headingFont: fontSchema.optional(),
  baseSizePt: z.number().min(9).max(16).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "an accent is #rrggbb")
    .transform((value) => value.toLowerCase())
    .optional(),
});
export type DocumentStyles = z.infer<typeof stylesSchema>;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const documentModelSchema = z.object({
  kind: z.literal("document"),
  version: z.literal(1),
  title: z.string().trim().min(1).max(300),
  metadata: metadataSchema,
  styles: stylesSchema,
  sources: z.array(sourceSchema).max(DOCUMENT_LIMITS.sources),
  blocks: z.array(blockSchema).max(DOCUMENT_LIMITS.blocks),
  comments: z.array(commentSchema).max(DOCUMENT_LIMITS.comments),
  revisions: z.array(revisionSchema).max(DOCUMENT_LIMITS.revisions),
});

export type DocumentModel = z.infer<typeof documentModelSchema>;

/** The authoring form: everything but `title` and `blocks` optional, ids optional. */
function authoringDocumentSchema(now: string) {
  return z.object({
    kind: z.literal("document").default("document"),
    version: z.literal(1).default(1),
    title: z.string().trim().min(1).max(300),
    metadata: metadataSchema.default({}),
    styles: stylesSchema.default({}),
    sources: z.array(authoringSourceSchema).max(DOCUMENT_LIMITS.sources).default([]),
    blocks: z.array(authoringBlockSchema).max(DOCUMENT_LIMITS.blocks),
    comments: z
      .array(commentVariant(idSchema.optional(), authorSchema.default(DEFAULT_AUTHOR), isoDateSchema.default(now)))
      .max(DOCUMENT_LIMITS.comments)
      .default([]),
    revisions: z
      .array(
        revisionVariant(
          idSchema.optional(),
          authorSchema.default(DEFAULT_AUTHOR),
          isoDateSchema.default(now),
          revisionStatusSchema.default("pending")
        ).extend({ text: textSchema.default("") })
      )
      .max(DOCUMENT_LIMITS.revisions)
      .default([]),
  });
}

/** Who a comment or suggestion is from when the author is not named. */
export const DEFAULT_AUTHOR = "Alevr";

/**
 * Untrusted JSON (the chat model's authoring form, a stored body, a reopened
 * .docx) -> a validated model with every id assigned.
 *
 * Refuses rather than repairs: a ragged table, a citation to a source that is
 * not listed, an image from anywhere but a data URI or https, a comment on a
 * block that does not exist. `options.now` stamps comments and revisions that
 * arrive without a date.
 */
export function normalizeDocument(input: unknown, options: { now?: Date } = {}): DocumentModel {
  if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as { blocks?: unknown }).blocks) &&
    (input as { blocks: unknown[] }).blocks.length > DOCUMENT_LIMITS.blocks
  ) {
    throw new SemanticError(
      "too_large",
      `A document holds at most ${DOCUMENT_LIMITS.blocks} blocks; this one has ${(input as { blocks: unknown[] }).blocks.length}.`
    );
  }
  const now = (options.now ?? new Date()).toISOString();
  const parsed = authoringDocumentSchema(now).safeParse(input);
  if (!parsed.success) throw new SemanticError("invalid_model", describeIssues(parsed.error.issues));
  const draft = parsed.data;

  // Every id, explicit or assigned, is unique across the whole model, so an
  // outline line `[x]` names exactly one thing.
  const taken = new Set<string>();
  const claim = (id: string | undefined, where: string): void => {
    if (id === undefined) return;
    if (taken.has(id)) throw new SemanticError("invalid_model", `${where}: the id "${id}" is used twice.`);
    taken.add(id);
  };
  draft.sources.forEach((source, index) => claim(source.id, `sources.${index}`));
  draft.blocks.forEach((block, index) => claim(block.id, `blocks.${index}`));
  draft.comments.forEach((comment, index) => claim(comment.id, `comments.${index}`));
  draft.revisions.forEach((revision, index) => claim(revision.id, `revisions.${index}`));
  const assign = (prefix: string): string => {
    const id = nextId(prefix, taken);
    taken.add(id);
    return id;
  };

  const model: DocumentModel = {
    kind: "document",
    version: 1,
    title: draft.title,
    metadata: stripUndefined(draft.metadata),
    styles: stripUndefined(draft.styles),
    sources: draft.sources.map((source) => stripUndefined({ ...source, id: source.id ?? assign("src") })),
    blocks: draft.blocks.map((block) => stripUndefined({ ...block, id: block.id ?? assign("b") }) as Block),
    comments: draft.comments.map((comment) => stripUndefined({ ...comment, id: comment.id ?? assign("c") })),
    revisions: draft.revisions.map((revision) => ({ ...revision, id: revision.id ?? assign("r") })),
  };

  checkIntegrity(model);
  return model;
}

function stripUndefined<T extends object>(value: T): T {
  const out = {} as T;
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

function checkIntegrity(model: DocumentModel): void {
  const sourceIds = new Set(model.sources.map((source) => source.id));
  const blocks = new Map(model.blocks.map((block) => [block.id, block]));
  const fail = (message: string): never => {
    throw new SemanticError("invalid_model", message);
  };
  const checkCitations = (text: string | undefined, where: string): void => {
    if (!text) return;
    for (const match of text.matchAll(CITATION)) {
      if (!sourceIds.has(match[1])) {
        fail(`${where}: the citation [@${match[1]}] names no source. Add the source first, or remove the citation.`);
      }
    }
  };

  model.blocks.forEach((block, index) => {
    const where = `blocks.${index} (${block.id})`;
    for (const text of blockTexts(block)) checkCitations(text, where);
    if (block.type === "table") {
      const width = block.header.length;
      block.rows.forEach((row, rowIndex) => {
        if (row.length !== width) {
          fail(
            `${where}: table row ${rowIndex + 1} has ${row.length} cells but the header has ${width}. ` +
              `Rows are not padded, because a padded row files its values under the wrong headings.`
          );
        }
      });
    }
  });

  model.comments.forEach((comment, index) => {
    if (!blocks.has(comment.blockId)) fail(`comments.${index} (${comment.id}): no block "${comment.blockId}".`);
  });

  const pendingRewrite = new Map<string, string>();
  model.revisions.forEach((revision, index) => {
    const where = `revisions.${index} (${revision.id})`;
    checkCitations(revision.text, where);
    // Accepted and rejected revisions are history: an accepted deletion names a
    // block that is, correctly, gone. Only a pending one must still apply.
    if (revision.status !== "pending") return;
    const block = blocks.get(revision.blockId);
    if (!block) return fail(`${where}: no block "${revision.blockId}".`);
    if (revision.kind === "insert" && revision.text.trim() === "") fail(`${where}: an insertion needs text.`);
    if (revision.kind === "replace" || revision.kind === "delete") {
      if (!isTextBlock(block)) {
        fail(
          `${where}: tracked ${revision.kind}s apply to headings, paragraphs and callouts; ` +
            `${revision.blockId} is a ${block.type}. Edit or delete it directly.`
        );
      }
      if (revision.kind === "replace" && revision.text.trim() === "") fail(`${where}: a replacement needs text.`);
      const other = pendingRewrite.get(revision.blockId);
      if (other) {
        fail(
          `${where}: ${revision.blockId} already has a pending change (${other}); ` +
            `accept or reject it before suggesting another replacement or deletion.`
        );
      }
      pendingRewrite.set(revision.blockId, revision.id);
    }
  });
}

/** Every inline string a block carries, for citation checks and plain text. */
export function blockTexts(block: Block): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [block.text];
    case "callout":
      return block.title ? [block.title, block.text] : [block.text];
    case "list":
      return block.items.map((item) => item.text);
    case "table":
      return [...block.header, ...block.rows.flat(), ...(block.caption ? [block.caption] : [])];
    case "figure":
      return block.caption ? [block.caption] : [];
    case "interactive":
      return block.caption ? [block.caption] : [];
    case "pageBreak":
      return [];
  }
}

/** JSON with the schema's key order, so equal models serialize to equal strings. */
export function serializeDocument(model: DocumentModel): string {
  const ordered = {
    kind: model.kind,
    version: model.version,
    title: model.title,
    metadata: pick(model.metadata, ["author", "subject", "description", "keywords", "language"]),
    styles: pick(model.styles, ["bodyFont", "headingFont", "baseSizePt", "accent"]),
    sources: model.sources.map((source) => pick(source, ["id", "title", "url", "publisher", "accessed"])),
    blocks: model.blocks.map(orderBlock),
    comments: model.comments.map((comment) =>
      pick(comment, ["id", "blockId", "author", "text", "createdAt", "resolved", "quote"])
    ),
    revisions: model.revisions.map((revision) =>
      pick(revision, ["id", "blockId", "kind", "text", "author", "createdAt", "status"])
    ),
  };
  return JSON.stringify(ordered);
}

const BLOCK_KEYS: Record<BlockType, string[]> = {
  heading: ["id", "type", "level", "text"],
  paragraph: ["id", "type", "text", "style"],
  list: ["id", "type", "ordered", "items"],
  table: ["id", "type", "header", "rows", "caption"],
  callout: ["id", "type", "tone", "title", "text"],
  figure: ["id", "type", "src", "alt", "caption", "widthPct"],
  interactive: ["id", "type", "view", "caption"],
  pageBreak: ["id", "type"],
};

function orderBlock(block: Block): Record<string, unknown> {
  const out = pick(block, BLOCK_KEYS[block.type]);
  if (block.type === "list") out.items = block.items.map((item) => pick(item, ["text", "level"]));
  return out;
}

function pick(value: object, keys: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

// ---------------------------------------------------------------------------
// Inline markup
// ---------------------------------------------------------------------------

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** An http(s) or mailto target. */
  link?: string;
  /** A citation: the source id. `text` is the id too. */
  cite?: string;
}

interface Flags {
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

const ESCAPABLE = new Set(["\\", "*", "`", "[", "]"]);
const LINK = /^\[((?:\\.|[^\]\\])+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)/;
const CITE = /^\[@([A-Za-z][A-Za-z0-9_-]{0,63})\]/;

/** Inline markup -> styled runs. Unbalanced markers are literal text, never an error. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  parseInto(text, {}, runs);
  return mergeRuns(runs);
}

function push(runs: InlineRun[], text: string, flags: Flags, extra: Partial<InlineRun> = {}): void {
  if (text === "" && !extra.cite) return;
  const run: InlineRun = { text };
  if (flags.bold) run.bold = true;
  if (flags.italic) run.italic = true;
  if (flags.link) run.link = flags.link;
  Object.assign(run, extra);
  runs.push(run);
}

function parseInto(text: string, flags: Flags, runs: InlineRun[]): void {
  let plain = "";
  const flush = () => {
    push(runs, plain, flags);
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        push(runs, text.slice(i + 1, close), flags, { code: true });
        i = close + 1;
        continue;
      }
    }
    if (ch === "[") {
      const rest = text.slice(i);
      const cite = CITE.exec(rest);
      if (cite) {
        flush();
        push(runs, cite[1], flags, { cite: cite[1] });
        i += cite[0].length;
        continue;
      }
      if (!flags.link) {
        const link = LINK.exec(rest);
        if (link) {
          flush();
          parseInto(link[1], { ...flags, link: link[2] }, runs);
          i += link[0].length;
          continue;
        }
      }
    }
    if (ch === "*" && text[i + 1] === "*" && !flags.bold && isOpening(text, i + 2)) {
      const close = findBoldClose(text, i + 2);
      if (close !== -1) {
        flush();
        parseInto(text.slice(i + 2, close), { ...flags, bold: true }, runs);
        i = close + 2;
        continue;
      }
    }
    if (ch === "*" && text[i + 1] !== "*" && !flags.italic && isOpening(text, i + 1)) {
      const close = findItalicClose(text, i + 1);
      if (close !== -1) {
        flush();
        parseInto(text.slice(i + 1, close), { ...flags, italic: true }, runs);
        i = close + 1;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
}

/** A marker opens emphasis only when text follows it directly: `2 * 3 * 4` is arithmetic. */
function isOpening(text: string, contentStart: number): boolean {
  const next = text[contentStart];
  return next !== undefined && !/\s/.test(next);
}

/** Skip an escape or a code span starting at `j`; returns the next index to look at, or -1. */
function skipLiteral(text: string, j: number): number {
  if (text[j] === "\\" && j + 1 < text.length && ESCAPABLE.has(text[j + 1])) return j + 2;
  if (text[j] === "`") {
    const close = text.indexOf("`", j + 1);
    if (close > j + 1) return close + 1;
  }
  return -1;
}

function countStars(text: string): number {
  let count = 0;
  for (let j = 0; j < text.length; j++) {
    const skip = skipLiteral(text, j);
    if (skip !== -1) {
      j = skip - 1;
      continue;
    }
    if (text[j] === "*") count++;
  }
  return count;
}

/**
 * The closing `**` for bold content starting at `start`. In a run of three or
 * more stars the closing pair is the last two (`***x***` is bold around
 * `*x*`) unless that leaves the content with an unpaired star (`**a***b*` is
 * bold `a` then italic `b`).
 */
function findBoldClose(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length) {
    const skip = skipLiteral(text, j);
    if (skip !== -1) {
      j = skip;
      continue;
    }
    if (text[j] === "*" && text[j + 1] === "*" && !/\s/.test(text[j - 1])) {
      let end = j;
      while (text[end] === "*") end++;
      const last = end - 2;
      if (countStars(text.slice(start, last)) % 2 === 0) return last;
      if (countStars(text.slice(start, j)) % 2 === 0) return j;
      j = end;
      continue;
    }
    j++;
  }
  return -1;
}

function findItalicClose(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length) {
    const skip = skipLiteral(text, j);
    if (skip !== -1) {
      j = skip;
      continue;
    }
    if (text[j] === "*" && text[j + 1] === "*") {
      // A bold span nested in the italic one is skipped whole; a pair that
      // opens nothing ends the italic span at its first star.
      const bold = isOpening(text, j + 2) ? findBoldClose(text, j + 2) : -1;
      if (bold !== -1) {
        j = bold + 2;
        continue;
      }
      if (!/\s/.test(text[j - 1])) return j;
      j += 2;
      continue;
    }
    if (text[j] === "*" && !/\s/.test(text[j - 1])) return j;
    j++;
  }
  return -1;
}

function sameStyle(a: InlineRun, b: InlineRun): boolean {
  return (
    !a.cite &&
    !b.cite &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    a.link === b.link
  );
}

/** Join neighbours with the same styling, so one styling is one run. */
export function mergeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (run.text === "" && !run.cite) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, run) && !last.code) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

function escapeAll(text: string): string {
  return text.replace(/[\\*`[\]]/g, (ch) => `\\${ch}`);
}

/**
 * The lightest escaping that usually reads back the same: a backslash only
 * where it would otherwise escape something, a star only where it touches a
 * word, brackets not at all. `runsToMarkup` checks the result and falls back to
 * `escapeAll` when the light form would parse differently.
 */
function escapeLight(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\") out += next === undefined || ESCAPABLE.has(next) ? "\\\\" : "\\";
    else if (ch === "`") out += "\\`";
    else if (ch === "*") {
      const before = text[i - 1];
      const touches = (before !== undefined && !/\s/.test(before)) || (next !== undefined && !/\s/.test(next));
      out += touches || before === undefined || next === undefined ? "\\*" : "*";
    } else out += ch;
  }
  return out;
}

/**
 * Styled runs -> inline markup that `parseInline` reads back to the same runs.
 * Used by the DOCX reader. Emphasis never starts or ends on whitespace (the
 * whitespace moves outside the markers), and whitespace-only emphasis is
 * dropped, because neither would parse back. Plain text is escaped as lightly
 * as still reads back identically, so a reopened "2 * 3" stays "2 * 3".
 */
export function runsToMarkup(input: readonly InlineRun[]): string {
  const strict = renderMarkup(input, escapeAll);
  const light = renderMarkup(input, escapeLight);
  if (light === strict) return strict;
  return JSON.stringify(parseInline(light)) === JSON.stringify(parseInline(strict)) ? light : strict;
}

function renderMarkup(input: readonly InlineRun[], escape: (text: string) => string): string {
  const runs = mergeRuns(
    input.map((run) => {
      if (run.cite || run.code || run.text.trim() !== "") return run;
      return { text: run.text, ...(run.link ? { link: run.link } : {}) };
    })
  );
  let out = "";
  let i = 0;
  while (i < runs.length) {
    const run = runs[i];
    if (run.cite) {
      out += `[@${run.cite}]`;
      i++;
      continue;
    }
    if (run.link) {
      let j = i;
      while (j < runs.length && runs[j].link === run.link && !runs[j].cite) j++;
      const slice = runs.slice(i, j);
      const label = emphasis(slice.map((r) => ({ ...r, link: undefined })), escapeAll);
      out += label.trim() === "" ? escape(slice.map((r) => r.text).join("")) : `[${label}](${run.link})`;
      i = j;
      continue;
    }
    let j = i;
    while (j < runs.length && !runs[j].link && !runs[j].cite) j++;
    out += emphasis(runs.slice(i, j), escape);
    i = j;
  }
  return out;
}

function emphasis(runs: InlineRun[], escape: (text: string) => string): string {
  let out = "";
  let i = 0;
  while (i < runs.length) {
    if (runs[i].bold) {
      let j = i;
      while (j < runs.length && runs[j].bold) j++;
      out += wrap("**", italics(runs.slice(i, j), escape));
      i = j;
    } else {
      let j = i;
      while (j < runs.length && !runs[j].bold) j++;
      out += italics(runs.slice(i, j), escape);
      i = j;
    }
  }
  return out;
}

function italics(runs: InlineRun[], escape: (text: string) => string): string {
  let out = "";
  let i = 0;
  while (i < runs.length) {
    if (runs[i].italic) {
      let j = i;
      while (j < runs.length && runs[j].italic) j++;
      out += wrap("*", runs.slice(i, j).map((run) => leaf(run, escape)).join(""));
      i = j;
    } else {
      out += leaf(runs[i], escape);
      i++;
    }
  }
  return out;
}

function leaf(run: InlineRun, escape: (text: string) => string): string {
  if (run.code && run.text !== "" && !run.text.includes("`")) return `\`${run.text}\``;
  return escape(run.text);
}

function wrap(marker: string, inner: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!match || match[2] === "") return inner;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

/** Inline markup -> the words a reader sees. Citations keep their `[@id]` marker. */
export function inlinePlainText(text: string): string {
  return parseInline(text)
    .map((run) => (run.cite ? `[@${run.cite}]` : run.text))
    .join("");
}

/** Every citation id in an inline string, in order of appearance. */
export function citationsIn(text: string): string[] {
  return [...text.matchAll(CITATION)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Plain text and the outline
// ---------------------------------------------------------------------------

/** The document's words, one block per paragraph, for search and summaries. */
export function documentPlainText(model: DocumentModel): string {
  const parts: string[] = [];
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        parts.push(inlinePlainText(block.text));
        break;
      case "callout":
        parts.push(block.title ? `${inlinePlainText(block.title)}: ${inlinePlainText(block.text)}` : inlinePlainText(block.text));
        break;
      case "list":
        parts.push(
          block.items
            .map((item, index) => `${"  ".repeat(item.level)}${block.ordered ? `${index + 1}.` : "-"} ${inlinePlainText(item.text)}`)
            .join("\n")
        );
        break;
      case "table": {
        const rows = [block.header, ...block.rows].map((row) => row.map(inlinePlainText).join("\t"));
        if (block.caption) rows.push(inlinePlainText(block.caption));
        parts.push(rows.join("\n"));
        break;
      }
      case "figure":
        parts.push(block.caption ? `${block.alt} (${inlinePlainText(block.caption)})` : block.alt);
        break;
      case "interactive": {
        const { title, lines } = interactiveSummary(block);
        parts.push([title, ...lines].join("\n"));
        break;
      }
      case "pageBreak":
        break;
    }
  }
  return parts.filter((part) => part !== "").join("\n\n");
}

const TABLE_OUTLINE_ROWS = 8;

function outlineBlock(block: Block): string[] {
  const id = `[${block.id}]`;
  switch (block.type) {
    case "heading":
      return [`${id} H${block.level} ${oneLine(block.text)}`];
    case "paragraph":
      return [`${id} P${block.style && block.style !== "normal" ? `(${block.style})` : ""} ${oneLine(block.text)}`];
    case "callout":
      return [`${id} CALLOUT(${block.tone})${block.title ? ` "${oneLine(block.title, 60)}"` : ""} ${oneLine(block.text)}`];
    case "list":
      return [
        `${id} LIST ${block.ordered ? "ordered" : "bulleted"}, ${block.items.length} item${block.items.length === 1 ? "" : "s"}`,
        ...block.items.slice(0, 12).map((item, index) => `  ${"  ".repeat(item.level)}${index + 1}. ${oneLine(item.text, 100)}`),
        ...(block.items.length > 12 ? [`  … ${block.items.length - 12} more items`] : []),
      ];
    case "table": {
      const lines = [
        `${id} TABLE ${block.header.length} cols × ${block.rows.length} rows${block.caption ? ` caption: ${oneLine(block.caption, 80)}` : ""}`,
        `  | ${block.header.map((cell) => oneLine(cell, 30)).join(" | ")} |`,
        ...block.rows.slice(0, TABLE_OUTLINE_ROWS).map((row) => `  | ${row.map((cell) => oneLine(cell, 30)).join(" | ")} |`),
      ];
      if (block.rows.length > TABLE_OUTLINE_ROWS) lines.push(`  … ${block.rows.length - TABLE_OUTLINE_ROWS} more rows`);
      return lines;
    }
    case "figure":
      return [
        `${id} FIGURE alt="${oneLine(block.alt, 80)}"${block.caption ? ` caption="${oneLine(block.caption, 80)}"` : ""}${
          block.src.startsWith("data:") ? " (embedded image)" : ` src=${oneLine(block.src, 80)}`
        }`,
      ];
    case "interactive": {
      const { title, lines } = interactiveSummary(block);
      return [`${id} INTERACTIVE "${oneLine(title, 80)}"${block.caption ? ` caption="${oneLine(block.caption, 80)}"` : ""} (${lines.length} readable lines; replace the block to change the view)`];
    }
    case "pageBreak":
      return [`${id} PAGE BREAK`];
  }
}

/**
 * The addressable text the chat model reads before it edits: one `[id]` line
 * per block, then sources, comments and pending tracked changes with their
 * ids. Bounded by `maxChars`; blocks past the bound are counted, not listed.
 */
export function outlineDocument(model: DocumentModel, maxChars = 12_000): string {
  const pending = model.revisions.filter((revision) => revision.status === "pending");
  const openComments = model.comments.filter((comment) => !comment.resolved).length;
  const header = [
    `Document "${oneLine(model.title, 120)}": ${model.blocks.length} block${model.blocks.length === 1 ? "" : "s"}, ` +
      `${model.sources.length} source${model.sources.length === 1 ? "" : "s"}, ` +
      `${model.comments.length} comment${model.comments.length === 1 ? "" : "s"} (${openComments} open), ` +
      `${pending.length} pending change${pending.length === 1 ? "" : "s"}`,
  ];

  const tail: string[] = [];
  if (model.sources.length > 0) {
    tail.push("Sources:");
    for (const source of model.sources) {
      tail.push(`[${source.id}] ${oneLine(source.title, 100)}${source.url ? ` — ${oneLine(source.url, 100)}` : ""}`);
    }
  }
  if (model.comments.length > 0) {
    tail.push("Comments:");
    for (const comment of model.comments) {
      tail.push(
        `[${comment.id}] on ${comment.blockId} by ${oneLine(comment.author, 40)}${comment.resolved ? " (resolved)" : ""}: ${oneLine(comment.text, 100)}`
      );
    }
  }
  if (pending.length > 0) {
    tail.push("Pending changes:");
    for (const revision of pending) {
      const what =
        revision.kind === "replace"
          ? `replace text of ${revision.blockId} with: ${oneLine(revision.text, 100)}`
          : revision.kind === "insert"
            ? `insert after ${revision.blockId}: ${oneLine(revision.text, 100)}`
            : `delete ${revision.blockId}`;
      tail.push(`[${revision.id}] ${what} (by ${oneLine(revision.author, 40)})`);
    }
  }

  // The tail gets at most a third of the budget; blocks get the rest.
  const tailBudget = Math.floor(maxChars / 3);
  const boundedTail = boundLines(tail, tailBudget, (n) => `… ${n} more lines`);
  const used = header.join("\n").length + boundedTail.join("\n").length + 2;
  let budget = Math.max(0, maxChars - used - 40);

  const body: string[] = [];
  let listed = 0;
  for (const block of model.blocks) {
    const lines = outlineBlock(block);
    const size = lines.join("\n").length + 1;
    if (size > budget) break;
    body.push(...lines);
    budget -= size;
    listed++;
  }
  if (listed < model.blocks.length) {
    const remaining = model.blocks.length - listed;
    body.push(`… ${remaining} more block${remaining === 1 ? "" : "s"}`);
  }
  return [...header, ...body, ...boundedTail].join("\n");
}

function boundLines(lines: string[], budget: number, more: (n: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const size = lines[i].length + 1;
    if (used + size > budget - 30) {
      out.push(more(lines.length - i));
      return out;
    }
    out.push(lines[i]);
    used += size;
  }
  return out;
}

/** A defensive copy for callers that want to mutate (re-exported for symmetry). */
export function cloneDocument(model: DocumentModel): DocumentModel {
  return cloneModel(model);
}
