"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileSearch, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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

function statusClass(state: string): string {
  if (state === "ready") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (state === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (state === "degraded" || state === "stale") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
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

  if (failed) {
    return (
      <main className="mx-auto flex min-h-full max-w-4xl flex-col gap-4 px-5 py-8">
        <Link href="/library" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Library
        </Link>
        <Card className="p-8 text-center">
          <p className="font-serif text-heading">This document could not be read.</p>
          <Button variant="outline" size="sm" onClick={() => void load()} className="mt-4 gap-1.5">
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (loading && document === null) {
    return (
      <main className="mx-auto flex min-h-full max-w-4xl flex-col gap-4 px-5 py-8">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </main>
    );
  }

  if (!document) return null;

  return (
    <main className="mx-auto flex min-h-full max-w-4xl flex-col gap-5 px-5 py-8">
      <Link href="/library" className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Library
      </Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-label text-muted-foreground">Document inspector</p>
            <h1 className="mt-1 truncate font-serif text-title">{document.fileName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              v{document.version} · {document.counts.blocks} passages · {document.counts.chunks} chunks
              {document.pageCount ? ` · ${document.pageCount} pages` : ""}
            </p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase ${statusClass(document.state)}`}>
            {document.state}
          </span>
        </div>
        {document.error ? (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-sm text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>{document.error}</span>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
          <span>{document.parser ?? "unknown parser"} {document.parserVersion ?? ""}</span>
          <span>checksum {document.checksum}</span>
          {document.supersededById ? <span>This version is superseded.</span> : null}
          {document.sourceUrl ? (
            <a href={document.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Download original
            </a>
          ) : null}
        </div>
      </Card>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in this document" className="pl-9" />
        </div>
        <Input value={page} onChange={(event) => setPage(event.target.value.replace(/\D/g, ""))} placeholder="Page" inputMode="numeric" className="w-24" />
        <Button type="submit" variant="outline" disabled={loading}>Inspect</Button>
      </form>

      {blocks === null || blocks.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          <FileSearch className="mx-auto size-6 opacity-50" />
          <p className="mt-3">No citable text matches this filter.</p>
        </Card>
      ) : (
        <ol className="space-y-3">
          {blocks.map((block) => (
            <li key={block.id} id={`block-${block.id}`}>
              <Card className="p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                  <span>{locator(block)} · {block.type}</span>
                  <span className={block.confidence < 1 ? "text-amber-600 dark:text-amber-300" : ""}>
                    {block.confidence < 1 ? `OCR confidence ${Math.round(block.confidence * 100)}%` : "Verified embedded text"}
                  </span>
                </div>
                {block.heading.length > 0 ? <p className="mb-1 font-mono text-[10px] text-muted-foreground">{block.heading.join(" / ")}</p> : null}
                <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">{block.text}</p>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
