"use client";

import * as React from "react";
import { splitPipeTable } from "@/lib/documents/viewer-kind";
import type { ReaderBlock, ReaderDocument, ReaderSheet } from "@/lib/documents/reader-types";
import { cn } from "@/lib/utils";
import { ViewerLoading, ViewerMessage } from "./viewer-ui";

/**
 * An office document as a clean page to read — see `lib/documents/reader.ts`
 * for why it is drawn from the document's structure rather than rendered.
 *
 * Each block carries its locator as a data attribute (`data-loc-page`,
 * `-slide`, `-sheet`), which is how a selection made here can tell the model
 * "slide 4" rather than only the words.
 */
export function ReaderView({ attachmentId, fileName, onMeta }: { attachmentId: string; fileName: string; onMeta?: (meta: string | null) => void }) {
  const [state, setState] = React.useState<{ status: "loading" } | { status: "ready"; doc: ReaderDocument } | { status: "error"; message: string }>({
    status: "loading",
  });

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/attachments/${attachmentId}/document`, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 429) throw new Error("Too many documents opened. Try again in a few minutes.");
        if (!res.ok) throw new Error("This document couldn’t be opened.");
        return (await res.json()) as ReaderDocument;
      })
      .then((doc) => setState({ status: "ready", doc }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "This document couldn’t be opened." });
      });
    return () => controller.abort();
  }, [attachmentId]);

  const doc = state.status === "ready" ? state.doc : null;
  React.useEffect(() => {
    if (!onMeta) return;
    if (!doc) return onMeta(null);
    const slides = new Set(doc.blocks.map((b) => b.slide).filter((s): s is number => s != null));
    if (doc.sheets?.length) onMeta(`${doc.sheets.length} ${doc.sheets.length === 1 ? "sheet" : "sheets"}`);
    else if (slides.size) onMeta(`${slides.size} ${slides.size === 1 ? "slide" : "slides"}`);
    else if (doc.pageCount) onMeta(`${doc.pageCount} ${doc.pageCount === 1 ? "page" : "pages"}`);
    else onMeta(null);
  }, [doc, onMeta]);

  if (state.status === "loading") return <ViewerLoading label="Reading the document…" />;
  if (state.status === "error") return <ViewerMessage tone="warning" title={state.message} body="Download it to open it on your device." />;
  if (!doc || (doc.status === "empty" && !doc.sheets?.length)) {
    return (
      <ViewerMessage
        tone="warning"
        title="There’s no text to show for this file."
        body={doc?.note ?? "It may be images only. Download it to open it on your device."}
      />
    );
  }

  return (
    <div
      tabIndex={0}
      role="document"
      aria-label={fileName}
      data-document-scroller
      className="min-h-0 flex-1 overflow-auto overscroll-contain bg-secondary outline-none"
    >
      {doc.sheets?.length ? (
        <Workbook sheets={doc.sheets} truncated={doc.truncated} />
      ) : (
        <article className="mx-auto my-5 max-w-3xl rounded-card border border-border/60 bg-card px-6 py-7 shadow-raised sm:px-10 sm:py-9">
          {(doc.note || doc.truncated) && (
            <p className="mb-5 rounded-control border border-border/60 bg-secondary px-3 py-2 text-caption text-muted-foreground" data-find-skip>
              {doc.truncated ? "Showing the first part of this document. Download it for the rest." : doc.note}
            </p>
          )}
          <Blocks blocks={doc.blocks} />
        </article>
      )}
    </div>
  );
}

/** Group consecutive blocks by slide, so a deck reads as slides. */
function groupBySlide(blocks: ReaderBlock[]): Array<{ slide: number | null; blocks: ReaderBlock[] }> {
  const groups: Array<{ slide: number | null; blocks: ReaderBlock[] }> = [];
  for (const block of blocks) {
    const slide = block.slide ?? null;
    const last = groups[groups.length - 1];
    if (last && last.slide === slide) last.blocks.push(block);
    else groups.push({ slide, blocks: [block] });
  }
  return groups;
}

function Blocks({ blocks }: { blocks: ReaderBlock[] }) {
  const isDeck = blocks.some((b) => b.slide != null);
  if (isDeck) {
    return (
      <div className="space-y-6">
        {groupBySlide(blocks).map((group, i) => (
          <section
            key={i}
            data-loc-slide={group.slide ?? undefined}
            aria-label={group.slide ? `Slide ${group.slide}` : undefined}
            className="rounded-field border border-border/60 bg-background px-5 py-4"
          >
            {group.slide != null && (
              <p className="mb-2 font-mono text-caption text-muted-foreground" data-find-skip>
                Slide {group.slide}
              </p>
            )}
            <div className="space-y-2.5">
              {group.blocks.map((block, j) => (
                <Block key={j} block={block} />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  let lastPage: number | undefined;
  return (
    <div className="space-y-3.5">
      {blocks.map((block, i) => {
        // A page marker only where the document itself recorded a break —
        // Word writes one each time it lays the document out (see docx.ts).
        const marker = block.page != null && lastPage != null && block.page !== lastPage;
        lastPage = block.page ?? lastPage;
        return (
          <React.Fragment key={i}>
            {marker && (
              <div className="flex items-center gap-3 pt-3" data-find-skip aria-hidden>
                <span className="h-px flex-1 bg-border/70" />
                <span className="font-mono text-micro text-muted-foreground">Page {block.page}</span>
                <span className="h-px flex-1 bg-border/70" />
              </div>
            )}
            <Block block={block} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Block({ block }: { block: ReaderBlock }) {
  const loc = { "data-loc-page": block.page, "data-loc-slide": block.slide, "data-loc-sheet": block.sheet };
  switch (block.type) {
    case "heading": {
      const level = block.level ?? 1;
      const Tag = (level <= 1 ? "h2" : level === 2 ? "h3" : "h4") as "h2" | "h3" | "h4";
      return (
        <Tag
          {...loc}
          className={cn(
            "text-balance font-semibold text-foreground",
            level <= 1 ? "pt-2 text-title" : level === 2 ? "pt-1.5 text-heading" : "text-body-lg",
          )}
        >
          {block.text}
        </Tag>
      );
    }
    case "slide_title":
      return (
        <h3 {...loc} className="text-heading font-semibold text-foreground">
          {block.text}
        </h3>
      );
    case "list_item":
      return (
        <p {...loc} className="relative whitespace-pre-wrap pl-5 text-body leading-relaxed text-foreground">
          <span aria-hidden className="absolute left-1 top-[0.6em] size-1.5 rounded-full bg-foreground/50" />
          {block.text}
        </p>
      );
    case "table":
      return <BlockTable {...loc} text={block.text} />;
    case "speaker_notes":
      return (
        <aside {...loc} className="rounded-control border border-border/60 bg-secondary px-3 py-2 text-ui leading-relaxed text-muted-foreground">
          <span className="mb-0.5 block font-mono text-micro" data-find-skip>
            Speaker notes
          </span>
          <span className="whitespace-pre-wrap">{block.text}</span>
        </aside>
      );
    case "code":
      return (
        <pre {...loc} className="overflow-x-auto rounded-control bg-secondary px-3 py-2 font-mono text-ui">
          {block.text}
        </pre>
      );
    case "caption":
      return (
        <p {...loc} className="text-caption italic text-muted-foreground">
          {block.text}
        </p>
      );
    default:
      return (
        <p {...loc} className="whitespace-pre-wrap text-body leading-relaxed text-foreground">
          {block.text}
        </p>
      );
  }
}

function BlockTable({ text, ...loc }: { text: string } & Record<string, unknown>) {
  const rows = React.useMemo(() => splitPipeTable(text), [text]);
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length) return null;
  return (
    <div {...loc} className="overflow-x-auto rounded-control border border-border/70">
      <table className="w-full border-collapse text-left text-ui">
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={cn(r === 0 && "bg-secondary font-medium")}>
              {Array.from({ length: width }, (_, c) => (
                <td key={c} className="border-b border-l border-border/60 px-3 py-1.5 align-top first:border-l-0">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Column letters: 0 → A, 25 → Z, 26 → AA. */
function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function Workbook({ sheets, truncated }: { sheets: ReaderSheet[]; truncated: boolean }) {
  const [active, setActive] = React.useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  return (
    <div className="flex min-h-full flex-col">
      {sheets.length > 1 && (
        <div role="tablist" aria-label="Sheets" className="sticky top-0 z-popper flex gap-1 overflow-x-auto border-b border-border/60 bg-card px-3 py-2" data-find-skip>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn(
                "pressable h-7 shrink-0 rounded-control px-2.5 text-caption",
                i === active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="p-4" data-loc-sheet={sheet.name}>
        {sheet.rows.length === 0 ? (
          <p className="text-ui text-muted-foreground">This sheet is empty.</p>
        ) : (
          <div className="overflow-auto rounded-card border border-border/70 bg-card">
            <table className="border-collapse text-left font-mono text-caption">
              <thead className="sticky top-0 bg-secondary" data-find-skip>
                <tr>
                  <th className="w-10 border-b border-border/70 px-2 py-1 text-right font-normal text-muted-foreground" />
                  {Array.from({ length: width }, (_, c) => (
                    <th key={c} className="min-w-16 border-b border-l border-border/70 px-2 py-1 text-center font-normal text-muted-foreground">
                      {columnName(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr key={r}>
                    <td className="border-b border-border/50 bg-secondary px-2 py-1 text-right text-muted-foreground" data-find-skip>
                      {r + 1}
                    </td>
                    {Array.from({ length: width }, (_, c) => (
                      <td key={c} className="max-w-[24rem] whitespace-pre-wrap border-b border-l border-border/50 px-2 py-1 align-top text-foreground">
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {truncated && (
          <p className="pt-3 font-mono text-caption text-muted-foreground" data-find-skip>
            Showing the first part of this workbook. Download it for the rest.
          </p>
        )}
      </div>
    </div>
  );
}
