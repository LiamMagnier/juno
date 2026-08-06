/**
 * Juno Design — the operation system.
 *
 * Every edit to a design document goes through here: a manual drag in the
 * editor, a keyboard nudge, and a model-authored change are the same kind of
 * thing, differing only in who authored the transaction. That is the whole
 * point — there is no second path where the AI mutates the scene directly, and
 * no path at all where an unvalidated patch is executed.
 *
 * Guarantees:
 *  - **Validated.** Every operation is parsed by its zod schema and then checked
 *    against the document it claims to apply to (ids exist, no cycles, no writes
 *    to locked nodes).
 *  - **Atomic.** `applyTransaction` either applies every operation or none.
 *  - **Invertible.** Each operation returns its own inverse, computed from the
 *    pre-state, so undo is an ordinary transaction rather than a snapshot diff.
 *  - **Deterministic.** New ids come from a seed carried on the transaction, so
 *    replaying the same transaction against the same document is byte-identical.
 *  - **Scoped.** `touchedNodeIds` reports exactly what a transaction changed,
 *    which is what lets a selection-scoped AI request be *checked* rather than
 *    merely requested politely.
 */

import { z } from "zod";
import {
  assetSchema,
  autoLayoutSchema,
  animationSchema,
  blurSchema,
  blendModeSchema,
  collectionSchema,
  componentPropertySchema,
  constraintsSchema,
  cornerRadiusSchema,
  interactionSchema,
  layoutChildSchema,
  motionTrackSchema,
  nodeSchema,
  paintSchema,
  rgbaSchema,
  shadowSchema,
  sizeLimitsSchema,
  sizingModeSchema,
  strokeSchema,
  typographySchema,
  variableSchema,
  DesignValidationError,
} from "@/lib/design/schema";
import { cloneDocument, isAncestorOf, subtreeIds } from "@/lib/design/document";
import { isContainer, type DesignDocument, type DesignNode, type NodeId } from "@/lib/design/types";

// ---------------------------------------------------------------------------
// Operation schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(120);
const idList = z.array(idSchema).min(1).max(2_000);

/** Mirrors the document schema's page ceiling. Refusing here means a document
 *  that grew one page too far is rejected while it can still be described, not
 *  after it has been written and can no longer be parsed back. */
const MAX_PAGES = 200;

/** The background `createDesignDocument` gives a document's first page, so a
 *  page added later does not arrive a different colour. */
const DEFAULT_PAGE_BACKGROUND = { r: 0.96, g: 0.96, b: 0.97, a: 1 };

/** The subset of node fields an `updateNode` may write. Deliberately explicit:
 *  `id`, `type`, `parentId` and `children` are structural and only the
 *  structural operations may touch them, so a patch cannot silently reparent. */
export const nodePatchSchema = z
  .object({
    name: z.string().max(300),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
    rotation: z.number().finite(),
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
    locked: z.boolean(),
    clipsContent: z.boolean(),
    blendMode: blendModeSchema,
    fills: z.array(paintSchema).max(32),
    strokes: z.array(strokeSchema).max(32),
    cornerRadius: cornerRadiusSchema,
    shadows: z.array(shadowSchema).max(32),
    blur: blurSchema.nullable(),
    constraints: constraintsSchema,
    widthMode: sizingModeSchema,
    heightMode: sizingModeSchema,
    limits: sizeLimitsSchema,
    layoutChild: layoutChildSchema,
    layout: autoLayoutSchema.nullable(),
    characters: z.string().max(100_000),
    typography: typographySchema.partial(),
    d: z.string().max(200_000),
    assetId: idSchema,
    scaleMode: z.enum(["fill", "fit", "stretch", "tile"]),
    variantProperties: z.record(z.string().max(120), z.string().max(200)),
  })
  .partial()
  .strict();

export type NodePatch = z.infer<typeof nodePatchSchema>;

/** A node spec for `createNode` — everything optional except the type, so the
 *  model can ask for "a rectangle here" without restating twenty defaults. */
const nodeSpecSchema = z.object({
  type: z.enum(["frame", "group", "rectangle", "ellipse", "line", "path", "text", "image"]),
  /** Caller-chosen id. Omitted means the transaction mints a deterministic one. */
  id: idSchema.optional(),
  name: z.string().max(300).optional(),
  patch: nodePatchSchema.optional(),
});

export const designOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("createNode"),
    parentId: idSchema.nullable(),
    pageId: idSchema,
    /** Insert position within the parent's children; appended when absent. */
    index: z.number().int().min(0).max(10_000).optional(),
    node: nodeSpecSchema,
  }),
  z.object({ op: z.literal("updateNode"), nodeId: idSchema, patch: nodePatchSchema }),
  z.object({ op: z.literal("deleteNodes"), nodeIds: idList }),
  z.object({ op: z.literal("duplicateNodes"), nodeIds: idList, offset: z.object({ x: z.number().finite(), y: z.number().finite() }).optional() }),
  z.object({
    op: z.literal("reparentNodes"),
    nodeIds: idList,
    newParentId: idSchema.nullable(),
    pageId: idSchema,
    index: z.number().int().min(0).max(10_000).optional(),
  }),
  z.object({
    op: z.literal("reorderNodes"),
    nodeIds: idList,
    /** Absolute placement within the current parent. */
    to: z.union([z.literal("front"), z.literal("back"), z.literal("forward"), z.literal("backward")]),
  }),
  z.object({ op: z.literal("groupNodes"), nodeIds: idList, groupId: idSchema.optional(), name: z.string().max(300).optional() }),
  z.object({ op: z.literal("ungroupNodes"), nodeIds: idList }),
  z.object({ op: z.literal("setSelection"), nodeIds: z.array(idSchema).max(2_000) }),
  z.object({ op: z.literal("setConstraints"), nodeIds: idList, constraints: constraintsSchema }),
  z.object({ op: z.literal("setAutoLayout"), nodeId: idSchema, layout: autoLayoutSchema.nullable() }),
  z.object({
    op: z.literal("createComponent"),
    nodeId: idSchema,
    componentId: idSchema.optional(),
    name: z.string().min(1).max(300),
    description: z.string().max(2_000).optional(),
  }),
  z.object({
    op: z.literal("createInstance"),
    componentId: idSchema,
    parentId: idSchema.nullable(),
    pageId: idSchema,
    instanceId: idSchema.optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  }),
  z.object({
    op: z.literal("createVariant"),
    componentId: idSchema,
    nodeId: idSchema,
    /** Canonical `prop=value` pairs identifying this variant. */
    variantProperties: z.record(z.string().max(120), z.string().max(200)),
  }),
  z.object({
    op: z.literal("setComponentProperty"),
    componentId: idSchema,
    property: componentPropertySchema,
  }),
  z.object({ op: z.literal("deleteComponent"), componentId: idSchema }),
  z.object({ op: z.literal("createVariable"), variable: variableSchema, collection: collectionSchema.optional() }),
  z.object({ op: z.literal("deleteVariable"), variableId: idSchema }),
  z.object({ op: z.literal("bindVariable"), nodeId: idSchema, property: z.string().min(1).max(120), variableId: idSchema.nullable() }),
  z.object({ op: z.literal("setVariableMode"), collectionId: idSchema, modeId: idSchema }),
  z.object({
    op: z.literal("createPage"),
    /** Caller-chosen id, so the editor can switch to the page it just asked for
     *  without waiting for the transaction to come back. */
    pageId: idSchema.optional(),
    name: z.string().min(1).max(300),
    index: z.number().int().min(0).max(MAX_PAGES).optional(),
    backgroundColor: rgbaSchema.optional(),
  }),
  z.object({ op: z.literal("deletePage"), pageId: idSchema }),
  z.object({ op: z.literal("renamePage"), pageId: idSchema, name: z.string().min(1).max(300) }),
  /**
   * The document's own name — what an SVG, PNG or handoff export is called.
   *
   * `name` mirrors the document schema exactly (`max(300)`, no minimum) rather
   * than borrowing `renamePage`'s `min(1)`. An operation has to be able to
   * express every state its target can legally hold, or its inverse is not
   * total: a stored document whose name is the empty string — the schema takes
   * one, and a document minted across the design bridge can carry one — would
   * produce an inverse the schema then refuses, and the undo would throw where
   * the redo did not.
   */
  z.object({ op: z.literal("renameDocument"), name: z.string().max(300) }),
  z.object({ op: z.literal("createAsset"), asset: assetSchema }),
  z.object({ op: z.literal("deleteAsset"), assetId: idSchema }),
  z.object({ op: z.literal("createInteraction"), interaction: interactionSchema }),
  z.object({ op: z.literal("deleteInteraction"), interactionId: idSchema }),
  z.object({ op: z.literal("createAnimation"), animation: animationSchema }),
  z.object({ op: z.literal("deleteAnimation"), animationId: idSchema }),
  z.object({ op: z.literal("setKeyframes"), animationId: idSchema, track: motionTrackSchema }),
]);

