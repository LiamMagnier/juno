"use client";

/**
 * Editor state for one design document.
 *
 * Everything the editor can do is a `DesignTransaction`. A pointer drag, a
 * keyboard nudge and an accepted AI proposal all arrive here the same way, get
 * validated by the same operation layer, and land on the same undo stack. There
 * is no second, "quicker" mutation path — that is what makes undo, replay,
 * conflict detection and the AI review work at all.
 *
 * Persistence is optimistic and honest: the transaction is applied locally
 * first so the canvas never waits on the network, then sent. A server refusal
 * rolls the local document back to the server's copy and says so, rather than
 * leaving the user editing a document that no longer exists in that shape.
 *
 * Sending is queued rather than immediate. One request is in flight at a time
 * and everything authored while it is out leaves together on the next one, with
 * the states nobody will see dropped on the way — a drag across the canvas used
 * to cost a round trip per gesture, and a stored copy of the whole document per
 * round trip. What is queued is operations, not documents, so a batch is still
 * one validated transaction against a named revision.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  applyTransaction,
  coalesceOperations,
  DesignOperationError,
  invertTransaction,
  mintsIds,
  type DesignOperation,
  type DesignTransaction,
  type TransactionResult,
} from "@/lib/design/operations";
import { parseStoredDesignDocument } from "@/lib/design/migrations";
import { subtreeIds } from "@/lib/design/document";
import type { AssetRef, DesignDocument, NodeId, PageId } from "@/lib/design/types";

export interface HistoryEntry {
  id: string;
  summary: string;
  author: "user" | "juno";
  at: string;
  /** Node ids the entry touched — the history panel highlights them on hover. */
  touched: NodeId[];
  /** The transaction that undoes it, applied against the revision it produced. */
  undo: DesignTransaction;
  /** The transaction itself, so redo replays rather than reconstructs. */
  redo: DesignTransaction;
  /** Set when the entry is a checkpoint (an autosaved artifact version). */
  version?: number;
}

export interface PendingProposal {
  transaction: DesignTransaction;
  result: TransactionResult;
  changes: string[];
  /** The document as it would be — shown live on the canvas while pending. */
  preview: DesignDocument;
}

/**
 * Where a committed transaction goes.
 *
 * Pluggable because the same editor runs in two places: in the browser it POSTs
 * to `/api/design/[id]/transactions`, and inside the Mac's WKWebView it hands
 * the transaction to the native host across the design bridge. Everything above
 * this boundary — the canvas, the inspector, undo, the AI review — is identical
 * on both, which is the whole point of hosting one editor rather than writing
 * two.
 */
export interface DesignTransport {
  /** `document` is the post-transaction state the editor already holds. The
   *  HTTP transport ignores it (the server recomputes from the operations, and
   *  must, since a client's word is not evidence); the bridge transport ships it
   *  so the Mac can validate and store it without replaying anything. */
  commit(
    transaction: DesignTransaction,
    origin: "edit" | "restore",
    document: DesignDocument
  ): Promise<
    | { ok: true; document?: DesignDocument; version?: number }
    | { ok: false; message: string; document?: DesignDocument }
  >;
}

