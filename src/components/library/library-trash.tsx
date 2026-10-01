"use client";

import * as React from "react";
import Link from "next/link";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { useLibrary } from "./use-library";
import { LibraryNav } from "./library-nav";

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
  return <AppPage measure="wide"><LibraryNav current="all" /><AppPageHeader heading="Recently deleted" lede="Restore files and artifacts to your Library." actions={<Button variant="secondary" size="sm" asChild><Link href="/library">Back to Library</Link></Button>} />
    {error || files.error ? <p role="alert" className="mb-6 text-ui text-destructive">{error || "Couldn’t load deleted files."} <Button variant="ghost" size="sm" onClick={() => { void load(); void files.reload(); }}>Retry</Button></p> : null}
    {artifacts === null && !error || files.items === null && !files.error ? <p role="status" className="text-ui text-muted-foreground">Loading Recently deleted…</p> : null}
    <ul className="divide-y divide-border">{artifacts?.map((item) => <li key={item.id} className="flex items-center justify-between gap-4 py-4"><div><p className="text-ui font-medium">{item.title}</p><p className="mt-1 text-caption text-muted-foreground">Artifact · Eligible for permanent removal after {new Date(item.purgeAt).toLocaleDateString()}</p></div><Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void restoreArtifact(item.id)}>{busy === item.id ? "Restoring…" : "Restore"}</Button></li>)}
      {files.items?.map((item) => <li key={`file:${item.id}`} className="flex items-center justify-between gap-4 py-4"><div><p className="text-ui font-medium">{item.fileName}</p><p className="mt-1 text-caption text-muted-foreground">Uploaded file{item.keptIn ? " · Still available where it is used" : ""}</p></div><Button variant="secondary" size="sm" onClick={() => void files.restoreItems([item])}>Restore</Button></li>)}
    </ul>
    {artifacts?.length === 0 && files.items?.length === 0 && !error && !files.error ? <p className="py-8 text-ui text-muted-foreground">Nothing in Recently deleted.</p> : null}
    {files.hasMore ? <Button variant="ghost" size="sm" disabled={files.loadingMore} className="mt-6" onClick={() => void files.loadMore()}>{files.loadingMore ? "Loading…" : "More deleted files"}</Button> : null}
  </AppPage>;
}