export type DesignOperation = z.infer<typeof designOperationSchema>;

export interface DesignTransaction {
  id: string;
  /** The document revision this transaction was authored against. */
  baseRevision: number;
  operations: DesignOperation[];
  /** Who authored it, for the history panel and the AI revert affordance. */
  author: "user" | "juno";
  /** One line, human-readable. Shown in the history panel and the AI review. */
  summary: string;
  /** Comment this transaction answers, when it came from an inline comment. */
  commentId?: string | null;
  createdAt: string;
}

export const designTransactionSchema = z.object({
  id: idSchema,
  baseRevision: z.number().int().min(0),
  operations: z.array(designOperationSchema).min(1).max(500),
  author: z.enum(["user", "juno"]),
  summary: z.string().max(500),
  commentId: idSchema.nullable().optional(),
  createdAt: z.string().max(60),
});

export class DesignOperationError extends Error {
  readonly code: "invalid" | "conflict" | "not-found" | "locked" | "cycle";
  constructor(code: DesignOperationError["code"], message: string) {
    super(message);
    this.name = "DesignOperationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface TransactionResult {
  document: DesignDocument;
  /** Operations that undo this transaction, already in the order they must run. */
  inverse: DesignOperation[];
  /** Every node id this transaction created, changed, moved or removed. */
  touchedNodeIds: NodeId[];
  /** Selection after the transaction, when it set one. */
  selection: NodeId[] | null;
  summaries: string[];
}

interface ApplyContext {
  mintId: (prefix: string) => string;
  touched: Set<NodeId>;
  selection: NodeId[] | null;
}

/**
 * Apply a whole transaction atomically.
 *
 * Works on a clone, so a throw halfway through leaves the caller's document
 * untouched — that is the atomicity guarantee, and it is why the editor can
 * offer an AI transaction as a *preview* (apply to a clone, show it, discard it
 * on reject) without a second code path.
 */
export function applyTransaction(doc: DesignDocument, transaction: DesignTransaction): TransactionResult {
  const parsed = designTransactionSchema.safeParse(transaction);
  if (!parsed.success) {
    throw new DesignOperationError("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (transaction.baseRevision !== doc.revision) {
    throw new DesignOperationError(
      "conflict",
      `This change was made against revision ${transaction.baseRevision}, but the document is now at revision ${doc.revision}.`
    );
  }

  const working = cloneDocument(doc);
  const ctx: ApplyContext = {
    mintId: makeSeededMinter(transaction.id),
    touched: new Set<NodeId>(),
    selection: null,
  };
  const inverse: DesignOperation[] = [];
  const summaries: string[] = [];

  for (const operation of transaction.operations) {
    const step = applyOne(working, operation, ctx);
    // Inverses run newest-first, so each one goes on the front.
    inverse.unshift(...step.inverse);
    summaries.push(step.summary);
  }

  working.revision = doc.revision + 1;
  working.updatedAt = transaction.createdAt;

  return {
    document: working,
    inverse,
    touchedNodeIds: [...ctx.touched],
    selection: ctx.selection,
    summaries,
  };
}

/** A transaction that undoes `result`, ready to apply to the post-state. */
export function invertTransaction(
  result: TransactionResult,
  source: DesignTransaction,
  now: string
): DesignTransaction {
  return {
    id: `${source.id}~undo`,
    baseRevision: result.document.revision,
    operations: result.inverse,
    author: source.author,
    summary: `Undo: ${source.summary}`,
    commentId: source.commentId ?? null,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// Batching and checkpoints
// ---------------------------------------------------------------------------

/**
 * Drop the intermediate states from a run of operations.
 *
 * An `updateNode` assigns whole fields, so an earlier assignment is dead as
 * soon as a later one covers every field it wrote — which is what a stream of
 * pointer-driven edits is: forty `{x, y}` patches on the same node where only
 * the last one is worth sending. The earlier one is only dropped when
 * everything between the two is also an `updateNode`, because nothing else can
 * be assumed to leave the node's fields alone: a delete, a reparent or a group
 * in between makes the intermediate state load-bearing again.
 *
 * The result applies to the same base revision and produces the same document
 * as the input; it is a smaller way of saying the same thing, not a different
 * change.
 */
export function coalesceOperations(operations: DesignOperation[]): DesignOperation[] {
  const kept: (DesignOperation | null)[] = [...operations];

  for (let i = operations.length - 1; i >= 0; i--) {
    const later = kept[i];
    if (!later || later.op !== "updateNode") continue;
    const laterKeys = Object.keys(later.patch);
    for (let j = i - 1; j >= 0; j--) {
      const earlier = kept[j];
      if (!earlier) continue;
      if (earlier.op !== "updateNode") break;
      if (earlier.nodeId !== later.nodeId) continue;
      if (Object.keys(earlier.patch).every((key) => laterKeys.includes(key))) kept[j] = null;
    }
  }

  return kept.filter((operation): operation is DesignOperation => operation !== null);
}

/**
 * Whether any of these operations will mint an id.
 *
 * Ids come from a minter seeded with the transaction's own id, so the same
 * transaction replayed anywhere produces the same document (see the module
 * note). The other side of that bargain is that operations which mint cannot be
 * moved into a transaction with a different id: the store would create the same
 * layer under a name the editor has never heard of, and the next gesture would
 * address a node that does not exist. A caller that batches has to keep these
 * in a transaction of their own, under the id they were applied with.
 */
export function mintsIds(operations: DesignOperation[]): boolean {
  return operations.some((operation) => {
    switch (operation.op) {
      case "createNode":
        return !operation.node.id;
      case "duplicateNodes":
        return true;
      case "groupNodes":
        return !operation.groupId;
      case "createComponent":
        return !operation.componentId;
      case "createInstance":
        return !operation.instanceId;
      case "createPage":
        return !operation.pageId;
      default:
        return false;
    }
  });
}

/**
 * How long a run of edits keeps folding into the same stored checkpoint.
 *
 * Long enough that a burst of dragging, nudging and recolouring is one entry in
 * the version list; short enough that stepping away and coming back gives you
 * something to go back to.
 */
export const CHECKPOINT_WINDOW_MS = 30_000;

export interface StoredCheckpoint {
  /** `origin` of the newest stored version. */
  origin: string | null;
  /** How old that version is, in milliseconds, as this transaction lands. */
  ageMs: number;
}

/**
 * Whether a transaction deserves a version of its own.
 *
 * The alternative is that it rewrites the newest version in place, which is how
 * continuous manipulation stops costing a permanent copy of the document per
 * gesture. Only a run of the user's own recent edits may be folded together:
 * generated output and restore points are never overwritten, and a change Juno
 * authored is the unit a person reviews and reverts, so it always stands alone.
 */
export function allocatesCheckpoint(
  latest: StoredCheckpoint | null,
  transaction: DesignTransaction,
  origin: "edit" | "restore"
): boolean {
  if (!latest) return true;
  if (origin !== "edit" || latest.origin !== "edit") return true;
  if (transaction.author !== "user") return true;
  // A negative age is a clock that disagrees with itself; take the safe branch.
  return latest.ageMs < 0 || latest.ageMs >= CHECKPOINT_WINDOW_MS;
}

/** Deterministic id minter seeded by the transaction id (see the module note on
 *  replay). Never `Math.random`: a replayed transaction must produce the same
 *  document on the Mac as in the browser. */
function makeSeededMinter(seed: string): (prefix: string) => string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  let counter = 0;
  return (prefix) => `${prefix}${hash.toString(36)}${(counter++).toString(36)}`;
}

interface StepResult {
  inverse: DesignOperation[];
  summary: string;
}

function requireNode(doc: DesignDocument, id: NodeId): DesignNode {
  const node = doc.nodes[id];
  if (!node) throw new DesignOperationError("not-found", `No node ${id} in this document.`);
  return node;
}

/**
 * An image layer is exactly as real as the asset it names.
 *
 * `assetId` has no empty form, so a layer created without one used to be
 * refused by the node schema with a message about string length — and a layer
 * pointed at an id nothing defines drew a grey placeholder for good. Both are
 * caught here instead, in the caller's vocabulary: put the asset in the same
 * transaction as the layer.
 */
function requireAsset(doc: DesignDocument, assetId: unknown): void {
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new DesignOperationError("invalid", "An image layer needs a picture. Create its asset in the same transaction.");
  }
  if (!doc.assets[assetId]) throw new DesignOperationError("not-found", `No image asset ${assetId} in this document.`);
}

function requireUnlocked(doc: DesignDocument, id: NodeId): DesignNode {
  const node = requireNode(doc, id);
  if (node.locked) throw new DesignOperationError("locked", `“${node.name}” is locked.`);
  return node;
}

function siblingList(doc: DesignDocument, parentId: NodeId | null, pageId: string): NodeId[] {
  if (parentId === null) {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) throw new DesignOperationError("not-found", `No page ${pageId} in this document.`);
    return page.children;
  }
  const parent = requireNode(doc, parentId);
  if (!isContainer(parent)) throw new DesignOperationError("invalid", `“${parent.name}” cannot contain other layers.`);
  return parent.children;
}

/** The page a node currently sits on, needed to build a correct inverse for a
 *  structural move. */
function pageIdOf(doc: DesignDocument, id: NodeId): string {
  let cursor: NodeId | null = id;
  const guard = Object.keys(doc.nodes).length + 1;
  for (let i = 0; cursor && i <= guard; i++) {
    const node: DesignNode | undefined = doc.nodes[cursor];
    if (!node) break;
    if (node.parentId === null) {
      const page = doc.pages.find((p) => p.children.includes(node.id));
      if (page) return page.id;
      break;
    }
    cursor = node.parentId;
  }
  return doc.pages[0]?.id ?? "";
}

function detach(doc: DesignDocument, id: NodeId): { parentId: NodeId | null; pageId: string; index: number } {
  const node = requireNode(doc, id);
  const pageId = pageIdOf(doc, id);
  const list = siblingList(doc, node.parentId, pageId);
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  return { parentId: node.parentId, pageId, index: index < 0 ? 0 : index };
}

function attach(doc: DesignDocument, id: NodeId, parentId: NodeId | null, pageId: string, index?: number): void {
  const list = siblingList(doc, parentId, pageId);
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, id);
  doc.nodes[id].parentId = parentId;
}

