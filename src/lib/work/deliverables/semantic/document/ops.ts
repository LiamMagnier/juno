/**
 * Edit operations on a semantic document (BRIEF §29/§30).
 *
 * The chat model reads `outlineDocument`, then sends a batch of these naming
 * the block, comment and revision ids it read. `applyDocumentOps` is pure and
 * all-or-nothing: it works on a copy, re-validates the whole model after every
 * operation, and throws `SemanticError` with the 1-based index of the first
 * operation that fails, so the caller stores either every change or none.
 *
 * Tracked changes follow Word: `suggestRevision` records a pending change and
 * leaves the block alone; `acceptRevision` applies it; `rejectRevision`
 * discards it. Both keep the revision as history with its final status.
 */

import { z } from "zod";
import {
  SemanticError,
  cloneModel,
  describeIssues,
  nextId,
  type SemanticErrorCode,
  type SemanticOpResult,
} from "@/lib/work/deliverables/semantic/shared";
import {
  DEFAULT_AUTHOR,
  authoringBlockSchema,
  authoringSourceSchema,
  isTextBlock,
  metadataSchema,
  normalizeDocument,
  revisionKinds,
  stylesSchema,
  type Block,
  type DocumentModel,
} from "@/lib/work/deliverables/semantic/document/model";

const idRef = z.string().trim().min(1).max(64);
const opText = z.string().max(20_000);

/** `null` clears a field; an absent key leaves it as it is. */
function nullablePartial<T extends z.ZodRawShape>(shape: z.ZodObject<T>) {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape.shape)) {
    out[key] = (schema as z.ZodType).nullable();
  }
  return z.object(out).partial();
}

