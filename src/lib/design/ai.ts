/**
 * AI-assisted design editing.
 *
 * Built on the mechanism the canvas already uses for targeted artifact edits
 * (`artifact-edit.ts`): the model returns a machine-readable block, the app
 * validates it, and only the validated result is applied. Nothing here is
 * provider-specific — it is a system contract plus a parser, so it rides the
 * existing `streamChat` abstraction unchanged rather than adding a second,
 * model-specific pipeline.
 *
 * The model never touches the document. It proposes a `DesignTransaction`; the
 * operation layer validates it, applies it to a *clone* for preview, and only
 * the user's Apply commits it. A rejected transaction is discarded without ever
 * having reached the stored document.
 */

import { z } from "zod";
import {
  applyTransaction,
  designOperationSchema,
  DesignOperationError,
  transactionIsScopedTo,
  type DesignOperation,
  type DesignTransaction,
  type TransactionResult,
} from "@/lib/design/operations";
import { buildDocumentSummary, type DesignSelectionContext } from "@/lib/design/selection-context";
import type { DesignDocument, NodeId } from "@/lib/design/types";

const DESIGN_OPS_RE = /<juno:design-ops(?:\s[^>]*)?>([\s\S]*?)<\/juno:design-ops>/i;
const MAX_OPERATIONS = 60;

export class DesignAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignAiError";
  }
}

/**
 * A contextual control the model may offer alongside its change.
 *
 * Bound to a document property that the operation layer can validate, never to
 * arbitrary code: moving the slider emits an ordinary `updateNode`, so an
 * AI-generated control has exactly the authority a manual inspector field has.
 */
export const adjustmentSchema = z.discriminatedUnion("control", [
  z.object({
    control: z.literal("slider"),
    label: z.string().min(1).max(80),
    nodeIds: z.array(z.string().min(1).max(120)).min(1).max(200),
    property: z.enum(["cornerRadius", "opacity", "rotation", "width", "height", "x", "y"]),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    value: z.number().finite(),
  }),
  z.object({
    control: z.literal("color"),
    label: z.string().min(1).max(80),
    nodeIds: z.array(z.string().min(1).max(120)).min(1).max(200),
    property: z.literal("fills.0.color"),
    value: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
  }),
  z.object({
    control: z.literal("segmented"),
    label: z.string().min(1).max(80),
    kind: z.enum(["variant", "variable-mode"]),
    /** For `variant`: the instance node. For `variable-mode`: the collection. */
    targetId: z.string().min(1).max(120),
    /** Property name for a variant; unused for a mode switch. */
    property: z.string().max(120).optional(),
    options: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(200) })).min(2).max(12),
    value: z.string().min(1).max(200),
  }),
]);

export type DesignAdjustment = z.infer<typeof adjustmentSchema>;

export const designProposalSchema = z.object({
  summary: z.string().min(1).max(400),
  operations: z.array(designOperationSchema).min(1).max(MAX_OPERATIONS),
  /** Revision the model was shown. Mandatory: a proposal for a document that
   *  has since moved must be refused, not rebased onto a scene it never saw. */
  baseRevision: z.number().int().min(0),
  adjustments: z.array(adjustmentSchema).max(6).optional(),
  /** Set when the model declined to change anything and is answering instead. */
  note: z.string().max(2_000).optional(),
});

export type DesignProposal = z.infer<typeof designProposalSchema>;

/** Extract and validate the model's proposal block. */
export function parseDesignProposal(raw: string): DesignProposal {
  const tagged = DESIGN_OPS_RE.exec(raw)?.[1]?.trim();
  if (!tagged) throw new DesignAiError("Juno did not return any design operations.");
  const body = tagged.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new DesignAiError("Juno returned design operations that are not valid JSON.");
  }

  const parsed = designProposalSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DesignAiError(`Juno returned an unusable design operation (${first.path.join(".") || "root"}: ${first.message}).`);
  }
  return parsed.data;
}

