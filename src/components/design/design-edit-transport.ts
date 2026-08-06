"use client";

/**
 * Asking Juno for a design change, from the browser.
 *
 * The wire shape is deliberately the *previewed* transaction and nothing else:
 * the route has already validated the model's operations, applied them to a
 * clone and refused anything that reached outside the selection, so what arrives
 * here is a change the document model has agreed to — but has not stored. The
 * editor draws it, the user accepts it, and only then does it travel back out
 * through the ordinary transaction endpoint.
 *
 * Every failure is a sentence, not a status code. A model that wrote no
 * operations, wrote invalid ones, or strayed outside the selection are three
 * different things to say, and the route names which one happened.
 */

import type { PendingProposal } from "@/components/design/use-design-document";
import type { DesignAdjustment } from "@/lib/design/ai";
import type { DesignOperation, DesignTransaction } from "@/lib/design/operations";
import type { DesignDocument, NodeId } from "@/lib/design/types";

export interface DesignEditProposal {
  transaction: DesignTransaction;
  /** The document as it would be. Shown on the canvas; never stored. */
  preview: DesignDocument;
  touchedNodeIds: NodeId[];
  selection: NodeId[] | null;
  summaries: string[];
  /** Operations that undo the proposal, as the operation layer derived them. */
  inverse: DesignOperation[];
  /** Before/after lines for the review card. */
  changes: string[];
  /** Live controls the model offered for values worth tuning by hand. */
  adjustments: DesignAdjustment[];
  /** Set when Juno declined to change anything and answered instead. */
  note: string | null;
  model: string;
}

export class DesignEditRequestError extends Error {
  /** The route's own classification — "unusable", "conflict", "provider"… */
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DesignEditRequestError";
    this.code = code;
  }
}

export interface DesignEditRequest {
  artifactId: string;
  prompt: string;
  pageId: string;
  /** The layers the request was made from. Empty means "anywhere". */
  selectedNodeIds: NodeId[];
  /** The revision the canvas is showing. A mismatch is refused, not rebased. */
  baseRevision: number;
  signal?: AbortSignal;
}

export async function requestDesignEdit(request: DesignEditRequest): Promise<DesignEditProposal> {
  const res = await fetch(`/api/design/${request.artifactId}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: request.prompt,
      pageId: request.pageId,
      selectedNodeIds: request.selectedNodeIds,
      baseRevision: request.baseRevision,
    }),
    signal: request.signal,
  });

  const data = (await res.json().catch(() => ({}))) as Partial<DesignEditProposal> & { error?: string; code?: string };
  if (!res.ok || !data.transaction || !data.preview) {
    throw new DesignEditRequestError(data.error ?? "Juno could not change this design.", data.code ?? "unknown");
  }

  return {
    transaction: data.transaction,
    preview: data.preview,
    touchedNodeIds: data.touchedNodeIds ?? [],
    selection: data.selection ?? null,
    summaries: data.summaries ?? [],
    inverse: data.inverse ?? [],
    changes: data.changes ?? [],
    adjustments: data.adjustments ?? [],
    note: data.note ?? null,
    model: data.model ?? "Juno",
  };
}

/**
 * Reshape a proposal into what the editor's pending slot holds.
 *
 * The preview document travels whole rather than being re-derived here: it is
 * the exact scene the server validated, and re-applying the operations in the
 * browser to get a second copy would introduce a way for the two to disagree
 * about what the user is being asked to accept. Accepting still replays the
 * operations against the live document — see `acceptPending` — so this object
 * is only ever what gets drawn.
 */
export function toPendingProposal(proposal: DesignEditProposal): PendingProposal {
  return {
    transaction: proposal.transaction,
    result: {
      document: proposal.preview,
      inverse: proposal.inverse,
      touchedNodeIds: proposal.touchedNodeIds,
      selection: proposal.selection,
      summaries: proposal.summaries,
    },
    changes: proposal.changes,
    preview: proposal.preview,
  };
}
