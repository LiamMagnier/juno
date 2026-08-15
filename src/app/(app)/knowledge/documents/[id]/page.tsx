"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileSearch, Search } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { staggerDelay } from "@/lib/motion";

interface Block {
  id: string;
  ordinal: number;
  type: string;
  text: string;
  page: number | null;
  slide: number | null;
  sheet: string | null;
  cellRange: string | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  heading: string[];
  confidence: number;
}

interface DocumentDetail {
  id: string;
  fileName: string;
  mimeType: string;
  checksum: string;
  state: string;
  parser: string | null;
  parserVersion: string | null;
  version: number;
  supersededById: string | null;
  pageCount: number | null;
  error: string | null;
  createdAt: string;
  indexedAt: string | null;
  sourceUrl: string | null;
  counts: { blocks: number; chunks: number };
}

function locator(block: Block): string {
  if (block.page !== null) return `Page ${block.page}`;
  if (block.slide !== null) return `Slide ${block.slide}`;
  if (block.sheet && block.cellRange) return `${block.sheet}!${block.cellRange}`;
  if (block.path && block.lineStart !== null) {
    return `${block.path}:${block.lineStart}${block.lineEnd && block.lineEnd !== block.lineStart ? `–${block.lineEnd}` : ""}`;
  }
  return `Passage ${block.ordinal + 1}`;
}

// The --success / --warning ramps exist for exactly these two states. This was
// the only badge in the product painted from raw Tailwind palette colours, so it
// was also the only one that would not follow the theme's black rebalance.
function statusClass(state: string): string {
  if (state === "ready") return "border-success/30 bg-success/10 text-success-ink";
  if (state === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (state === "degraded" || state === "stale") return "border-warning/30 bg-warning/10 text-warning-foreground";
  return "border-border bg-muted text-muted-foreground";
}

export default function KnowledgeDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const [document, setDocument] = React.useState<DocumentDetail | null>(null);
  const [blocks, setBlocks] = React.useState<Block[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ limit: "200" });
    if (query.trim()) params.set("q", query.trim());
    if (page.trim()) params.set("page", page.trim());
    try {
      const response = await fetch(`/api/knowledge/documents/${id}?${params}`);
      if (!response.ok) throw new Error();
      const result = await response.json();
      setDocument(result.document);
      setBlocks(result.blocks);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id, page, query]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // This page hand-rolled its shell — a bare max-w-4xl <main> with its own
  // gutter — while library, projects, roadmap, tasks, artifacts and memory all
  // open through app-page-scroll / app-page-content + <AppPageHeader>. Three
  // different widths and two different gutters is what makes moving between two
  // screens in this product feel like moving between two products.
  if (failed) {
    return (
      <div className="app-page-scroll">
        <div className="app-page-content max-w-3xl">
          <Link href="/library" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors duration-fast hover:text-foreground">
            <ArrowLeft className="size-4" /> Library
          </Link>
          <EmptyState
            className="mt-6"
            tone="error"
            icon={StatusIcons.error}
            title="This document could not be read."
            description="The extractor could not open it, or the request did not come back."
            action={
              <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" /> Try again
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (loading && document === null) {
    return (
      <div className="app-page-scroll">
        <div className="app-page-content max-w-3xl">
          {/* One block per surface it stands in for: the header, the metadata
              card, the filter row, then the passage list. */}
          <Skeleton className="h-5 w-24 rounded-control" />
          {/* The literal 60/120/180/240+ ladder is STAGGER.loose spelled out; the
              helper says the same thing in the vocabulary the rest of the product
              uses, and caps the tail the hand-written `240 + i * 60` could not. */}
          <Skeleton className="mt-4 h-16 w-2/3 rounded-control" style={staggerDelay(1, "loose")} />
          <Skeleton className="mt-6 h-24 w-full rounded-card" style={staggerDelay(2, "loose")} />
          <Skeleton className="mt-5 h-10 w-full rounded-field" style={staggerDelay(3, "loose")} />
          <div className="mt-5 space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-card" style={staggerDelay(i, "loose", 240)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!document) return null;

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-3xl">
        <AppPageHeader
          eyebrow="Document inspector"
          heading={<span className="truncate">{document.fileName}</span>}
          lede={`v${document.version} · ${document.counts.blocks} passages · ${document.counts.chunks} chunks${
            document.pageCount ? ` · ${document.pageCount} pages` : ""
          }`}
          backHref="/library"
          backLabel="Back to library"
          actions={
            <span
              className={`rounded-full border px-2.5 py-1 font-mono text-caption uppercase ${statusClass(document.state)}`}
            >
              {document.state}
            </span>
          }
        />

        <Card variant="flat" className="p-5">
          {document.error ? (
            <div className="mb-4 flex items-start gap-2 rounded-field border border-warning/30 bg-warning/10 px-3.5 py-3 text-sm text-muted-foreground">
              <StatusIcons.error className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <span>{document.error}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-caption text-muted-foreground">
            <span>{document.parser ?? "unknown parser"} {document.parserVersion ?? ""}</span>
            <span className="tabular-nums">checksum {document.checksum}</span>
            {document.supersededById ? <span>This version is superseded.</span> : null}
            {document.sourceUrl ? (
              <a
                href={document.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors duration-fast hover:text-foreground"
              >
                Download original
              </a>
            ) : null}
          </div>
        </Card>

        <form
          className="mt-5 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <div className="relative min-w-[12rem] flex-1">
            {/* top-1/2 + -translate-y-1/2, like the other four search-in-input call
                sites. The fixed top-2.5 was optically centred only for the Input's
                current default height. */}
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in this document" className="pl-9" />
          </div>
          <Input value={page} onChange={(event) => setPage(event.target.value.replace(/\D/g, ""))} placeholder="Page" inputMode="numeric" className="w-24 tabular-nums" />
          <Button type="submit" variant="outline" disabled={loading}>Inspect</Button>
        </form>

        {blocks === null || blocks.length === 0 ? (
          <EmptyState
            className="mt-5"
            size="panel"
            icon={FileSearch}
            title="No citable text here"
            description="Nothing in this document matches the current filter."
          />
        ) : (
          <ol className="mt-5 space-y-3">
            {blocks.map((block) => (
              <li key={block.id} id={`block-${block.id}`}>
                <Card className="p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-caption text-muted-foreground">
                    <span>{locator(block)} · {block.type}</span>
                    <span className={block.confidence < 1 ? "tabular-nums text-warning-foreground" : ""}>
                      {block.confidence < 1 ? `OCR confidence ${Math.round(block.confidence * 100)}%` : "Verified embedded text"}
                    </span>
                  </div>
                  {block.heading.length > 0 ? <p className="mb-1 font-mono text-caption text-muted-foreground">{block.heading.join(" / ")}</p> : null}
                  <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">{block.text}</p>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