export const documentOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("insertBlock"),
    /** The block to insert after, or null for the start of the document. */
    after: idRef.nullable(),
    block: authoringBlockSchema,
  }),
  z.object({ op: z.literal("replaceBlock"), id: idRef, block: authoringBlockSchema }),
  z.object({ op: z.literal("updateText"), id: idRef, text: opText }),
  z.object({ op: z.literal("moveBlock"), id: idRef, after: idRef.nullable() }),
  z.object({ op: z.literal("deleteBlock"), id: idRef }),
  z.object({
    op: z.literal("comment"),
    blockId: idRef,
    text: opText,
    quote: z.string().max(2_000).optional(),
    author: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({ op: z.literal("resolveComment"), id: idRef }),
  z.object({
    op: z.literal("suggestRevision"),
    blockId: idRef,
    kind: z.enum(revisionKinds),
    text: opText.optional(),
    author: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({ op: z.literal("acceptRevision"), id: idRef }),
  z.object({ op: z.literal("rejectRevision"), id: idRef }),
  z.object({ op: z.literal("setMetadata"), metadata: nullablePartial(metadataSchema) }),
  z.object({ op: z.literal("setStyles"), styles: nullablePartial(stylesSchema) }),
  z.object({ op: z.literal("addSource"), source: authoringSourceSchema }),
]);

export const documentOpsSchema = z.array(documentOpSchema).min(1).max(60);

export type DocumentOp = z.input<typeof documentOpSchema>;
type ParsedOp = z.infer<typeof documentOpSchema>;

class OpFailure extends Error {
  constructor(
    readonly code: SemanticErrorCode,
    message: string
  ) {
    super(message);
  }
}

const BLOCK_NOUN: Record<Block["type"], string> = {
  heading: "a heading",
  paragraph: "a paragraph",
  list: "a list",
  table: "a table",
  callout: "a callout",
  figure: "a figure",
  pageBreak: "a page break",
};

/**
 * Apply a batch of operations. Returns a new model and one sentence per
 * operation; the input model is never modified.
 */
export function applyDocumentOps(
  model: DocumentModel,
  ops: readonly unknown[],
  options: { now?: Date; author?: string } = {}
): SemanticOpResult<DocumentModel> {
  const parsed = documentOpsSchema.safeParse(ops);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const index = typeof first?.path[0] === "number" ? first.path[0] + 1 : undefined;
    throw new SemanticError("invalid_op", describeIssues(parsed.error.issues), index);
  }
  const now = options.now ?? new Date();
  const author = options.author?.trim() || DEFAULT_AUTHOR;

  let working = cloneModel(model);
  const changes: string[] = [];
  parsed.data.forEach((op, index) => {
    try {
      changes.push(applyOne(working, op, now, author));
      working = normalizeDocument(working, { now });
    } catch (err) {
      if (err instanceof OpFailure) throw new SemanticError(err.code, err.message, index + 1);
      if (err instanceof SemanticError) throw new SemanticError(err.code, err.message, index + 1);
      throw err;
    }
  });
  return { model: working, changes };
}

function allIds(model: DocumentModel): string[] {
  return [
    ...model.blocks.map((block) => block.id),
    ...model.comments.map((comment) => comment.id),
    ...model.revisions.map((revision) => revision.id),
    ...model.sources.map((source) => source.id),
  ];
}

function blockIndex(model: DocumentModel, id: string): number {
  const index = model.blocks.findIndex((block) => block.id === id);
  if (index === -1) throw new OpFailure("not_found", `There is no block "${id}". Read the outline for block ids.`);
  return index;
}

/** The position a block goes to when it is placed after `after` (null = start). */
function insertPosition(model: DocumentModel, after: string | null): number {
  return after === null ? 0 : blockIndex(model, after) + 1;
}

/** Validate an authored block and give it an id. */
function materialize(model: DocumentModel, raw: unknown, forcedId?: string): Block {
  const parsed = authoringBlockSchema.safeParse(raw);
  if (!parsed.success) throw new OpFailure("invalid_op", describeIssues(parsed.error.issues));
  const block = parsed.data;
  if (forcedId !== undefined) {
    if (block.id !== undefined && block.id !== forcedId) {
      throw new OpFailure("invalid_op", `The replacement block's id "${block.id}" differs from "${forcedId}".`);
    }
    return { ...block, id: forcedId } as Block;
  }
  if (block.id !== undefined) {
    if (allIds(model).includes(block.id)) throw new OpFailure("invalid_op", `The id "${block.id}" is already used.`);
    return block as Block;
  }
  return { ...block, id: nextId("b", allIds(model)) } as Block;
}

function where(after: string | null): string {
  return after === null ? "at the start" : `after ${after}`;
}

function applyOne(model: DocumentModel, op: ParsedOp, now: Date, defaultAuthor: string): string {
  const stamp = now.toISOString();
  switch (op.op) {
    case "insertBlock": {
      const position = insertPosition(model, op.after);
      const block = materialize(model, op.block);
      model.blocks.splice(position, 0, block);
      return `Inserted ${BLOCK_NOUN[block.type]} (${block.id}) ${where(op.after)}`;
    }

    case "replaceBlock": {
      const index = blockIndex(model, op.id);
      const block = materialize(model, op.block, op.id);
      model.blocks[index] = block;
      return `Replaced ${op.id} with ${BLOCK_NOUN[block.type]}`;
    }

    case "updateText": {
      const block = model.blocks[blockIndex(model, op.id)];
      if (!isTextBlock(block)) {
        throw new OpFailure(
          "invalid_op",
          `${op.id} is ${BLOCK_NOUN[block.type]}; updateText edits headings, paragraphs and callouts. Use replaceBlock.`
        );
      }
      block.text = op.text;
      return `Rewrote the text of ${op.id}`;
    }

    case "moveBlock": {
      if (op.after === op.id) throw new OpFailure("invalid_op", `${op.id} cannot be moved after itself.`);
      const from = blockIndex(model, op.id);
      if (op.after !== null) blockIndex(model, op.after);
      const [block] = model.blocks.splice(from, 1);
      model.blocks.splice(insertPosition(model, op.after), 0, block);
      return `Moved ${op.id} ${where(op.after)}`;
    }

    case "deleteBlock": {
      const index = blockIndex(model, op.id);
      const [block] = model.blocks.splice(index, 1);
      const comments = model.comments.length;
      const revisions = model.revisions.length;
      model.comments = model.comments.filter((comment) => comment.blockId !== op.id);
      model.revisions = model.revisions.filter((revision) => revision.blockId !== op.id);
      const dropped = comments - model.comments.length + (revisions - model.revisions.length);
      return `Deleted ${BLOCK_NOUN[block.type]} (${op.id})${dropped > 0 ? ` and the ${dropped} comment${dropped === 1 ? "" : "s"} and changes on it` : ""}`;
    }

    case "comment": {
      blockIndex(model, op.blockId);
      const id = nextId("c", allIds(model));
      model.comments.push({
        id,
        blockId: op.blockId,
        author: op.author ?? defaultAuthor,
        text: op.text,
        createdAt: stamp,
        ...(op.quote ? { quote: op.quote } : {}),
      });
      return `Commented on ${op.blockId} (${id})`;
    }

    case "resolveComment": {
      const comment = model.comments.find((entry) => entry.id === op.id);
      if (!comment) throw new OpFailure("not_found", `There is no comment "${op.id}".`);
      if (comment.resolved) return `Comment ${op.id} was already resolved`;
      comment.resolved = true;
      return `Resolved comment ${op.id}`;
    }

    case "suggestRevision": {
      const block = model.blocks[blockIndex(model, op.blockId)];
      const text = op.kind === "delete" ? "" : (op.text ?? "");
      if (op.kind !== "delete" && text.trim() === "") {
        throw new OpFailure("invalid_op", `A suggested ${op.kind} needs text.`);
      }
      if (op.kind !== "insert" && !isTextBlock(block)) {
        throw new OpFailure(
          "invalid_op",
          `Tracked changes rewrite headings, paragraphs and callouts; ${op.blockId} is ${BLOCK_NOUN[block.type]}.`
        );
      }
      if (op.kind !== "insert") {
        const open = model.revisions.find(
          (entry) => entry.blockId === op.blockId && entry.status === "pending" && entry.kind !== "insert"
        );
        if (open) {
          throw new OpFailure(
            "invalid_op",
            `${op.blockId} already has a pending change (${open.id}); accept or reject it first.`
          );
        }
      }
      const id = nextId("r", allIds(model));
      model.revisions.push({
        id,
        blockId: op.blockId,
        kind: op.kind,
        text,
        author: op.author ?? defaultAuthor,
        createdAt: stamp,
        status: "pending",
      });
      const what =
        op.kind === "replace"
          ? `replacing the text of ${op.blockId}`
          : op.kind === "insert"
            ? `inserting a paragraph after ${op.blockId}`
            : `deleting ${op.blockId}`;
      return `Suggested ${what} (${id})`;
    }

    case "acceptRevision": {
      const revision = pendingRevision(model, op.id);
      const index = blockIndex(model, revision.blockId);
      const block = model.blocks[index];
      if (revision.kind === "replace") {
        if (!isTextBlock(block)) throw new OpFailure("invalid_op", `${revision.blockId} no longer has text to replace.`);
        block.text = revision.text;
        revision.status = "accepted";
        return `Accepted ${op.id}: replaced the text of ${revision.blockId}`;
      }
      if (revision.kind === "insert") {
        const id = nextId("b", allIds(model));
        model.blocks.splice(index + 1, 0, { id, type: "paragraph", text: revision.text });
        revision.status = "accepted";
        return `Accepted ${op.id}: inserted a paragraph (${id}) after ${revision.blockId}`;
      }
      model.blocks.splice(index, 1);
      model.comments = model.comments.filter((comment) => comment.blockId !== revision.blockId);
      // Other pending changes on the removed block can no longer apply; the
      // accepted deletion itself stays as history.
      model.revisions = model.revisions.filter(
        (entry) => entry.id === revision.id || entry.blockId !== revision.blockId || entry.status !== "pending"
      );
      revision.status = "accepted";
      return `Accepted ${op.id}: deleted ${revision.blockId}`;
    }

    case "rejectRevision": {
      const revision = pendingRevision(model, op.id);
      revision.status = "rejected";
      return `Rejected ${op.id}`;
    }

    case "setMetadata": {
      const next: Record<string, unknown> = { ...model.metadata };
      for (const [key, value] of Object.entries(op.metadata)) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      model.metadata = next as DocumentModel["metadata"];
      return `Updated the document details (${Object.keys(op.metadata).join(", ") || "nothing"})`;
    }

    case "setStyles": {
      const next: Record<string, unknown> = { ...model.styles };
      for (const [key, value] of Object.entries(op.styles)) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      model.styles = next as DocumentModel["styles"];
      return `Updated the document styles (${Object.keys(op.styles).join(", ") || "nothing"})`;
    }

    case "addSource": {
      const ids = allIds(model);
      const id = op.source.id ?? nextId("src", ids);
      if (op.source.id !== undefined && ids.includes(op.source.id)) {
        throw new OpFailure("invalid_op", `The id "${op.source.id}" is already used.`);
      }
      model.sources.push({ ...stripUndefined(op.source), id });
      return `Added the source "${op.source.title}" (${id})`;
    }
  }
}

function pendingRevision(model: DocumentModel, id: string) {
  const revision = model.revisions.find((entry) => entry.id === id);
  if (!revision) throw new OpFailure("not_found", `There is no tracked change "${id}".`);
  if (revision.status !== "pending") {
    throw new OpFailure("invalid_op", `Tracked change ${id} was already ${revision.status}.`);
  }
  return revision;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