export interface PreviewedProposal {
  transaction: DesignTransaction;
  result: TransactionResult;
  proposal: DesignProposal;
  /** Ordered, human-readable lines for the before/after review. */
  changes: string[];
}

/**
 * Turn a validated proposal into a previewable transaction.
 *
 * Applies against a clone so the caller holds both the current and the proposed
 * document and can show either. Nothing is persisted here; the caller commits
 * only after the user accepts.
 *
 * `scopeTo` is the selection the request was made from. When present, the
 * transaction is refused outright if it touched anything outside that scope —
 * which is what makes "only that selection changes" a property of the system
 * rather than a hope about the prompt.
 */
export function previewProposal(
  doc: DesignDocument,
  proposal: DesignProposal,
  opts: { transactionId: string; now: string; scopeTo?: NodeId[] | null; commentId?: string | null }
): PreviewedProposal {
  if (proposal.baseRevision !== doc.revision) {
    throw new DesignAiError(
      `The document changed while Juno was working (it saw revision ${proposal.baseRevision}, the document is at ${doc.revision}). Ask again to work from the current version.`
    );
  }

  const transaction: DesignTransaction = {
    id: opts.transactionId,
    baseRevision: doc.revision,
    operations: proposal.operations as DesignOperation[],
    author: "juno",
    summary: proposal.summary,
    commentId: opts.commentId ?? null,
    createdAt: opts.now,
  };

  let result: TransactionResult;
  try {
    result = applyTransaction(doc, transaction);
  } catch (error) {
    if (error instanceof DesignOperationError) throw new DesignAiError(error.message);
    throw error;
  }

  if (opts.scopeTo && opts.scopeTo.length > 0) {
    const verdict = transactionIsScopedTo(doc, result, opts.scopeTo);
    if (!verdict.ok) {
      const names = verdict.strayIds.map((id) => doc.nodes[id]?.name ?? id).slice(0, 5);
      throw new DesignAiError(
        `Juno's change would also have modified ${names.join(", ")}, which is outside your selection. It was not applied.`
      );
    }
  }

  return { transaction, result, proposal, changes: describeChanges(doc, result) };
}

/** Before/after lines for the review card — what actually differs, per node. */
export function describeChanges(before: DesignDocument, result: TransactionResult): string[] {
  const lines: string[] = [];
  for (const id of result.touchedNodeIds) {
    const previous = before.nodes[id];
    const next = result.document.nodes[id];
    const name = next?.name ?? previous?.name ?? id;
    if (!previous && next) {
      lines.push(`Added ${next.type} “${name}”`);
      continue;
    }
    if (previous && !next) {
      lines.push(`Removed “${name}”`);
      continue;
    }
    if (!previous || !next) continue;

    const diffs = fieldDiffs(previous as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (diffs.length > 0) lines.push(`${name}: ${diffs.join(", ")}`);
  }
  return lines;
}

const REPORTED_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "visible",
  "locked",
  "cornerRadius",
  "fills",
  "strokes",
  "shadows",
  "blur",
  "characters",
  "typography",
  "layout",
  "constraints",
  "widthMode",
  "heightMode",
  "name",
  "parentId",
] as const;

