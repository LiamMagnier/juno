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
 * first so the canvas never waits on the network, then POSTed. A server refusal
 * rolls the local document back to the server's copy and says so, rather than
 * leaving the user editing a document that no longer exists in that shape.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  applyTransaction,
  DesignOperationError,
  invertTransaction,
  type DesignOperation,
  type DesignTransaction,
  type TransactionResult,
} from "@/lib/design/operations";
import { parseStoredDesignDocument } from "@/lib/design/migrations";
import { subtreeIds } from "@/lib/design/document";
import type { DesignDocument, NodeId, PageId } from "@/lib/design/types";

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

export function useDesignDocument(opts: Options) {
  const [document, setDocument] = React.useState<DesignDocument | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pageId, setPageId] = React.useState<PageId>("");
  const [selection, setSelection] = React.useState<NodeId[]>([]);
  const [undoStack, setUndoStack] = React.useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = React.useState<HistoryEntry[]>([]);
  const [pending, setPending] = React.useState<PendingProposal | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Parse once per content identity. A failure is a state the editor shows, not
  // an exception that blanks the panel.
  React.useEffect(() => {
    try {
      const parsed = parseStoredDesignDocument(opts.initialContent);
      setDocument(parsed);
      setPageId((current) => (parsed.pages.some((p) => p.id === current) ? current : parsed.pages[0].id));
      setLoadError(null);
    } catch (error) {
      setDocument(null);
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

  /** Persist a transaction that has already been applied locally. */
  const persist = React.useCallback(
    async (transaction: DesignTransaction, applied: DesignDocument, origin: "edit" | "restore" = "edit") => {
      setSaving(true);
      try {
        const result = await transport.commit(transaction, origin, applied);
        if (!result.ok) {
          // Roll the canvas back onto whatever the store actually holds, so the
          // editor never keeps drawing a document that was refused.
          if (result.document) {
            setDocument(result.document);
            setUndoStack([]);
            setRedoStack([]);
          }
          toast.error(result.message);
          return false;
        }
        if (result.document) setDocument(result.document);
        if (result.version != null) opts.onCommitted?.(result.version);
        return true;
      } catch {
        toast.error("Could not save that change.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [opts, transport]
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

      // A no-op transaction (selection only) is not history.
      if (result.touchedNodeIds.length > 0) {
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
        if (!("persist" in options) || options.persist !== false) void persist(transaction, result.document);
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
      void persist(transaction, result.document);
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
      void persist(transaction, result.document);
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
      await persist(transaction, result.document);
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
