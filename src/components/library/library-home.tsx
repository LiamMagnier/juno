"use client";

import * as React from "react";
import Link from "next/link";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FileText, LayoutGrid, List, Search, Upload } from "@/components/ui/icons";
import { ArtifactLifecycleActions } from "@/components/artifacts/artifact-lifecycle-actions";
import { FilePreview } from "@/components/chat/file-preview";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import { EmptyState } from "@/components/ui/empty-state";
import { useLibrary } from "./use-library";
import { LibraryNav } from "./library-nav";
import { kindLabel, type LibraryItem } from "./library-types";
import type { LibraryMadeItem } from "@/lib/library-made";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";

type Entry = { key: string; title: string; href: string; type: string; at: string; conversationId: string | null; file?: LibraryItem; made?: LibraryMadeItem };
const TYPES: Record<string, string> = { MARKDOWN: "Document", DOCUMENT: "Document", SPREADSHEET: "Spreadsheet", PRESENTATION: "Presentation", DESIGN: "Design", HTML: "Site", REACT: "Component", CODE: "Code", MERMAID: "Diagram", SVG: "Graphic", PDF: "PDF", REPORT: "Report", SITE: "Site" };

/** Both kinds of owned output and the files the person gave Juno, in one index. */
export function LibraryHome() {
  const [query, setQuery] = React.useState("");
  const [settledQuery, setSettledQuery] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | "made" | "uploaded">("all");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const files = useLibrary({ q: settledQuery, kind: "all", sort: "newest", deleted: false });
  const [made, setMade] = React.useState<LibraryMadeItem[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [madeError, setMadeError] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const generation = React.useRef(0);
  React.useEffect(() => { const timer = window.setTimeout(() => setSettledQuery(query.trim()), 200); return () => window.clearTimeout(timer); }, [query]);
  React.useEffect(() => {
    const controller = new AbortController();
    const token = ++generation.current;
    setMade(null); setCursor(null); setMadeError(false); setLoadingMore(false);
    fetch(`/api/library/made?limit=60&q=${encodeURIComponent(settledQuery)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ items: LibraryMadeItem[]; nextCursor: string | null }>; })
      .then((data) => { if (generation.current === token) { setMade(data.items); setCursor(data.nextCursor); } })
      .catch(() => { if (!controller.signal.aborted && generation.current === token) setMadeError(true); });
    return () => controller.abort();
  }, [settledQuery, reloadKey]);
  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const token = generation.current;
    try {
      await Promise.all([
        filter !== "made" && files.hasMore ? files.loadMore() : Promise.resolve(),
        filter !== "uploaded" && cursor ? (async () => {
          const response = await fetch(`/api/library/made?limit=60&q=${encodeURIComponent(settledQuery)}&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
          if (!response.ok) throw new Error();
          const data = await response.json() as { items: LibraryMadeItem[]; nextCursor: string | null };
          if (token !== generation.current) return;
          setMade((current) => [...new Map([...(current ?? []), ...data.items].map((item) => [`${item.kind}:${item.id}`, item])).values()]);
          setCursor(data.nextCursor);
        })() : Promise.resolve(),
      ]);
    } catch { if (token === generation.current) setMadeError(true); }
    finally { if (token === generation.current) setLoadingMore(false); }
  };
  const entries: Entry[] = [
    ...(filter !== "made" ? (files.items ?? []).map((file) => ({ key: `file:${file.id}`, title: file.fileName, href: file.url, type: kindLabel(file), at: file.createdAt, conversationId: file.conversationId, file })) : []),
    ...(filter !== "uploaded" ? (made ?? []).map((item) => ({ key: `${item.kind}:${item.id}`, title: item.title, href: item.href, type: TYPES[item.type] || item.type.toLowerCase(), at: item.updatedAt, conversationId: item.conversationId, made: item })) : []),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  const pending = filter !== "uploaded" && made === null && !madeError || filter !== "made" && files.items === null && !files.error;
  const error = filter !== "uploaded" && madeError || filter !== "made" && !!files.error;
  const hasMore = filter !== "uploaded" && cursor !== null || filter !== "made" && files.hasMore;
  const thumb = (entry: Entry) => entry.file ? <FilePreview item={entry.file} className="absolute inset-0" badge={false} /> : entry.made?.type === "DESIGN" ? <DesignPoster artifactId={entry.made.id} version={entry.made.version} alt={entry.title} /> : <div className="flex h-full flex-col justify-center gap-3 p-6 text-muted-foreground"><FileText className="size-7" aria-hidden="true" /><p className="line-clamp-3 font-serif text-title leading-tight text-foreground">{entry.title}</p><p className="text-caption">{entry.type}{entry.made ? ` · Version ${entry.made.version}` : ""}</p></div>;
  return <AppPage measure="wide">
    <LibraryNav current="all" />
    <AppPageHeader heading={FEATURE_NAMES.library.label} lede={`What ${PRODUCT_NAME} made and what you gave it, newest first.`} actions={<><Button variant="ghost" size="sm" asChild><Link href="/library?view=trash">Recently deleted</Link></Button><Button variant="secondary" size="sm" asChild><Link href="/library?view=files&upload=1"><Upload className="size-4" />Upload</Link></Button></>} />
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <SegmentedControl value={filter} onChange={setFilter} ariaLabel="Show items" options={[{ value: "all", label: "All" }, { value: "made", label: FEATURE_NAMES.artifacts.label }, { value: "uploaded", label: "Uploaded" }]} />
      <label className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the Library" aria-label="Search the Library" className="pl-9" /></label>
      <SegmentedControl value={view} onChange={setView} ariaLabel="Library layout" options={[{ value: "grid", label: "Grid", icon: <LayoutGrid className="size-4" /> }, { value: "list", label: "List", icon: <List className="size-4" /> }]} />
    </div>
    {error ? <p role="alert" className="mb-6 text-ui text-destructive">Some Library items couldn’t load. <Button variant="ghost" size="sm" onClick={() => { setReloadKey((key) => key + 1); void files.reload(); }}>Retry</Button></p> : null}
    {pending ? <p className="py-8 text-ui text-muted-foreground" role="status">Loading your Library…</p> : null}
    {!pending && !error && entries.length === 0 ? <EmptyState icon={FileText} title={query ? `No matches for “${query.trim()}”` : "Your Library starts here"} description={query ? "Try another name or clear the search." : `Files you upload and documents, designs and deliverables ${PRODUCT_NAME} creates will appear here.`} action={query ? <Button variant="secondary" size="sm" onClick={() => setQuery("")}>Clear search</Button> : <Button variant="secondary" size="sm" asChild><Link href="/chat">Start a chat</Link></Button>} /> : null}
    <ul className={cn(view === "grid" ? "grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3" : "divide-y divide-border")}>
      {entries.map((entry) => <li key={entry.key} className={cn("min-w-0", view === "list" && "flex items-center gap-4 py-4")}>
        {view === "grid" ? <a href={entry.href} className="relative mb-3 block aspect-[4/3] overflow-hidden rounded-xl bg-muted" aria-label={`Open ${entry.title}`}>{thumb(entry)}</a> : <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <div className="min-w-0 flex-1"><a href={entry.href} className="line-clamp-2 text-ui font-medium text-foreground underline-offset-4 hover:underline">{entry.title}</a><p className="mt-1 text-caption text-muted-foreground">{entry.type} · {entry.file ? "Uploaded" : FEATURE_NAMES.artifacts.label} · {timeAgo(entry.at)}</p>
          {entry.conversationId ? <Link href={`/chat/${encodeURIComponent(entry.conversationId)}`} className="mt-1 inline-block text-caption text-muted-foreground underline-offset-4 hover:underline">Open source chat</Link> : null}
          {entry.made?.validated === false ? <p className="mt-2 text-caption text-warning-foreground">This deliverable has not passed validation.</p> : null}
        </div>
        {entry.made?.kind === "artifact" ? <ArtifactLifecycleActions id={entry.made.id} title={entry.title} version={entry.made.version} latest={entry.made.version} /> : entry.file ? <Link href={`/library?view=files&q=${encodeURIComponent(entry.title)}`} className="text-caption text-muted-foreground underline-offset-4 hover:underline">Manage file</Link> : null}
      </li>)}
    </ul>
    {hasMore ? <div className="mt-8 flex justify-center"><Button variant="secondary" size="sm" disabled={loadingMore || pending} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button></div> : null}
  </AppPage>;
}
