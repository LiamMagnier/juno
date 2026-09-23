/**
 * The pdf.js worker, off the main thread.
 *
 * `unpdf/pdfjs` is pdf.js with its worker inlined, which is why the server can
 * use it with no worker file at all. In a browser that inlining runs parsing on
 * the MAIN thread — a 200-page report would then parse fonts and build every
 * page's drawing operators in the same thread that has to keep scrolling. So
 * the same module is loaded here, in a real worker: when it evaluates in a
 * worker scope its WorkerMessageHandler binds itself to `self` (the static
 * initializer at the bottom of pdf.js's worker entry), and the viewer hands
 * this worker to `getDocument` as its port.
 *
 * One engine, not two: this is the pdf.js the repository already ships and
 * tests (see `knowledge/extract/pdf-engine.ts` on why not `pdfjs-dist`).
 */
import { version } from "unpdf/pdfjs";

type WorkerGlobal = { pdfjsWorker?: { WorkerMessageHandler?: unknown }; __junoPdfjsVersion?: string };
const scope = globalThis as unknown as WorkerGlobal;

// Read so the bundler cannot treat the import as unused — unpdf declares
// `sideEffects: false`, and the side effect is the entire point of this file.
scope.__junoPdfjsVersion = version;

// If a build ever strips the handler, say so at once rather than letting the
// viewer wait on a worker that will never answer: it falls back to parsing on
// the main thread, which is slower but correct.
if (!scope.pdfjsWorker?.WorkerMessageHandler) {
  // Typed by hand: the webworker lib cannot be referenced in a program that
  // also carries the DOM lib without the two colliding.
  (self as unknown as { postMessage(message: unknown): void }).postMessage({
    junoPdfWorkerError: "pdf.js worker handler missing",
  });
}
