"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { parseStoredDesignDocument, serializeDesignDocument } from "@/lib/design/migrations";
import { allocatesCheckpoint, applyTransaction, type DesignOperation, type DesignTransaction } from "@/lib/design/operations";
import { createDesignDocument } from "@/lib/design/schema";
import type { DesignDocument } from "@/lib/design/types";
import type { ClientArtifact } from "@/types/chat";
import { cn } from "@/lib/utils";

// Client-only, as in the documents gallery: the panel's Radix ids are not
// stable between this page's server render and the browser's.
const CanvasPanel = nextDynamic(() => import("@/components/canvas/canvas-panel").then((m) => m.CanvasPanel), { ssr: false });

const ARTIFACT_ID = "dev-design";
const PAGE_ID = "page-1";
const LATENCY_MS = 180;

/** Panel widths worth checking the rails at: the dock's floor, its default,
 *  and two wider drags. */
const WIDTHS = [420, 560, 720, 960] as const;

function build(doc: DesignDocument, operations: DesignOperation[]): DesignDocument {
  const transaction: DesignTransaction = {
    id: `dev-${doc.revision}`,
    baseRevision: doc.revision,
    operations,
    author: "user",
    summary: "Build sample",
    commentId: null,
    createdAt: "2026-09-23T10:00:00.000Z",
  };
  return applyTransaction(doc, transaction).document;
}