function fieldDiffs(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of REPORTED_FIELDS) {
    if (!(field in before) && !(field in after)) continue;
    const a = before[field];
    const b = after[field];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push(`${field} ${format(a)} → ${format(b)}`);
  }
  return out;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  if (typeof value === "boolean" || typeof value === "string") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "none" : `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "changed";
}

// ---------------------------------------------------------------------------
// The system contract
// ---------------------------------------------------------------------------

/**
 * The design tool surface, as the model sees it.
 *
 * Read tools are satisfied by the context attached to the turn (the selection
 * payload below) rather than by a round trip, and write tools are the operation
 * vocabulary — so what the model can express is exactly what the operation layer
 * can validate. There is no tool that runs code, writes a file, or reaches the
 * network.
 */
export const DESIGN_TOOLS = [
  { name: "get_design_document_summary", kind: "read", describe: "Pages, top-level frames, components, variable collections and counts." },
  { name: "get_current_design_selection", kind: "read", describe: "The selected node ids with their computed frames, styles and bindings." },
  { name: "inspect_design_nodes", kind: "read", describe: "A bounded subtree for named nodes, with layout and constraint context." },
  { name: "render_design_preview", kind: "read", describe: "A cropped rendered image of the selection." },
  { name: "create_design_nodes", kind: "write", describe: "createNode operations." },
  { name: "apply_design_operations", kind: "write", describe: "Any validated operation from the vocabulary below." },
  { name: "create_component", kind: "write", describe: "createComponent / createInstance." },
  { name: "create_variant_set", kind: "write", describe: "createVariant / setComponentProperty." },
  { name: "bind_design_variable", kind: "write", describe: "createVariable / bindVariable / setVariableMode." },
  { name: "create_prototype_interaction", kind: "write", describe: "createInteraction." },
  { name: "create_motion_animation", kind: "write", describe: "createAnimation / setKeyframes." },
  { name: "undo_design_transaction", kind: "control", describe: "The user's one-click revert of an applied Juno transaction." },
] as const;

const OPERATION_VOCABULARY = [
  `{"op":"createNode","parentId":<nodeId|null>,"pageId":"<pageId>","index":<n?>,"node":{"type":"frame|group|rectangle|ellipse|line|path|text|image","id":"<optional>","name":"<optional>","patch":{…}}}`,
  `{"op":"updateNode","nodeId":"<id>","patch":{…only fields that node type has…}}`,
  `{"op":"deleteNodes","nodeIds":["<id>",…]}`,
  `{"op":"duplicateNodes","nodeIds":["<id>",…],"offset":{"x":16,"y":16}}`,
  `{"op":"reparentNodes","nodeIds":["<id>"],"newParentId":<id|null>,"pageId":"<pageId>","index":<n?>}`,
  `{"op":"reorderNodes","nodeIds":["<id>"],"to":"front|back|forward|backward"}`,
  `{"op":"groupNodes","nodeIds":["<id>",…],"name":"<optional>"}  /  {"op":"ungroupNodes","nodeIds":["<groupId>"]}`,
  `{"op":"setSelection","nodeIds":["<id>",…]}`,
  `{"op":"setConstraints","nodeIds":["<id>"],"constraints":{"horizontal":"min|max|center|stretch|scale","vertical":…}}`,
  `{"op":"setAutoLayout","nodeId":"<id>","layout":{"direction":"horizontal|vertical|grid","padding":{"top":n,"right":n,"bottom":n,"left":n},"gap":n,"align":"start|center|end|baseline","justify":"start|center|end|space-between|space-around|space-evenly","wrap":false}|null}`,
  `{"op":"createComponent","nodeId":"<id>","name":"<name>"}  /  {"op":"createInstance","componentId":"<id>","parentId":<id|null>,"pageId":"<pageId>"}`,
  `{"op":"createVariant","componentId":"<id>","nodeId":"<id>","variantProperties":{"Size":"Large"}}`,
  `{"op":"setComponentProperty","componentId":"<id>","property":{"name":"Label","type":"text","defaultValue":"Sign in"}}`,
  `{"op":"createVariable","collection":{…optional new collection…},"variable":{"id":"…","collectionId":"…","name":"primary","type":"color","valuesByMode":{"<modeId>":{"kind":"color","value":{"r":0,"g":0,"b":0,"a":1}}}}}`,
  `{"op":"bindVariable","nodeId":"<id>","property":"fills.0.color","variableId":"<id>|null"}`,
  `{"op":"setVariableMode","collectionId":"<id>","modeId":"<id>"}`,
  `{"op":"createInteraction","interaction":{"id":"…","sourceNodeId":"<id>","trigger":{"type":"click|hover|press|drag|key|delay|scroll-into-view"},"action":{…},"transition":{"kind":"instant|dissolve|slide|push|move","durationMs":200,"delayMs":0,"easing":{"type":"ease-out"},"matchStableIds":true}}}`,
  `{"op":"createAnimation","animation":{"id":"…","name":"…","durationMs":300,"loop":false,"tracks":[{"nodeId":"<id>","property":"scale","keyframes":[{"time":0,"value":1,"easing":{"type":"spring","stiffness":300,"damping":22,"mass":1}}]}]}}`,
  `{"op":"setKeyframes","animationId":"<id>","track":{…as above…}}`,
];

/** Colours are objects with 0..1 components, so the model never has to guess a
 *  colour space — and the schema rejects anything else. */
const COLOR_NOTE = `Colours are {"r":0..1,"g":0..1,"b":0..1,"a":0..1}. Prefer binding an existing variable over a literal colour when one matches.`;

export interface DesignPromptTarget {
  identifier: string;
  title: string;
  version: number;
}

/** The turn-specific system contract for a design edit. */
export function buildDesignEditPrompt(
  target: DesignPromptTarget,
  doc: DesignDocument,
  selection: DesignSelectionContext | null,
  request: { scoped: boolean; commentBody?: string | null }
): string {
  const summary = buildDocumentSummary(doc);
  const scopeRule = request.scoped
    ? `SCOPE: this request comes from a selection. Change ONLY the selected nodes and their descendants (and, when the request genuinely requires it, an ancestor's layout). A transaction that touches anything else is rejected automatically and nothing is applied.`
    : `SCOPE: no selection was made, so you may work anywhere in the document — but still make the smallest change that satisfies the request.`;

  return `# Juno Design — structured editing

You are editing the design document "${target.title}" (${target.identifier}), revision ${doc.revision}. This is a scene graph, not code: you change it only by returning validated operations. You cannot write HTML, CSS or a component — those are not how this document is stored.

Return ONLY this block, with valid JSON inside it:
<juno:design-ops>
{"summary":"One short sentence in the past tense","baseRevision":${doc.revision},"operations":[ … ],"adjustments":[ … optional … ]}
</juno:design-ops>

${scopeRule}

Rules:
- Address every node by its stable id from the context below. Never invent an id for an existing node.
- Only emit operations from the vocabulary. Anything else is rejected.
- \`updateNode.patch\` may only name fields that node type actually has (a rectangle has no \`characters\`).
- Make the smallest set of operations that achieves the request; do not "tidy" anything you were not asked about.
- \`baseRevision\` must be exactly ${doc.revision}.
- ${COLOR_NOTE}
- If the request cannot be satisfied with operations, return one \`setSelection\` operation for the relevant nodes and explain why in \`note\`.

Optional \`adjustments\` offer the user a live control for a value worth tuning. Each binds to a validated document property — never to code:
{"control":"slider","label":"Corner radius","nodeIds":["<id>"],"property":"cornerRadius","min":0,"max":32,"step":1,"value":12}
{"control":"color","label":"Background","nodeIds":["<id>"],"property":"fills.0.color","value":"#334de6"}
{"control":"segmented","label":"Theme","kind":"variable-mode","targetId":"<collectionId>","options":[{"label":"Light","value":"<modeId>"},{"label":"Dark","value":"<modeId>"}],"value":"<modeId>"}

Operation vocabulary:
${OPERATION_VOCABULARY.map((line) => `- ${line}`).join("\n")}

DOCUMENT SUMMARY:
${JSON.stringify(summary)}

${
  selection
    ? `CURRENT SELECTION (revision ${selection.revision}):\n${JSON.stringify({
        selectedNodeIds: selection.selectedNodeIds,
        selection: selection.selection,
        ancestors: selection.ancestors,
        siblings: selection.siblings,
        variables: selection.variables,
        interactions: selection.interactions,
        animations: selection.animations,
        comments: selection.comments,
      })}`
    : "CURRENT SELECTION: none."
}${
    request.commentBody
      ? `\n\nThis request came from an inline comment on the selection:\n"""${request.commentBody.slice(0, 2_000)}"""`
      : ""
  }`;
}