/** The website's transport: one authenticated POST per transaction. */
export function httpTransport(artifactId: string): DesignTransport {
  return {
    async commit(transaction, origin) {
      const res = await fetch(`/api/design/${artifactId}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction, origin }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        document?: DesignDocument;
        artifact?: { currentVersion: number };
        error?: string;
      };
      if (!res.ok) return { ok: false, message: data.error ?? "Could not save that change.", document: data.document };
      return { ok: true, document: data.document, version: data.artifact?.currentVersion };
    },
  };
}

interface Options {
  artifactId: string;
  initialContent: string;
  /** Defaults to the website's HTTP transport. */
  transport?: DesignTransport;
  /** Called after a committed change so the canvas shell can refresh the
   *  artifact envelope (version number, history rail). */
  onCommitted?: (version: number) => void;
  /** Read-only when an older version is on screen. */
  readOnly?: boolean;
}

let localCounter = 0;
const nextTransactionId = () => `tx-${Date.now().toString(36)}-${(localCounter++).toString(36)}`;
const nextAssetId = () => `img-${Date.now().toString(36)}-${(localCounter++).toString(36)}`;

/** Mirrors `designTransactionSchema`'s ceiling: a batch that grew past it would
 *  be refused as a whole, so batching stops short of it and sends two. */
const MAX_OPERATIONS_PER_TRANSACTION = 500;

/**
 * One outgoing transaction, still accumulating.
 *
 * Batches merge while a request is in flight, which is what turns a run of
 * gestures into one round trip. They never merge across authors or origins: a
 * change Juno wrote and a change the user typed are separate things to the
 * history, to the store's checkpoint rule, and to anyone reading either.
 */
interface PendingBatch {
  author: "user" | "juno";
  origin: "edit" | "restore";
  operations: DesignOperation[];
  summary: string;
  /** How many `apply` calls went into it, for the transmitted summary. */
  merged: number;
  /** Set when the batch mints ids: it goes out alone, under the id it was
   *  applied with, so the store mints exactly what the editor already drew. */
  sealedId?: string;
}

export function useDesignDocument(opts: Options) {
  const [document, setDocument] = React.useState<DesignDocument | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pageId, setPageId] = React.useState<PageId>("");
  const [selection, setSelection] = React.useState<NodeId[]>([]);
  const [undoStack, setUndoStack] = React.useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = React.useState<HistoryEntry[]>([]);
  const [pending, setPending] = React.useState<PendingProposal | null>(null);
  const [saving, setSaving] = React.useState(false);

  /** The newest document the transport has acknowledged, and the base every
   *  outgoing transaction is written against. */
  const ackedRef = React.useRef<DesignDocument | null>(null);
  const queueRef = React.useRef<PendingBatch[]>([]);
  const inFlightRef = React.useRef(false);
  /** Bumped whenever a different document is loaded, so a reply that arrives
   *  after the editor moved on cannot write into the new one. */
  const generationRef = React.useRef(0);

  // Parse once per content identity. A failure is a state the editor shows, not
  // an exception that blanks the panel.
  React.useEffect(() => {
    generationRef.current += 1;
    queueRef.current = [];
    try {
      const parsed = parseStoredDesignDocument(opts.initialContent);
      setDocument(parsed);
      ackedRef.current = parsed;
      setPageId((current) => (parsed.pages.some((p) => p.id === current) ? current : parsed.pages[0].id));
      setLoadError(null);
    } catch (error) {
      setDocument(null);
      ackedRef.current = null;
      setLoadError(error instanceof Error ? error.message : "This design document could not be read.");
    }
    setSelection([]);
    setUndoStack([]);
    setRedoStack([]);
    setPending(null);
  }, [opts.initialContent]);

  const documentRef = React.useRef<DesignDocument | null>(document);
  documentRef.current = document;

  const transport = React.useMemo(
    () => opts.transport ?? httpTransport(opts.artifactId),
    [opts.transport, opts.artifactId]
  );

  /** Give up on everything queued and put the canvas back on the stored
   *  document, so the editor never keeps drawing a state that was refused. */
  const rollback = React.useCallback((stored: DesignDocument | null, message: string) => {
    queueRef.current = [];
    if (stored) {
      ackedRef.current = stored;
      setDocument(stored);
      setUndoStack([]);
      setRedoStack([]);
    }
    toast.error(message);
  }, []);

  /**
   * Send queued work, one request at a time, until there is none left.
   *
   * Everything that piles up while a request is in flight leaves as a single
   * transaction on the next pass — a drag no longer costs a round trip per
   * gesture — and `coalesceOperations` throws away the states nobody will ever
   * see, so what goes over the wire is where the layer ended up rather than
   * every frame it passed through.
   *
   * Each transaction is rebuilt against the acknowledged document rather than
   * the local one. That is what keeps `baseRevision`, the transmitted document
   * and its revision consistent with each other: the Mac host validates all
   * three, and a batch assembled from a document the store has never seen would
   * be refused by it — correctly.
   */
  const drain = React.useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    const generation = generationRef.current;

    try {
      while (queueRef.current.length > 0 && generationRef.current === generation) {
        const batch = queueRef.current.shift()!;
        const base = ackedRef.current;
        if (!base) break;

        const transaction: DesignTransaction = {
          id: batch.sealedId ?? nextTransactionId(),
          baseRevision: base.revision,
          operations: coalesceOperations(batch.operations),
          author: batch.author,
          summary: batch.merged > 1 ? `${batch.summary} (+${batch.merged - 1} more)` : batch.summary,
          commentId: null,
          createdAt: new Date().toISOString(),
        };

        let applied: DesignDocument;
        try {
          applied = applyTransaction(base, transaction).document;
        } catch (error) {
          rollback(base, error instanceof Error ? error.message : "Could not save that change.");
          break;
        }

        let outcome;
        try {
          outcome = await transport.commit(transaction, batch.origin, applied);
        } catch {
          rollback(ackedRef.current, "Could not save that change.");
          break;
        }
        if (generationRef.current !== generation) break;

        if (!outcome.ok) {
          // The store's copy if it sent one, otherwise the last copy it
          // acknowledged: either way the canvas ends up on something that was
          // really saved, rather than on edits the store has never seen.
          rollback(outcome.document ?? ackedRef.current, outcome.message);
          break;
        }

        // The store's copy wins where it offers one; the bridge acknowledges
        // without returning a document, and its copy is what we just computed.
        ackedRef.current = outcome.document ?? applied;
        if (outcome.version != null) opts.onCommitted?.(outcome.version);
        // Nothing left to send means the local document and the stored one are
        // the same edits — adopt the stored copy so their revisions agree too,
        // which is what the AI's selection-scoped requests are addressed by.
        if (queueRef.current.length === 0) setDocument(ackedRef.current);
      }
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }, [opts, rollback, transport]);

  /**
   * Queue operations for the store. Merges into the batch still waiting to go
   * out, when that batch is the same kind of change.
   *
   * `transactionId` is the id the operations were applied under locally.
   * Operations that mint ids are queued under it and never merged with
   * anything, so the store mints the same ids the canvas is already drawing.
   */
  const persist = React.useCallback(
    (
      operations: DesignOperation[],
      summary: string,
      author: "user" | "juno",
      transactionId: string,
      origin: "edit" | "restore" = "edit"
    ) => {
      if (mintsIds(operations)) {
        queueRef.current.push({ author, origin, operations: [...operations], summary, merged: 1, sealedId: transactionId });
        void drain();
        return;
      }

      const tail = queueRef.current.at(-1);
      if (
        tail &&
        !tail.sealedId &&
        tail.author === author &&
        tail.origin === origin &&
        tail.operations.length + operations.length <= MAX_OPERATIONS_PER_TRANSACTION
      ) {
        tail.operations.push(...operations);
        tail.merged += 1;
      } else {
        queueRef.current.push({ author, origin, operations: [...operations], summary, merged: 1 });
      }
      void drain();
    },
    [drain]
  );

  /**
   * Apply operations as one transaction.
   *
   * `author` distinguishes a manual edit from an applied Juno transaction in
   * the history panel; `persistChange: false` is for a purely local operation
   * such as `setSelection`, which changes no document state.
   */
  const apply = React.useCallback(
    (
      operations: DesignOperation[],
      // A bare string is the common case ("Move layer"); the object form is for
      // the few callers that also need `author` or a comment link.
      summaryOrOptions: string | { summary: string; author?: "user" | "juno"; persist?: boolean; commentId?: string | null } = "Edit"
    ): TransactionResult | null => {
      const options = typeof summaryOrOptions === "string" ? { summary: summaryOrOptions } : summaryOrOptions;
      const current = documentRef.current;
      if (!current || opts.readOnly) return null;

      const transaction: DesignTransaction = {
        id: nextTransactionId(),
        baseRevision: current.revision,
        operations,
        author: options.author ?? "user",
        summary: options.summary,
        commentId: ("commentId" in options ? options.commentId : null) ?? null,
        createdAt: new Date().toISOString(),
      };

      let result: TransactionResult;
      try {
        result = applyTransaction(current, transaction);
      } catch (error) {
        if (error instanceof DesignOperationError) {
          toast.error(error.message);
          return null;
        }
        throw error;
      }

      setDocument(result.document);
      if (result.selection) setSelection(result.selection);

      // A selection-only transaction is not history. Everything else is —
      // including the transactions that touch no *node* at all. Renaming the
      // document, adding a page, registering an asset: `touchedNodeIds` is
      // empty for each, so guarding on it alone silently dropped them, which
      // is how the header's rename came to update the field and persist
      // nothing.
      if (
        result.touchedNodeIds.length > 0 ||
        operations.some((operation) => operation.op !== "setSelection")
      ) {
        const entry: HistoryEntry = {
          id: transaction.id,
          summary: options.summary,
          author: transaction.author,
          at: transaction.createdAt,
          touched: result.touchedNodeIds,
          undo: invertTransaction(result, transaction, new Date().toISOString()),
          redo: transaction,
        };
        setUndoStack((stack) => [...stack.slice(-99), entry]);
        setRedoStack([]);
        if (!("persist" in options) || options.persist !== false) persist(operations, options.summary, transaction.author, transaction.id);
      }
      return result;
    },
    [opts.readOnly, persist]
  );

  const undo = React.useCallback(() => {
    const current = documentRef.current;
    const entry = undoStack.at(-1);
    if (!current || !entry || opts.readOnly) return;
    const transaction: DesignTransaction = { ...entry.undo, baseRevision: current.revision, id: nextTransactionId() };
    try {
      const result = applyTransaction(current, transaction);
      setDocument(result.document);
      if (result.selection) setSelection(result.selection);
      setUndoStack((stack) => stack.slice(0, -1));
      setRedoStack((stack) => [
        ...stack,
        { ...entry, undo: invertTransaction(result, transaction, new Date().toISOString()), redo: entry.redo },
      ]);
      persist(transaction.operations, `Undo ${entry.summary}`, entry.author, transaction.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not undo.");
    }
  }, [undoStack, opts.readOnly, persist]);

  const redo = React.useCallback(() => {
    const current = documentRef.current;
    const entry = redoStack.at(-1);
    if (!current || !entry || opts.readOnly) return;
    const transaction: DesignTransaction = { ...entry.redo, baseRevision: current.revision, id: nextTransactionId() };
    try {
      const result = applyTransaction(current, transaction);
      setDocument(result.document);
      if (result.selection) setSelection(result.selection);
      setRedoStack((stack) => stack.slice(0, -1));
      setUndoStack((stack) => [
        ...stack,
        { ...entry, undo: invertTransaction(result, transaction, new Date().toISOString()), redo: transaction },
      ]);
      persist(transaction.operations, `Redo ${entry.summary}`, entry.author, transaction.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not redo.");
    }
  }, [redoStack, opts.readOnly, persist]);

  /** Show a proposed transaction on the canvas without committing it. */
  const proposeTransaction = React.useCallback((proposal: PendingProposal) => setPending(proposal), []);

  const acceptPending = React.useCallback(async () => {
    const current = documentRef.current;
    if (!pending || !current) return;
    // Re-apply against the live document rather than trusting the preview: the
    // user may have edited while the proposal was on screen.
    const transaction: DesignTransaction = { ...pending.transaction, baseRevision: current.revision, id: nextTransactionId() };
    try {
      const result = applyTransaction(current, transaction);
      setDocument(result.document);
      if (result.selection) setSelection(result.selection);
      setUndoStack((stack) => [
        ...stack.slice(-99),
        {
          id: transaction.id,
          summary: pending.transaction.summary,
          author: "juno",
          at: transaction.createdAt,
          touched: result.touchedNodeIds,
          undo: invertTransaction(result, transaction, new Date().toISOString()),
          redo: transaction,
        },
      ]);
      setRedoStack([]);
      setPending(null);
      persist(transaction.operations, pending.transaction.summary, "juno", transaction.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not apply Juno's change.");
    }
  }, [pending, persist]);

  const rejectPending = React.useCallback(() => setPending(null), []);

  /** The document the canvas should draw: the preview while one is pending. */
  const visibleDocument = pending?.preview ?? document;

  const selectNodes = React.useCallback(
    (ids: NodeId[], mode: "replace" | "add" | "toggle" = "replace") => {
      setSelection((current) => {
        if (mode === "replace") return ids;
        if (mode === "add") return [...new Set([...current, ...ids])];
        const set = new Set(current);
        for (const id of ids) {
          if (set.has(id)) set.delete(id);
          else set.add(id);
        }
        return [...set];
      });
    },
    []
  );

  // The page on screen can go away underneath the editor — a deleted page, an
  // undone one, or a switch to a page whose transaction was then refused.
  // Falling back to the first page keeps the canvas showing a real page rather
  // than an empty one it cannot explain.
  React.useEffect(() => {
    if (!document) return;
    setPageId((current) => (document.pages.some((p) => p.id === current) ? current : document.pages[0].id));
  }, [document, pageId]);

  // A node that has just been deleted must not stay selected — the inspector
  // would keep offering to edit something that is gone.
  React.useEffect(() => {
    if (!document) return;
    setSelection((current) => {
      const alive = current.filter((id) => !!document.nodes[id]);
      return alive.length === current.length ? current : alive;
    });
  }, [document]);

  const selectionSubtree = React.useMemo(() => {
    if (!document) return [];
    return [...new Set(selection.flatMap((id) => subtreeIds(document, id)))];
  }, [document, selection]);

  return {
    document,
    visibleDocument,
    loadError,
    pageId,
    setPageId,
    selection,
    selectionSubtree,
    selectNodes,
    apply,
    undo,
    redo,
    canUndo: undoStack.length > 0 && !opts.readOnly,
    canRedo: redoStack.length > 0 && !opts.readOnly,
    history: undoStack,
    pending,
    proposeTransaction,
    acceptPending,
    rejectPending,
    saving,
  };
}

export type DesignEditorState = ReturnType<typeof useDesignDocument>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Raster formats an image layer may be made from.
 *
 * SVG is left out on purpose. An `image/svg+xml` asset is a document, not a
 * picture: it would be inlined into every export and rendered by whatever
 * opened them, which is a much larger surface than "the user picked a photo".
 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * How large a picture may be before it stops fitting in a design.
 *
 * Assets are inlined as data URLs — the schema takes nothing else, so that an
 * offline Mac and a shared link render the same document — and the whole
 * document shares a 200 000-character budget in the store. Two thirds of it is
 * as much as one picture may claim; a file over this limit is refused here,
 * where the size can be named, rather than by a save that fails later.
 */
export const MAX_IMAGE_BYTES = 96 * 1024;

/** Read a picked file into an asset ready to put in a transaction. Rejects with
 *  a message written for the person who chose the file. */
export async function readImageAsset(file: File): Promise<AssetRef> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error("Images must be PNG, JPEG, GIF or WebP.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`“${file.name}” is ${Math.round(file.size / 1024)} KB. Images have to stay under ${Math.round(MAX_IMAGE_BYTES / 1024)} KB.`);
  }

  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read “${file.name}”.`));
    reader.readAsDataURL(file);
  });
  if (!url.startsWith("data:image/")) throw new Error(`Could not read “${file.name}” as an image.`);

  // Intrinsic size, so the layer the caller creates has the picture's own
  // proportions instead of a square guess.
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error(`“${file.name}” is not an image this browser can read.`));
    image.src = url;
  });

  return { id: nextAssetId(), kind: "image", url, width: size.width, height: size.height, mimeType: file.type };
}