/** The kind of screen the chat makes when asked for a sign-in design. */
function sampleDocument(): DesignDocument {
  const doc = createDesignDocument({ id: "dev-sign-in", name: "Sign in", pageId: PAGE_ID, now: "2026-09-23T10:00:00.000Z" });
  return build(doc, [
    { op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "frame", id: "screen", name: "Sign in", patch: { x: 0, y: 0, width: 375, height: 812, clipsContent: true } } },
    {
      op: "createNode",
      parentId: "screen",
      pageId: PAGE_ID,
      node: {
        type: "frame",
        id: "card",
        name: "Card",
        patch: {
          x: 24,
          y: 200,
          width: 327,
          height: 240,
          cornerRadius: 16,
          layout: { direction: "vertical", padding: { top: 24, right: 24, bottom: 24, left: 24 }, gap: 16, align: "start", justify: "start", wrap: false },
          heightMode: "hug",
        },
      },
    },
    { op: "createNode", parentId: "card", pageId: PAGE_ID, node: { type: "text", id: "title", name: "Title", patch: { characters: "Welcome back", width: 279, widthMode: "fill" } } },
    { op: "createNode", parentId: "card", pageId: PAGE_ID, node: { type: "rectangle", id: "email", name: "Email field", patch: { width: 279, height: 44, cornerRadius: 8, widthMode: "fill" } } },
    {
      op: "createNode",
      parentId: "card",
      pageId: PAGE_ID,
      node: {
        type: "frame",
        id: "button",
        name: "Sign in button",
        patch: { width: 279, height: 48, cornerRadius: 8, widthMode: "fill", fills: [{ type: "solid", color: { r: 0.2, g: 0.3, b: 0.9, a: 1 } }] },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// The store, in the page
// ---------------------------------------------------------------------------

type StoreEvent = { at: string; kind: "fold" | "checkpoint" | "refused"; version: number; summary: string };

/**
 * `commitTransaction` without a database: the transaction is validated against
 * the store's own copy, and `allocatesCheckpoint` — the store's real rule, on
 * real ages — decides between folding into the newest version and giving the
 * change a version of its own. The first edit on generated output always gets
 * its own, which is the case this page exists to show.
 */
const store = {
  document: sampleDocument(),
  currentVersion: 1,
  latest: { origin: "generated", createdAt: Date.now() },
  log: [] as StoreEvent[],
  listeners: new Set<() => void>(),
  emit() {
    for (const listener of store.listeners) listener();
  },
};

function commit(transaction: DesignTransaction, origin: "edit" | "restore"): { status: number; body: unknown } {
  let next: DesignDocument;
  try {
    next = applyTransaction(store.document, transaction).document;
  } catch (error) {
    store.log = [{ at: new Date().toISOString(), kind: "refused", version: store.currentVersion, summary: transaction.summary }, ...store.log];
    store.emit();
    return { status: 409, body: { error: error instanceof Error ? error.message : "Refused", document: store.document } };
  }
  const allocates = allocatesCheckpoint({ origin: store.latest.origin, ageMs: Date.now() - store.latest.createdAt }, transaction, origin);
  if (allocates) {
    store.currentVersion += 1;
    store.latest = { origin, createdAt: Date.now() };
  }
  store.document = JSON.parse(JSON.stringify(next)) as DesignDocument;
  store.log = [
    { at: new Date().toISOString(), kind: allocates ? "checkpoint" : "fold", version: store.currentVersion, summary: transaction.summary },
    ...store.log,
  ];
  store.emit();
  return { status: 200, body: { artifact: { currentVersion: store.currentVersion }, document: store.document } };
}

/*
 * The transactions route is owner-scoped and needs a session; this design has
 * neither a row nor an owner. So, in this dev page only, the editor's POSTs for
 * `dev-design` are answered by the store above, after a network-sized pause.
 */
if (typeof window !== "undefined" && !(window as unknown as { __junoDesignShim?: boolean }).__junoDesignShim) {
  (window as unknown as { __junoDesignShim?: boolean }).__junoDesignShim = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/api/design/${ARTIFACT_ID}/transactions`) && init?.method === "POST") {
      const { transaction, origin } = JSON.parse(String(init.body)) as { transaction: DesignTransaction; origin: "edit" | "restore" };
      await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
      const { status, body } = commit(transaction, origin);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }
    return original(input, init);
  };
}

function initialArtifact(): ClientArtifact {
  const content = serializeDesignDocument(store.document);
  const at = new Date(store.latest.createdAt).toISOString();
  return {
    id: ARTIFACT_ID,
    identifier: "sign-in",
    type: "DESIGN",
    title: "Sign in",
    currentVersion: 1,
    content,
    versions: [{ version: 1, content, origin: "generated", createdAt: at }],
    createdAt: at,
    updatedAt: at,
  };
}

function useStoreLog(): StoreEvent[] {
  const [log, setLog] = React.useState(store.log);
  React.useEffect(() => {
    const listener = () => setLog(store.log);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);
  return log;
}

function bodyState(content: string): { ok: boolean; label: string } {
  if (!content) return { ok: false, label: "empty" };
  try {
    const doc = parseStoredDesignDocument(content);
    return { ok: true, label: `rev ${doc.revision} · ${content.length.toLocaleString()} chars` };
  } catch {
    return { ok: false, label: "does not parse" };
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function DesignCanvasGallery() {
  const [artifact, setArtifact] = React.useState<ClientArtifact>(initialArtifact);
  const [width, setWidth] = React.useState<(typeof WIDTHS)[number]>(720);
  const [fullscreen, setFullscreen] = React.useState(false);
  const log = useStoreLog();

  /** A new version from outside the editor — Juno re-emitting the design in
   *  the chat. The editor has to load it, not mistake it for its own. */
  const regenerate = () => {
    const next = build(store.document, [
      { op: "updateNode", nodeId: "title", patch: { characters: `Welcome back (${store.currentVersion + 1})` } },
      { op: "updateNode", nodeId: "button", patch: { fills: [{ type: "solid", color: { r: 0.85, g: 0.35, b: 0.25, a: 1 } }] } },
    ]);
    store.document = next;
    store.currentVersion += 1;
    store.latest = { origin: "generated", createdAt: Date.now() };
    store.log = [{ at: new Date().toISOString(), kind: "checkpoint", version: store.currentVersion, summary: "Regenerated in the chat" }, ...store.log];
    store.emit();
    const content = serializeDesignDocument(next);
    const at = new Date().toISOString();
    setArtifact((current) => ({
      ...current,
      currentVersion: store.currentVersion,
      content,
      versions: [...current.versions, { version: store.currentVersion, content, origin: "generated", createdAt: at }],
      updatedAt: at,
    }));
  };

  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-heading font-semibold">Design in the chat canvas</h1>
        <p className="text-ui text-muted-foreground">
          The real canvas panel on a generated design. The first saved edit makes v2.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Panel width">
        <span className="text-caption text-muted-foreground">Panel width</span>
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={width === w}
            onClick={() => setWidth(w)}
            className={cn(
              "rounded-control border px-2.5 py-1 font-mono text-caption",
              width === w ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
            )}
          >
            {w}px
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-border/60" aria-hidden />
        <button
          type="button"
          onClick={regenerate}
          className="rounded-control border border-border/60 px-2.5 py-1 text-caption text-muted-foreground hover:text-foreground"
        >
          Regenerate from the chat
        </button>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div style={{ width }} className="h-[640px] shrink-0 overflow-hidden rounded-card border border-border/60" data-dev-panel="">
          <CanvasPanel
            artifact={artifact}
            onClose={() => {}}
            onArtifactUpdated={setArtifact}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
          />
        </div>

        <section className="min-w-72 flex-1 space-y-4" aria-label="Envelope and store">
          <div>
            <h2 className="pb-1.5 text-ui font-medium">Envelope · v{artifact.currentVersion}</h2>
            <ul className="space-y-1" data-dev-versions="">
              {artifact.versions.map((v) => {
                const state = bodyState(v.content);
                return (
                  <li key={v.version} className="flex items-baseline gap-2 font-mono text-caption">
                    <span className="w-8">v{v.version}</span>
                    <span className="w-20 text-muted-foreground">{v.origin}</span>
                    <span className={state.ok ? "text-success" : "text-destructive"}>{state.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <h2 className="pb-1.5 text-ui font-medium">Store</h2>
            <ul className="space-y-1" data-dev-store-log="">
              {log.length === 0 && <li className="text-caption text-muted-foreground">No transactions yet.</li>}
              {log.map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex items-baseline gap-2 font-mono text-caption">
                  <span className={cn("w-24", event.kind === "refused" ? "text-destructive" : "text-muted-foreground")}>{event.kind}</span>
                  <span className="w-8">v{event.version}</span>
                  <span className="truncate">{event.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