function nodeDefaultsFor(type: DesignNode["type"]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    parentId: null,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    blendMode: "normal",
    fills: [],
    strokes: [],
    cornerRadius: 0,
    shadows: [],
    blur: null,
    constraints: { horizontal: "min", vertical: "min" },
    widthMode: "fixed",
    heightMode: "fixed",
    limits: {},
    layoutChild: { grow: false, absolute: false },
    boundVariables: {},
  };
  switch (type) {
    case "frame":
    case "group":
      return { ...base, children: [], clipsContent: type === "frame", layout: null, fills: type === "frame" ? [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }] : [] };
    case "text":
      return {
        ...base,
        width: 160,
        height: 24,
        heightMode: "hug",
        characters: "Text",
        fills: [{ type: "solid", color: { r: 0.06, g: 0.06, b: 0.08, a: 1 } }],
        typography: {
          fontFamily: "Inter",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: { unit: "percent", value: 140 },
          letterSpacing: 0,
          textAlign: "left",
          verticalAlign: "top",
        },
      };
    case "image":
      return { ...base, assetId: "", scaleMode: "fill" };
    case "path":
      return { ...base, d: "", windingRule: "nonzero" };
    case "line":
      return { ...base, height: 0, strokes: [{ paint: { type: "solid", color: { r: 0.06, g: 0.06, b: 0.08, a: 1 } }, weight: 1, align: "center" }] };
    default:
      return { ...base, fills: [{ type: "solid", color: { r: 0.55, g: 0.6, b: 0.95, a: 1 } }] };
  }
}

