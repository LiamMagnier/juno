"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { MessageAttachments } from "@/components/chat/attachment-tile";
import { QuotedSelection } from "@/components/chat/quoted-selection";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { parseQuotedMessage, serializeQuote, type DocumentQuote } from "@/lib/quote-context";
import type { DocumentAsk } from "@/components/documents/types";
import type { ClientAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

const DocumentViewer = nextDynamic(
  () => import("@/components/documents/document-viewer").then((m) => m.DocumentViewer),
  { ssr: false },
);

/*
 * The attachment routes are owner-scoped and need a session; the samples have
 * neither a row nor an owner. So, in this dev page only, the few requests the
 * tile and the viewer make for a `dev-*` id are answered by the sample route.
 */
if (typeof window !== "undefined" && !(window as unknown as { __junoDocShim?: boolean }).__junoDocShim) {
  (window as unknown as { __junoDocShim?: boolean }).__junoDocShim = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/api\/attachments\/(dev-[a-z]+)\/(preview|document)/.exec(url);
    return match ? original(`/dev/documents/sample/${match[1]}.${match[2]}`, init) : original(input, init);
  };
}

const S = "/dev/documents/sample";
const FILES: ClientAttachment[] = [
  { id: "dev-pdf", kind: "FILE", fileName: "k3_tech_report.pdf", mimeType: "application/pdf", size: 1_742_000, url: `${S}/report.pdf` },
  {
    id: "dev-docx",
    kind: "FILE",
    fileName: "quarterly_review.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 18_400,
    url: `${S}/quarterly_review.docx`,
  },
  {
    id: "dev-pptx",
    kind: "FILE",
    fileName: "launch_plan.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 48_100,
    url: `${S}/launch_plan.pptx`,
  },
  {
    id: "dev-xlsx",
    kind: "FILE",
    fileName: "revenue.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 7_200,
    url: `${S}/revenue.xlsx`,
  },
  { id: "dev-md", kind: "FILE", fileName: "serving_notes.md", mimeType: "text/markdown", size: 640, url: `${S}/notes.md` },
  { id: "dev-csv", kind: "FILE", fileName: "benchmarks.csv", mimeType: "text/csv", size: 260, url: `${S}/data.csv` },
  { id: "dev-ts", kind: "FILE", fileName: "search.ts", mimeType: "text/plain", size: 590, url: `${S}/search.ts` },
  { id: "dev-png", kind: "IMAGE", fileName: "qps_by_region.png", mimeType: "image/png", size: 24_000, url: `${S}/chart.png`, width: 960, height: 600 },
];

export function DocumentsGallery() {
  const [open, setOpen] = React.useState<ClientAttachment | null>(FILES[0]);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [asks, setAsks] = React.useState<Array<{ id: number; message: string; image?: string }>>([]);

  const onAsk = React.useCallback((attachment: ClientAttachment, ask: DocumentAsk) => {
    const quote: DocumentQuote = {
      source: "document",
      attachmentId: attachment.id,
      title: attachment.fileName,
      kind: ask.kind,
      text: ask.text,
      ...(ask.location ? { location: ask.location } : {}),
      ...(ask.kind === "area" ? { region: ask.region } : {}),
      mode: "ask",
    };
    const request = ask.kind === "text" && ask.intent === "explain" ? "Explain this passage in plain terms." : "What does this show?";
    setAsks((prev) => [
      { id: Date.now(), message: serializeQuote(quote, request), image: ask.kind === "area" ? URL.createObjectURL(ask.image) : undefined },
      ...prev,
    ]);
  }, []);

  return (
    <div className="@container/split relative flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
          <header className="space-y-1">
            <h1 className="text-title font-semibold">Document viewer — dev gallery</h1>
            <p className="text-ui text-muted-foreground">
              The real tiles, viewer and quote card, on generated samples. Select text or draw an area in the viewer and press Ask.
            </p>
          </header>

          <section className="flex flex-col items-end">
            <MessageAttachments attachments={FILES} onOpen={(a) => setOpen(a)} />
            <div className={cn(USER_BUBBLE_CLASS, "max-w-[85%]")}>Can you summarise these?</div>
          </section>

          {asks.map((ask) => {
            const parsed = parseQuotedMessage(ask.message);
            return (
              <section key={ask.id} className="flex flex-col items-end gap-2" data-testid="ask">
                {ask.image && (
                  // eslint-disable-next-line @next/next/no-img-element -- a local blob of the crop
                  <img src={ask.image} alt="The cropped area" className="h-36 w-auto rounded-card border border-border/70 bg-white" />
                )}
                <div className="flex max-w-[85%] flex-col items-end">
                  {parsed && <QuotedSelection quote={parsed} standalone={!parsed.request} />}
                  {parsed?.request && <div className={USER_BUBBLE_CLASS}>{parsed.request}</div>}
                </div>
                <details className="w-full rounded-control border border-border/60 bg-card px-3 py-2">
                  <summary className="cursor-pointer font-mono text-caption text-muted-foreground">What the model receives</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-caption">{ask.message}</pre>
                </details>
              </section>
            );
          })}
        </div>
      </div>

      {open && (
        <div className="relative z-40 h-full w-[56%] min-w-[420px] shrink-0 border-l border-border/70 bg-background">
          <DocumentViewer
            attachment={open}
            files={FILES}
            onSelectFile={setOpen}
            onClose={() => setOpen(null)}
            onAsk={onAsk}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
          />
        </div>
      )}
    </div>
  );
}
