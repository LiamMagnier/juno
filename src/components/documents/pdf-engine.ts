"use client";

import type { PDFDocumentProxy, PDFWorker } from "unpdf/pdfjs";

/**
 * Loading pdf.js in the browser, once, and opening documents with it.
 *
 * Everything here is lazy: the 1.6 MB engine is fetched by the first click on
 * a PDF, never by a page load, and a conversation with no PDF in it never
 * downloads a byte of it.
 */

type Pdfjs = typeof import("unpdf/pdfjs");

let pdfjsPromise: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("unpdf/pdfjs").catch((error) => {
    // A failed chunk load (a deploy mid-session, a flaky network) must be
    // retryable by the next open, not cached as permanent.
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}

/* ─── The worker ────────────────────────────────────────────────────────────
 * One per tab, shared by every document opened in it. pdf.js multiplexes
 * documents over one port, and a worker is tens of megabytes of heap once the
 * engine is loaded into it — a second one buys nothing.
 *
 * `null` means "use the main thread": a browser without module workers, a
 * build where the worker chunk failed, a worker that never said it was ready.
 * Decided once, so a broken worker is not retried on every open. */
let workerPromise: Promise<PDFWorker | null> | null = null;

const WORKER_READY_TIMEOUT_MS = 12_000;

function bootWorker(pdfjs: Pdfjs): Promise<PDFWorker | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module", name: "juno-pdf" });
    } catch {
      resolve(null);
      return;
    }
    const cleanup = () => {
      window.clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const fail = () => {
      cleanup();
      worker.terminate();
      resolve(null);
    };
    // pdf.js's worker announces itself with `ready` the moment its handler
    // binds to the port. Anything else first — our own error note, a load
    // error — means it never will.
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { action?: string; junoPdfWorkerError?: string } | null;
      if (data?.junoPdfWorkerError) return fail();
      if (data?.action !== "ready") return;
      cleanup();
      try {
        resolve(new pdfjs.PDFWorker({ port: worker as never }));
      } catch {
        worker.terminate();
        resolve(null);
      }
    };
    const onError = () => fail();
    const timer = window.setTimeout(fail, WORKER_READY_TIMEOUT_MS);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function sharedWorker(pdfjs: Pdfjs): Promise<PDFWorker | null> {
  workerPromise ??= bootWorker(pdfjs);
  return workerPromise;
}

/* ─── Bytes ─────────────────────────────────────────────────────────────── */

/**
 * The file's bytes, with progress.
 *
 * Through `/api/files/…` — same-origin, cookie-authenticated, owner-checked —
 * which is the only address an attachment has (see `getViewUrl`), and the only
 * one the CSP's `connect-src 'self'` would let the viewer fetch anyway.
 */
export async function fetchBytes(
  url: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number | null) => void } = {},
): Promise<Uint8Array> {
  const response = await fetch(url, { signal: options.signal, credentials: "same-origin" });
  if (!response.ok) throw new DocumentLoadError(response.status === 404 ? "missing" : "network");
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !options.onProgress) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    options.onProgress(total ? Math.min(received / total, 1) : null);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class DocumentLoadError extends Error {
  constructor(readonly reason: "missing" | "network" | "password" | "invalid" | "engine") {
    super(reason);
  }
}

/* ─── Documents ─────────────────────────────────────────────────────────────
 * Kept for the tab's life, a few at a time: reopening the report you closed a
 * minute ago should be instant, and the person flicking between two files in
 * one conversation is the common case. Past the cap the least recently opened
 * one is destroyed, which frees its worker-side state. */

const MAX_OPEN_DOCUMENTS = 3;
const openDocuments = new Map<string, Promise<PDFDocumentProxy>>();

function remember(key: string, doc: Promise<PDFDocumentProxy>) {
  openDocuments.delete(key);
  openDocuments.set(key, doc);
  while (openDocuments.size > MAX_OPEN_DOCUMENTS) {
    const oldest = openDocuments.keys().next().value as string;
    const evicted = openDocuments.get(oldest);
    openDocuments.delete(oldest);
    // Destroying the loading task frees the document on the worker too; the
    // shared worker itself stays up, since it was not created for this one.
    void evicted?.then((d) => d.loadingTask.destroy()).catch(() => undefined);
  }
}

async function openWith(pdfjs: Pdfjs, bytes: Uint8Array, worker: PDFWorker | null): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    // A copy: pdf.js TRANSFERS the buffer it is handed to the worker, and the
    // main-thread retry below needs the bytes a second time.
    data: bytes.slice(),
    ...(worker ? { worker } : {}),
    verbosity: 0,
    // Fonts the file does not embed are drawn with the system's — there is no
    // font-data URL to fetch from under this CSP, and a missing standard font
    // is a far smaller loss than a blank page.
    useSystemFonts: true,
  } as Parameters<Pdfjs["getDocument"]>[0]);
  try {
    return await task.promise;
  } catch (error) {
    void task.destroy();
    const name = (error as { name?: string } | null)?.name;
    if (name === "PasswordException") throw new DocumentLoadError("password");
    if (name === "InvalidPDFException") throw new DocumentLoadError("invalid");
    throw error;
  }
}

/* Progress for an open in flight, to whoever is showing it. A listener set
 * rather than a callback argument because the open is SHARED: a second viewer
 * (or React's development double-mount) asking for the same file joins the
 * download already running instead of starting — or aborting — another. */
const progressListeners = new Map<string, Set<(fraction: number | null) => void>>();

export function onOpenProgress(key: string, listener: (fraction: number | null) => void): () => void {
  let set = progressListeners.get(key);
  if (!set) {
    set = new Set();
    progressListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) progressListeners.delete(key);
  };
}

/**
 * Open a PDF: the shared worker if it came up, the main thread if not — and
 * the main thread again if the worker path fails on this particular file, so
 * a worker problem can never be the reason a document does not open.
 *
 * The download belongs to the open, not to the component that asked for it:
 * closing the viewer mid-download does not cancel it, because the cached open
 * is what the next request for this file will be handed. A reopen of a file
 * this tab already has costs no request at all.
 */
export function openPdf(key: string, url: string): Promise<PDFDocumentProxy> {
  const cached = openDocuments.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }
  const opening = (async () => {
    // The file and the engine arrive together: neither needs the other to
    // start, and on a first open the engine is the larger of the two.
    const engine = loadPdfjs().catch(() => {
      throw new DocumentLoadError("engine");
    });
    const [bytes, pdfjs] = await Promise.all([
      fetchBytes(url, { onProgress: (fraction) => progressListeners.get(key)?.forEach((listener) => listener(fraction)) }),
      engine,
    ]);
    const worker = await sharedWorker(pdfjs);
    if (worker) {
      try {
        return await openWith(pdfjs, bytes, worker);
      } catch (error) {
        if (error instanceof DocumentLoadError) throw error;
      }
    }
    return openWith(pdfjs, bytes, null);
  })();
  remember(key, opening);
  // A failure is not worth remembering — the next open should try again.
  opening.catch(() => {
    if (openDocuments.get(key) === opening) openDocuments.delete(key);
  });
  return opening;
}