// eslint-disable-next-line complexity
function applyOne(doc: DesignDocument, operation: DesignOperation, ctx: ApplyContext): StepResult {
  switch (operation.op) {
    // ---------------------------------------------------------------- create
    case "createNode": {
      const id = operation.node.id ?? ctx.mintId("n");
      if (doc.nodes[id]) throw new DesignOperationError("invalid", `A node with id ${id} already exists.`);
      const defaults = nodeDefaultsFor(operation.node.type);
      const patch = (operation.node.patch ?? {}) as Record<string, unknown>;
      const raw: Record<string, unknown> = {
        ...defaults,
        ...patch,
        id,
        type: operation.node.type,
        name: operation.node.name ?? operation.node.patch?.name ?? defaultName(operation.node.type),
        parentId: operation.parentId,
      };
      // `typography` MERGES with the default, exactly as `updateNode` does.
      // A plain spread would let `{fontSize: 28}` replace the whole block and
      // take the family, line height and alignment with it — the node would
      // then fail validation on a field the caller never mentioned, which is a
      // confusing way to reject a perfectly reasonable request.
      if (patch.typography && defaults.typography) {
        raw.typography = { ...(defaults.typography as object), ...(patch.typography as object) };
      }
      if (operation.node.type === "image") requireAsset(doc, raw.assetId);
      const parsed = nodeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DesignOperationError("invalid", `New ${operation.node.type} is not a valid node: ${parsed.error.issues[0]?.message ?? ""}`);
      }
      doc.nodes[id] = parsed.data;
      attach(doc, id, operation.parentId, operation.pageId, operation.index);
      ctx.touched.add(id);
      return { inverse: [{ op: "deleteNodes", nodeIds: [id] }], summary: `Add ${parsed.data.name}` };
    }

    // ---------------------------------------------------------------- update
    case "updateNode": {
      const node = requireUnlocked(doc, operation.nodeId);
      const before: Record<string, unknown> = {};
      const record = node as unknown as Record<string, unknown>;
      const patch = operation.patch as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        if (!(key in record)) {
          // A patch that names a field this node type does not have is a
          // mistake worth surfacing, not something to write and hope about.
          throw new DesignOperationError("invalid", `${node.type} nodes have no “${key}”.`);
        }
        before[key] = record[key];
      }
      if ("assetId" in patch) requireAsset(doc, patch.assetId);
      // Typography merges rather than replaces so "make it bold" does not drop
      // the family, size and alignment the caller never mentioned.
      const next: Record<string, unknown> = { ...record, ...patch };
      if (patch.typography && record.typography) {
        next.typography = { ...(record.typography as object), ...(patch.typography as object) };
      }
      const parsed = nodeSchema.safeParse(next);
      if (!parsed.success) {
        throw new DesignOperationError("invalid", `Change to “${node.name}” is not valid: ${parsed.error.issues[0]?.message ?? ""}`);
      }
      doc.nodes[node.id] = parsed.data;
      ctx.touched.add(node.id);
      return {
        inverse: [{ op: "updateNode", nodeId: node.id, patch: before as NodePatch }],
        summary: `${describePatch(operation.patch)} on ${node.name}`,
      };
    }

    // ---------------------------------------------------------------- delete
    case "deleteNodes": {
      const inverse: DesignOperation[] = [];
      // Sibling indexes are read before anything is detached, and the roots are
      // then rebuilt in ascending index order. Reading them as we went recorded
      // every root at the position left by the previous detach, so undoing a
      // multi-layer delete used to hand back the layers in reverse z-order.
      const roots = operation.nodeIds.map((rootId) => {
        const node = requireUnlocked(doc, rootId);
        const pageId = pageIdOf(doc, rootId);
        return { rootId, pageId, index: siblingList(doc, node.parentId, pageId).indexOf(rootId) };
      });
      roots.sort((a, b) => a.index - b.index);

      for (const { rootId, pageId, index } of roots) {
        // An ancestor selected alongside its own child already took it.
        if (!doc.nodes[rootId]) continue;
        const ids = subtreeIds(doc, rootId);
        const { parentId } = detach(doc, rootId);
        // Parents before children, so the inverse rebuilds top-down: a child's
        // createNode attaches itself to a parent that already exists, which is
        // what restores the original sibling order without recording indexes.
        for (const id of ids) {
          const node = doc.nodes[id];
          if (!node) continue;
          ctx.touched.add(id);
          inverse.push({
            op: "createNode",
            parentId: id === rootId ? parentId : node.parentId,
            pageId,
            index: id === rootId ? index : undefined,
            node: { type: restorableType(node.type), id, name: node.name, patch: fullPatchOf(node) },
          });
        }
        // A component node restores as a frame (createNode only mints primitive
        // types); this puts the component identity back on top of it, so undo
        // returns a component rather than a frame that used to be one.
        for (const id of ids) {
          const node = doc.nodes[id];
          if (node?.type !== "component") continue;
          const definition = doc.components[node.componentId];
          if (!definition) continue;
          inverse.push({
            op: "createComponent",
            nodeId: id,
            componentId: definition.id,
            name: definition.name,
            description: definition.description,
          });
          for (const property of definition.properties) {
            inverse.push({ op: "setComponentProperty", componentId: definition.id, property });
          }
          delete doc.components[definition.id];
        }
        for (const id of ids) delete doc.nodes[id];
        // Interactions and animation tracks that pointed at a removed node
        // would dangle; drop them and put them back on undo.
        for (const [interactionId, interaction] of Object.entries(doc.interactions)) {
          if (ids.includes(interaction.sourceNodeId)) {
            inverse.push({ op: "createInteraction", interaction });
            delete doc.interactions[interactionId];
          }
        }
        for (const animation of Object.values(doc.animations)) {
          const kept = animation.tracks.filter((t) => !ids.includes(t.nodeId));
          if (kept.length !== animation.tracks.length) {
            for (const dropped of animation.tracks.filter((t) => ids.includes(t.nodeId))) {
              inverse.push({ op: "setKeyframes", animationId: animation.id, track: dropped });
            }
            animation.tracks = kept;
          }
        }
      }
      return { inverse, summary: `Delete ${operation.nodeIds.length} layer${operation.nodeIds.length === 1 ? "" : "s"}` };
    }

    // ------------------------------------------------------------- duplicate
    case "duplicateNodes": {
      const offset = operation.offset ?? { x: 16, y: 16 };
      const created: NodeId[] = [];
      const inverse: DesignOperation[] = [];
      for (const sourceId of operation.nodeIds) {
        const source = requireNode(doc, sourceId);
        const pageId = pageIdOf(doc, sourceId);
        const remap = new Map<NodeId, NodeId>();
        for (const id of subtreeIds(doc, sourceId)) remap.set(id, ctx.mintId("n"));
        for (const id of subtreeIds(doc, sourceId)) {
          const original = doc.nodes[id];
          const copy = cloneNodeShallow(original);
          copy.id = remap.get(id)!;
          copy.parentId = id === sourceId ? source.parentId : remap.get(original.parentId ?? "") ?? null;
          if ("children" in copy) {
            (copy as { children: NodeId[] }).children = (original as { children: NodeId[] }).children.map(
              (c) => remap.get(c)!
            );
          }
          if (id === sourceId) {
            copy.x = original.x + offset.x;
            copy.y = original.y + offset.y;
            copy.name = `${original.name} copy`;
          }
          doc.nodes[copy.id] = copy;
          ctx.touched.add(copy.id);
        }
        const newRoot = remap.get(sourceId)!;
        const list = siblingList(doc, source.parentId, pageId);
        list.splice(list.indexOf(sourceId) + 1, 0, newRoot);
        created.push(newRoot);
        inverse.unshift({ op: "deleteNodes", nodeIds: [newRoot] });
      }
      ctx.selection = created;
      return { inverse, summary: `Duplicate ${operation.nodeIds.length} layer${operation.nodeIds.length === 1 ? "" : "s"}` };
    }

    // -------------------------------------------------------------- reparent
    case "reparentNodes": {
      const inverse: DesignOperation[] = [];
      for (const id of operation.nodeIds) {
        requireUnlocked(doc, id);
        if (operation.newParentId !== null && isAncestorOf(doc, id, operation.newParentId)) {
          throw new DesignOperationError("cycle", "A layer cannot be moved inside itself.");
        }
        const previous = detach(doc, id);
        attach(doc, id, operation.newParentId, operation.pageId, operation.index);
        ctx.touched.add(id);
        inverse.unshift({
          op: "reparentNodes",
          nodeIds: [id],
          newParentId: previous.parentId,
          pageId: previous.pageId,
          index: previous.index,
        });
      }
      return { inverse, summary: `Move ${operation.nodeIds.length} layer${operation.nodeIds.length === 1 ? "" : "s"}` };
    }

    // --------------------------------------------------------------- reorder
    case "reorderNodes": {
      const inverse: DesignOperation[] = [];
      for (const id of operation.nodeIds) {
        const node = requireUnlocked(doc, id);
        const pageId = pageIdOf(doc, id);
        const list = siblingList(doc, node.parentId, pageId);
        const from = list.indexOf(id);
        if (from < 0) continue;
        const to =
          operation.to === "front"
            ? list.length - 1
            : operation.to === "back"
              ? 0
              : operation.to === "forward"
                ? Math.min(from + 1, list.length - 1)
                : Math.max(from - 1, 0);
        if (to === from) continue;
        list.splice(from, 1);
        list.splice(to, 0, id);
        ctx.touched.add(id);
        inverse.unshift({
          op: "reparentNodes",
          nodeIds: [id],
          newParentId: node.parentId,
          pageId,
          index: from,
        });
      }
      return { inverse, summary: `Bring ${operation.to}` };
    }

    // ----------------------------------------------------------------- group
    case "groupNodes": {
      const members = operation.nodeIds.map((id) => requireUnlocked(doc, id));
      const first = members[0];
      const pageId = pageIdOf(doc, first.id);
      const parentId = first.parentId;
      if (members.some((m) => m.parentId !== parentId)) {
        throw new DesignOperationError("invalid", "Only layers with the same parent can be grouped.");
      }
      const minX = Math.min(...members.map((m) => m.x));
      const minY = Math.min(...members.map((m) => m.y));
      const maxX = Math.max(...members.map((m) => m.x + m.width));
      const maxY = Math.max(...members.map((m) => m.y + m.height));
      const groupId = operation.groupId ?? ctx.mintId("g");
      const list = siblingList(doc, parentId, pageId);
      const insertAt = Math.min(...members.map((m) => list.indexOf(m.id)).filter((i) => i >= 0));
      const group = nodeSchema.parse({
        ...nodeDefaultsFor("group"),
        id: groupId,
        type: "group",
        name: operation.name ?? "Group",
        parentId,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        children: [],
      });
      doc.nodes[groupId] = group;
      attach(doc, groupId, parentId, pageId, insertAt);
      const previousIndexes: { id: NodeId; index: number }[] = [];
      for (const member of members) {
        const detached = detach(doc, member.id);
        previousIndexes.push({ id: member.id, index: detached.index });
        member.x -= minX;
        member.y -= minY;
        attach(doc, member.id, groupId, pageId);
        ctx.touched.add(member.id);
      }
      ctx.touched.add(groupId);
      ctx.selection = [groupId];
      return { inverse: [{ op: "ungroupNodes", nodeIds: [groupId] }], summary: `Group ${members.length} layers` };
    }

    case "ungroupNodes": {
      const inverse: DesignOperation[] = [];
      for (const groupId of operation.nodeIds) {
        const group = requireUnlocked(doc, groupId);
        if (!isContainer(group)) throw new DesignOperationError("invalid", `“${group.name}” is not a group.`);
        const pageId = pageIdOf(doc, groupId);
        const parentId = group.parentId;
        const list = siblingList(doc, parentId, pageId);
        const at = list.indexOf(groupId);
        const children = [...group.children];
        for (const [offset, childId] of children.entries()) {
          detach(doc, childId);
          const child = doc.nodes[childId];
          child.x += group.x;
          child.y += group.y;
          attach(doc, childId, parentId, pageId, at + offset);
          ctx.touched.add(childId);
        }
        detach(doc, groupId);
        delete doc.nodes[groupId];
        ctx.touched.add(groupId);
        ctx.selection = children;
        inverse.unshift({ op: "groupNodes", nodeIds: children, groupId, name: group.name });
      }
      return { inverse, summary: "Ungroup" };
    }

    // ----------------------------------------------------------------- pages
    case "createPage": {
      if (doc.pages.length >= MAX_PAGES) {
        throw new DesignOperationError("invalid", `A document can hold at most ${MAX_PAGES} pages.`);
      }
      const pageId = operation.pageId ?? ctx.mintId("p");
      if (doc.pages.some((p) => p.id === pageId)) {
        throw new DesignOperationError("invalid", `A page with id ${pageId} already exists.`);
      }
      const at = operation.index === undefined ? doc.pages.length : Math.max(0, Math.min(operation.index, doc.pages.length));
      doc.pages.splice(at, 0, {
        id: pageId,
        name: operation.name,
        children: [],
        backgroundColor: { ...(operation.backgroundColor ?? DEFAULT_PAGE_BACKGROUND) },
      });
      return { inverse: [{ op: "deletePage", pageId }], summary: `Add page ${operation.name}` };
    }

    case "deletePage": {
      const index = doc.pages.findIndex((p) => p.id === operation.pageId);
      if (index < 0) throw new DesignOperationError("not-found", `No page ${operation.pageId} in this document.`);
      // The document schema requires a page: a document with none could be
      // written but never read back.
      if (doc.pages.length === 1) throw new DesignOperationError("invalid", "A document must keep at least one page.");

      const page = doc.pages[index];
      // Delegate the artwork to `deleteNodes` rather than tearing the tree down
      // here, so a page delete and a layer delete produce the same inverse and
      // the same interaction/animation cleanup.
      const removedArtwork = page.children.length
        ? applyOne(doc, { op: "deleteNodes", nodeIds: [...page.children] }, ctx).inverse
        : [];
      doc.pages.splice(index, 1);
      return {
        // The page has to exist again before its layers can be attached to it.
        inverse: [
          { op: "createPage", pageId: page.id, name: page.name, index, backgroundColor: page.backgroundColor },
          ...removedArtwork,
        ],
        summary: `Delete page ${page.name}`,
      };
    }

    case "renamePage": {
      const page = doc.pages.find((p) => p.id === operation.pageId);
      if (!page) throw new DesignOperationError("not-found", `No page ${operation.pageId} in this document.`);
      const before = page.name;
      page.name = operation.name;
      return { inverse: [{ op: "renamePage", pageId: page.id, name: before }], summary: `Rename page to ${operation.name}` };
    }

    case "renameDocument": {
      // The header's name field used to PATCH the artifact and stop there, so
      // the artifact was renamed and the document was not — and every export
      // still carried the authored name, because `doc.name` is what names the
      // file. Renaming through the operation layer is what puts the two back in
      // step, and what makes the rename undoable with everything else.
      const before = doc.name;
      doc.name = operation.name;
      return { inverse: [{ op: "renameDocument", name: before }], summary: `Rename design to ${operation.name}` };
    }

    // ---------------------------------------------------------------- assets
    case "createAsset": {
      const before = doc.assets[operation.asset.id];
      doc.assets[operation.asset.id] = operation.asset;
      return {
        inverse: before ? [{ op: "createAsset", asset: before }] : [{ op: "deleteAsset", assetId: operation.asset.id }],
        summary: "Add image",
      };
    }

    case "deleteAsset": {
      const removed = doc.assets[operation.assetId];
      if (!removed) return { inverse: [], summary: "Remove image" };
      delete doc.assets[operation.assetId];
      // Image nodes keep pointing at it. There is no such thing as an image node
      // without an asset id, so the reference cannot be cleared the way a
      // variable binding is; the renderer draws its placeholder, and the inverse
      // puts the picture back exactly where it was.
      for (const node of Object.values(doc.nodes)) {
        if (node.type === "image" && node.assetId === operation.assetId) ctx.touched.add(node.id);
      }
      return { inverse: [{ op: "createAsset", asset: removed }], summary: "Remove image" };
    }

    // ------------------------------------------------------------- selection
    case "setSelection": {
      // Selection is view state, not document state: it is an operation so the
      // AI can *express* a selection change and the editor can replay one, but
      // it writes nothing and inverts to nothing.
      ctx.selection = operation.nodeIds.filter((id) => !!doc.nodes[id]);
      return { inverse: [], summary: "Select" };
    }

    // ----------------------------------------------------------- constraints
    case "setConstraints": {
      const inverse: DesignOperation[] = [];
      for (const id of operation.nodeIds) {
        const node = requireUnlocked(doc, id);
        inverse.push({ op: "setConstraints", nodeIds: [id], constraints: { ...node.constraints } });
        node.constraints = { ...operation.constraints };
        ctx.touched.add(id);
      }
      return { inverse, summary: "Set constraints" };
    }

    case "setAutoLayout": {
      const node = requireUnlocked(doc, operation.nodeId);
      if (!isContainer(node)) throw new DesignOperationError("invalid", `“${node.name}” cannot have auto layout.`);
      const before = node.layout ? { ...node.layout } : null;
      node.layout = operation.layout ? { ...operation.layout } : null;
      ctx.touched.add(node.id);
      return {
        inverse: [{ op: "setAutoLayout", nodeId: node.id, layout: before }],
        summary: operation.layout ? `Auto layout on ${node.name}` : `Remove auto layout from ${node.name}`,
      };
    }

    // ------------------------------------------------------------ components
    case "createComponent": {
      const node = requireNode(doc, operation.nodeId);
      const componentId = operation.componentId ?? ctx.mintId("c");
      if (doc.components[componentId]) throw new DesignOperationError("invalid", `Component ${componentId} already exists.`);
      const converted = { ...(node as unknown as Record<string, unknown>) };
      if (!isContainer(node)) {
        throw new DesignOperationError("invalid", "Only a frame or group can become a component.");
      }
      converted.type = "component";
      converted.componentId = componentId;
      doc.nodes[node.id] = nodeSchema.parse(converted);
      doc.components[componentId] = {
        id: componentId,
        name: operation.name,
        description: operation.description ?? "",
        rootNodeId: node.id,
        properties: [],
        variants: {},
      };
      ctx.touched.add(node.id);
      return {
        inverse: [{ op: "deleteComponent", componentId }],
        summary: `Create component ${operation.name}`,
      };
    }

    case "deleteComponent": {
      const component = doc.components[operation.componentId];
      if (!component) return { inverse: [], summary: "Remove component" };
      const root = doc.nodes[component.rootNodeId];
      // Turn the main component node back into an ordinary frame rather than
      // deleting it: detaching a component must not destroy the artwork.
      if (root && root.type === "component") {
        const reverted = { ...(root as unknown as Record<string, unknown>) };
        reverted.type = "frame";
        delete reverted.componentId;
        doc.nodes[root.id] = nodeSchema.parse(reverted);
        ctx.touched.add(root.id);
      }
      delete doc.components[operation.componentId];
      return {
        inverse: [
          { op: "createComponent", nodeId: component.rootNodeId, componentId: component.id, name: component.name, description: component.description },
          ...component.properties.map((property) => ({ op: "setComponentProperty" as const, componentId: component.id, property })),
        ],
        summary: `Remove component ${component.name}`,
      };
    }

    case "createInstance": {
      const component = doc.components[operation.componentId];
      if (!component) throw new DesignOperationError("not-found", `No component ${operation.componentId}.`);
      const main = requireNode(doc, component.rootNodeId);
      const instanceId = operation.instanceId ?? ctx.mintId("i");
      const remap = new Map<NodeId, NodeId>();
      for (const id of subtreeIds(doc, main.id)) remap.set(id, id === main.id ? instanceId : ctx.mintId("n"));
      for (const id of subtreeIds(doc, main.id)) {
        const original = doc.nodes[id];
        const copy = cloneNodeShallow(original);
        copy.id = remap.get(id)!;
        copy.parentId = id === main.id ? operation.parentId : remap.get(original.parentId ?? "") ?? null;
        if ("children" in copy) {
          (copy as { children: NodeId[] }).children = (original as { children: NodeId[] }).children.map((c) => remap.get(c)!);
        }
        if (id === main.id) {
          copy.type = "instance";
          (copy as unknown as Record<string, unknown>).componentId = component.id;
          (copy as unknown as Record<string, unknown>).variantProperties = {};
          (copy as unknown as Record<string, unknown>).overrides = {};
          copy.name = component.name;
          copy.x = operation.x ?? main.x;
          copy.y = operation.y ?? main.y;
        }
        doc.nodes[copy.id] = nodeSchema.parse(copy);
        ctx.touched.add(copy.id);
      }
      attach(doc, instanceId, operation.parentId, operation.pageId);
      ctx.selection = [instanceId];
      return { inverse: [{ op: "deleteNodes", nodeIds: [instanceId] }], summary: `Insert ${component.name}` };
    }

    case "createVariant": {
      const component = doc.components[operation.componentId];
      if (!component) throw new DesignOperationError("not-found", `No component ${operation.componentId}.`);
      requireNode(doc, operation.nodeId);
      const key = canonicalVariantKey(operation.variantProperties);
      const before = component.variants[key];
      component.variants[key] = operation.nodeId;
      ctx.touched.add(operation.nodeId);
      return {
        inverse: before
          ? [{ op: "createVariant", componentId: component.id, nodeId: before, variantProperties: operation.variantProperties }]
          : [],
        summary: `Add variant ${key}`,
      };
    }

    case "setComponentProperty": {
      const component = doc.components[operation.componentId];
      if (!component) throw new DesignOperationError("not-found", `No component ${operation.componentId}.`);
      const index = component.properties.findIndex((p) => p.name === operation.property.name);
      const before = index >= 0 ? component.properties[index] : null;
      if (index >= 0) component.properties[index] = operation.property;
      else component.properties.push(operation.property);
      return {
        inverse: before ? [{ op: "setComponentProperty", componentId: component.id, property: before }] : [],
        summary: `Set property ${operation.property.name}`,
      };
    }

    // ------------------------------------------------------------- variables
    case "createVariable": {
      if (operation.collection && !doc.collections[operation.collection.id]) {
        doc.collections[operation.collection.id] = operation.collection;
      }
      if (!doc.collections[operation.variable.collectionId]) {
        throw new DesignOperationError("not-found", `No variable collection ${operation.variable.collectionId}.`);
      }
      const previous = doc.variables[operation.variable.id];
      doc.variables[operation.variable.id] = operation.variable;
      return {
        // Without this, undoing a "create a primary token and bind it" turn left
        // an orphaned token in the library that nothing referenced.
        inverse: previous
          ? [{ op: "createVariable", variable: previous }]
          : [{ op: "deleteVariable", variableId: operation.variable.id }],
        summary: `Add variable ${operation.variable.name}`,
      };
    }

    case "deleteVariable": {
      const removed = doc.variables[operation.variableId];
      if (!removed) return { inverse: [], summary: "Remove variable" };
      delete doc.variables[operation.variableId];
      // A binding that outlived its variable resolves to a stated failure rather
      // than a silent default, so bindings are unbound here as well.
      const rebind: DesignOperation[] = [];
      for (const node of Object.values(doc.nodes)) {
        for (const [property, variableId] of Object.entries(node.boundVariables)) {
          if (variableId !== operation.variableId) continue;
          delete node.boundVariables[property];
          ctx.touched.add(node.id);
          rebind.push({ op: "bindVariable", nodeId: node.id, property, variableId: operation.variableId });
        }
      }
      return { inverse: [{ op: "createVariable", variable: removed }, ...rebind], summary: `Remove variable ${removed.name}` };
    }

    case "bindVariable": {
      const node = requireUnlocked(doc, operation.nodeId);
      if (operation.variableId && !doc.variables[operation.variableId]) {
        throw new DesignOperationError("not-found", `No variable ${operation.variableId}.`);
      }
      const before = node.boundVariables[operation.property] ?? null;
      if (operation.variableId) node.boundVariables[operation.property] = operation.variableId;
      else delete node.boundVariables[operation.property];
      ctx.touched.add(node.id);
      return {
        inverse: [{ op: "bindVariable", nodeId: node.id, property: operation.property, variableId: before }],
        summary: operation.variableId ? `Bind ${operation.property}` : `Unbind ${operation.property}`,
      };
    }

    case "setVariableMode": {
      const collection = doc.collections[operation.collectionId];
      if (!collection) throw new DesignOperationError("not-found", `No variable collection ${operation.collectionId}.`);
      if (!collection.modes.some((m) => m.id === operation.modeId)) {
        throw new DesignOperationError("not-found", `Collection “${collection.name}” has no mode ${operation.modeId}.`);
      }
      const before = doc.activeModes[operation.collectionId] ?? collection.modes[0].id;
      doc.activeModes[operation.collectionId] = operation.modeId;
      return {
        inverse: [{ op: "setVariableMode", collectionId: collection.id, modeId: before }],
        summary: `Switch ${collection.name} to ${collection.modes.find((m) => m.id === operation.modeId)?.name ?? operation.modeId}`,
      };
    }

    // --------------------------------------------------- prototype & motion
    case "createInteraction": {
      requireNode(doc, operation.interaction.sourceNodeId);
      const before = doc.interactions[operation.interaction.id];
      doc.interactions[operation.interaction.id] = operation.interaction;
      ctx.touched.add(operation.interaction.sourceNodeId);
      return {
        inverse: before
          ? [{ op: "createInteraction", interaction: before }]
          : [{ op: "deleteInteraction", interactionId: operation.interaction.id }],
        summary: `Add ${operation.interaction.trigger.type} interaction`,
      };
    }

    case "deleteInteraction": {
      const before = doc.interactions[operation.interactionId];
      if (!before) return { inverse: [], summary: "Remove interaction" };
      delete doc.interactions[operation.interactionId];
      ctx.touched.add(before.sourceNodeId);
      return { inverse: [{ op: "createInteraction", interaction: before }], summary: "Remove interaction" };
    }

    case "createAnimation": {
      const before = doc.animations[operation.animation.id];
      for (const track of operation.animation.tracks) requireNode(doc, track.nodeId);
      doc.animations[operation.animation.id] = operation.animation;
      for (const track of operation.animation.tracks) ctx.touched.add(track.nodeId);
      return {
        inverse: before
          ? [{ op: "createAnimation", animation: before }]
          : [{ op: "deleteAnimation", animationId: operation.animation.id }],
        summary: `Add animation ${operation.animation.name}`,
      };
    }

    case "deleteAnimation": {
      const removed = doc.animations[operation.animationId];
      if (!removed) return { inverse: [], summary: "Remove animation" };
      delete doc.animations[operation.animationId];
      for (const track of removed.tracks) ctx.touched.add(track.nodeId);
      // Interactions that played this animation would dangle; they go with it.
      const restored: DesignOperation[] = [{ op: "createAnimation", animation: removed }];
      for (const [interactionId, interaction] of Object.entries(doc.interactions)) {
        if (interaction.action.type !== "play-animation" || interaction.action.animationId !== operation.animationId) continue;
        restored.push({ op: "createInteraction", interaction });
        delete doc.interactions[interactionId];
      }
      return { inverse: restored, summary: `Remove animation ${removed.name}` };
    }

    case "setKeyframes": {
      const animation = doc.animations[operation.animationId];
      if (!animation) throw new DesignOperationError("not-found", `No animation ${operation.animationId}.`);
      requireNode(doc, operation.track.nodeId);
      const index = animation.tracks.findIndex(
        (t) => t.nodeId === operation.track.nodeId && t.property === operation.track.property
      );
      const before = index >= 0 ? animation.tracks[index] : null;
      if (index >= 0) animation.tracks[index] = operation.track;
      else animation.tracks.push(operation.track);
      ctx.touched.add(operation.track.nodeId);
      return {
        inverse: before
          ? [{ op: "setKeyframes", animationId: animation.id, track: before }]
          : [{ op: "setKeyframes", animationId: animation.id, track: { ...operation.track, keyframes: [] } }],
        summary: `Set ${operation.track.property} keyframes`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneNodeShallow(node: DesignNode): DesignNode {
  return (typeof structuredClone === "function" ? structuredClone(node) : JSON.parse(JSON.stringify(node))) as DesignNode;
}

/** `createNode` only accepts primitive types; a deleted component or instance
 *  is restored as the closest container it can validly be recreated as, and its
 *  component linkage is re-established by the accompanying operations. */
function restorableType(type: DesignNode["type"]): "frame" | "group" | "rectangle" | "ellipse" | "line" | "path" | "text" | "image" {
  if (type === "component" || type === "instance") return "frame";
  return type;
}

/** Every writable field of a node, for rebuilding it on undo. */
function fullPatchOf(node: DesignNode): NodePatch {
  const record = node as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(nodePatchSchema.shape)) {
    if (key in record) patch[key] = record[key];
  }
  return patch as NodePatch;
}

function defaultName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Human-readable summary of what a patch changed, for the history panel. */
export function describePatch(patch: NodePatch): string {
  const keys = Object.keys(patch);
  if (keys.length === 0) return "No change";
  const words = keys.map((k) => {
    switch (k) {
      case "cornerRadius":
        return "corner radius";
      case "layoutChild":
        return "layout behaviour";
      case "widthMode":
      case "heightMode":
        return "sizing";
      case "characters":
        return "text";
      case "typography":
        return "type";
      case "fills":
        return "fill";
      case "strokes":
        return "stroke";
      case "x":
      case "y":
        return "position";
      case "width":
      case "height":
        return "size";
      default:
        return k;
    }
  });
  const unique = [...new Set(words)];
  return unique.length === 1 ? `Set ${unique[0]}` : `Set ${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

export function canonicalVariantKey(properties: Record<string, string>): string {
  return Object.keys(properties)
    .sort()
    .map((k) => `${k}=${properties[k]}`)
    .join(",");
}

/**
 * Whether a transaction stayed inside a permitted set of nodes.
 *
 * This is the check behind "selection-scoped requests must not modify unrelated
 * nodes". `allowed` is the selection plus the nodes a legitimate selection edit
 * may still touch — its own descendants (restyling a frame restyles what is in
 * it) and its ancestors (auto layout on a parent is how a child gets laid out).
 * Anything else is out of scope and the transaction is refused before it is
 * offered to the user, rather than after they have applied it.
 */
export function transactionIsScopedTo(
  doc: DesignDocument,
  result: TransactionResult,
  allowedRoots: NodeId[]
): { ok: true } | { ok: false; strayIds: NodeId[] } {
  const allowed = new Set<NodeId>();
  for (const rootId of allowedRoots) {
    for (const id of subtreeIds(doc, rootId)) allowed.add(id);
    let cursor = doc.nodes[rootId]?.parentId ?? null;
    const guard = Object.keys(doc.nodes).length + 1;
    for (let i = 0; cursor && i <= guard; i++) {
      allowed.add(cursor);
      cursor = doc.nodes[cursor]?.parentId ?? null;
    }
  }
  // Nodes that did not exist before the transaction are, by definition, new —
  // creating them is in scope as long as they landed under an allowed parent.
  const stray = result.touchedNodeIds.filter((id) => {
    if (allowed.has(id)) return false;
    const created = result.document.nodes[id];
    if (created && !doc.nodes[id]) {
      let cursor = created.parentId;
      const guard = Object.keys(result.document.nodes).length + 1;
      for (let i = 0; cursor && i <= guard; i++) {
        if (allowed.has(cursor)) return false;
        cursor = result.document.nodes[cursor]?.parentId ?? null;
      }
    }
    return true;
  });
  return stray.length === 0 ? { ok: true } : { ok: false, strayIds: stray };
}

export { DesignValidationError };
