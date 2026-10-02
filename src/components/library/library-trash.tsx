"use client";

import * as React from "react";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { useLibrary } from "./use-library";
import { TypeGlyph } from "./library-items";
import { kindLabel } from "./library-types";
import { PRODUCT_NAME } from "@/lib/brand/names";

interface TrashedArtifact { id: string; title: string; deletedAt: string; purgeAt: string }

/** Trash is owned by the object; deleting its original chat cannot erase it. */
export function LibraryTrash() {
  const files = useLibrary({ q: "", kind: "all", sort: "newest", deleted: true });
  const [artifacts, setArtifacts] = React.useState<TrashedArtifact[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/artifacts?deleted=1", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json() as { items: TrashedArtifact[] };
      setArtifacts(data.items);
    } catch { setError("Couldn’t load deleted artifacts. Retry to review them."); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const restoreArtifact = async (id: string) => {
    setBusy(id); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}/restore`, { method: "POST" });
      if (!response.ok) throw new Error();
      setArtifacts((current) => current?.filter((item) => item.id !== id) ?? null);
    } catch { setError("Couldn’t restore this artifact. It remains in Recently deleted; try again."); }
    finally { setBusy(null); }
  };
  const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const row = "flex min-h-[60px] items-center justify-between gap-4 py-3 [&+&]:shadow-[0_-1px_0_hsl(var(--border))]";
  return <AppPage measure="wide"><AppPageHeader heading="Recently deleted" backHref="/library" backLabel="Library" lede="Restore files and things you made to your Library. Each one is removed for good after its date." />
    {error || files.error ? <p role="alert" className="mb-6 flex flex-wrap items-center gap-2 text-ui text-muted-foreground">{error || "Couldn’t load deleted files."} <Button variant="secondary" size="sm" onClick={() => { void load(); void files.reload(); }}>Try again</Button></p> : null}
    {artifacts === null && !error || files.items === null && !files.error ? <p role="status" className="text-ui text-muted-foreground">Loading Recently deleted…</p> : null}
    <ul className="flex flex-col">{artifacts?.map((item) => <li key={item.id} className={row}><div className="flex min-w-0 items-start gap-3"><TypeGlyph type="Document" className="mt-0.5 size-5" /><div className="min-w-0"><p className="truncate text-ui text-foreground">{item.title}</p><p className="mt-0.5 text-caption tabular-nums text-muted-foreground">{`Made by ${PRODUCT_NAME}. Removed for good after ${when(item.purgeAt)}`}</p></div></div><Button variant="secondary" size="sm" disabled={busy !== null} loading={busy === item.id} onClick={() => void restoreArtifact(item.id)}>Restore</Button></li>)}
      {files.items?.map((item) => <li key={`file:${item.id}`} className={row}><div className="flex min-w-0 items-start gap-3"><TypeGlyph type={kindLabel(item)} className="mt-0.5 size-5" /><div className="min-w-0"><p className="truncate text-ui text-foreground">{item.fileName}</p><p className="mt-0.5 text-caption text-muted-foreground">{item.keptIn ? "Uploaded file, still available where it is used" : "Uploaded file"}</p></div></div><Button variant="secondary" size="sm" onClick={() => void files.restoreItems([item])}>Restore</Button></li>)}
    </ul>
    {artifacts?.length === 0 && files.items?.length === 0 && !error && !files.error ? <p className="py-8 text-ui text-muted-foreground">Nothing in Recently deleted.</p> : null}
    {files.hasMore ? <Button variant="ghost" size="sm" disabled={files.loadingMore} className="mt-6 text-muted-foreground" onClick={() => void files.loadMore()}>{files.loadingMore ? "Loading…" : "More deleted files"}</Button> : null}
  </AppPage>;
}
