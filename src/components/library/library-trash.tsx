"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibrary } from "./use-library";
import { TypeGlyph } from "./library-items";
import { kindLabel, type LibraryItem } from "./library-types";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { artifactPath } from "@/lib/artifact-links";
import { PRODUCT_NAME } from "@/lib/brand/names";

interface TrashedArtifact { id: string; title: string; deletedAt: string; purgeAt: string }

/*
 * Recently deleted: one list of what can come back, files and made things.
 *
 * WHAT IT PROMISES, AND ONLY THAT. A made thing is purged for good 30 days
 * after it was deleted (src/lib/artifact-trash.ts), so its row says the date.
 * Uploaded files have no purge, so their rows say when they were deleted and
 * nothing about an end; the lede used to tell everyone "each one is removed
 * for good after its date", which was false for every file on the page.
 *
 * Loading draws the rows it stands in for (spec 6.8), and an empty list is
 * the house EmptyState with the way back, not a bare sentence.
 */

const ROW = "flex min-h-[60px] items-center justify-between gap-4 py-3 [&+&]:shadow-[0_-1px_0_hsl(var(--border))]";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function TrashRow({ glyph, title, note, action }: { glyph: string; title: string; note: string; action: React.ReactNode }) {
  return (
    <li className={ROW}>
      <div className="flex min-w-0 items-start gap-3">
        <TypeGlyph type={glyph} className="mt-0.5 size-5" />
        <div className="min-w-0">
          <p className="truncate text-ui text-foreground" title={title} translate="no">{title}</p>
          <p className="mt-0.5 text-caption tabular-nums text-muted-foreground">{note}</p>
        </div>
      </div>
      {action}
    </li>
  );
}

/** The rows' own shape while the first answer is out: glyph, two lines, the Restore button. */
function TrashSkeleton() {
  return (
    // Divs, not a list: a status region's rows are not list items (axe: listitem).
    <div role="status" aria-label="Loading Recently deleted" className="flex flex-col">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className={ROW}>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Skeleton className="mt-0.5 size-5 shrink-0 rounded-xs" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <Skeleton className="h-3.5 w-2/5 rounded-xs" />
              <Skeleton className="h-3 w-1/4 rounded-xs" />
            </div>
          </div>
          <Skeleton className="h-8 w-20 shrink-0 rounded-control coarse:h-10" />
        </div>
      ))}
    </div>
  );
}

function fileNote(item: LibraryItem): string {
  if (item.keptIn === "chat") return "Uploaded file, still in the chat that uses it";
  if (item.keptIn === "project") return "Uploaded file, still in the project that uses it";
  return item.deletedAt ? `Uploaded file. Deleted ${when(item.deletedAt)}` : "Uploaded file";
}

/** Trash is owned by the object; deleting its original chat cannot erase it. */
export function LibraryTrash() {
  const router = useRouter();
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
  const restoreArtifact = async (item: TrashedArtifact) => {
    setBusy(item.id); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      if (!response.ok) throw new Error();
      setArtifacts((current) => current?.filter((entry) => entry.id !== item.id) ?? null);
      // The row leaving says it worked; the toast says where it went and opens it.
      toast.success("Restored to Library", { action: { label: "Open", onClick: () => router.push(artifactPath(item.id)) } });
    } catch { setError("Couldn’t restore this artifact. It remains in Recently deleted; try again."); }
    finally { setBusy(null); }
  };
  const loading = (artifacts === null && !error) || (files.items === null && !files.error);
  const empty = artifacts?.length === 0 && files.items?.length === 0 && !error && !files.error;
  return <AppPage measure="wide"><AppPageHeader heading="Recently deleted" backHref="/library" backLabel="Library" lede={`Bring files and things ${PRODUCT_NAME} made back to your Library. Things ${PRODUCT_NAME} made are removed for good after the date on their row.`} />
    {error || files.error ? <p role="alert" className="mb-6 flex flex-wrap items-center gap-2 text-ui text-muted-foreground">{error || "Couldn’t load deleted files."} <Button variant="secondary" size="sm" onClick={() => { void load(); void files.reload(); }}><ActionIcons.refresh className="size-4" aria-hidden="true" />Try again</Button></p> : null}
    {loading ? <TrashSkeleton /> : empty ? (
      <div className="grid min-h-[min(48vh,28rem)] place-items-center">
        <EmptyState
          icon={StatusIcons.info}
          title="Nothing in Recently deleted"
          description={`When you delete a file or something ${PRODUCT_NAME} made, it waits here so you can bring it back.`}
          action={<Button variant="secondary" size="sm" asChild><Link href="/library">Back to Library</Link></Button>}
        />
      </div>
    ) : (
      <ul className="flex flex-col">
        {artifacts?.map((item) => <TrashRow key={item.id} glyph="Document" title={item.title} note={`Made by ${PRODUCT_NAME}. Removed for good after ${when(item.purgeAt)}`} action={<Button variant="secondary" size="sm" disabled={busy !== null} loading={busy === item.id} onClick={() => void restoreArtifact(item)}>Restore</Button>} />)}
        {files.items?.map((item) => <TrashRow key={`file:${item.id}`} glyph={kindLabel(item)} title={item.fileName} note={fileNote(item)} action={<Button variant="secondary" size="sm" onClick={() => void files.restoreItems([item])}>Restore</Button>} />)}
      </ul>
    )}
    {files.hasMore && !loading ? <Button variant="ghost" size="sm" loading={files.loadingMore} className="mt-6 text-muted-foreground" onClick={() => void files.loadMore()}>More deleted files</Button> : null}
  </AppPage>;
}
