"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionIcons } from "@/lib/app-icons";
import { ShareDialog } from "@/components/share/share-dialog";

interface VersionEntry { version: number; origin: string | null; createdAt: string }

/** Lifecycle belongs to the artifact's own page, even when its chat is gone. */
export function ArtifactLifecycleActions({ id, title, version, latest }: { id: string; title: string; version: number; latest: number }) {
  const router = useRouter();
  const [publishing, setPublishing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [history, setHistory] = React.useState<VersionEntry[]>([]);
  const [nextBefore, setNextBefore] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<{ older: string; newer: string; olderVersion: number; newerVersion: number } | null>(null);
  const base = `/api/artifacts/${encodeURIComponent(id)}`;
  const json = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { cache: "no-store", ...init });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The action couldn’t finish. Try again.");
    return data;
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "The action couldn’t finish. Try again."); }
    finally { setBusy(false); }
  };
  const loadHistory = async (before?: number) => {
    const data = await json(`${base}/versions?limit=50${before ? `&before=${before}` : ""}`);
    const rows = data.versions as VersionEntry[];
    setHistory((current) => before ? [...current, ...rows] : rows);
    setNextBefore(data.nextBefore as number | null);
  };
  const duplicate = () => run(async () => {
    const data = await json(`${base}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) });
    if (typeof data.url !== "string") throw new Error("The copy was created but its address is missing. Check the Library.");
    router.push(data.url);
  });
  const restore = () => run(async () => {
    const data = await json(`${base}/versions/${version}`);
    const body = data.version as { content: string };
    await json(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: body.content, baseVersion: latest, origin: "restore" }) });
    setRestoring(false); router.push(`/a/${encodeURIComponent(id)}`); router.refresh();
  });
  const remove = () => run(async () => {
    await json(base, { method: "DELETE" });
    setDeleting(false); router.push("/library"); router.refresh();
  });
  const compareVersion = (olderVersion: number) => run(async () => {
    const [old, current] = await Promise.all([json(`${base}/versions/${olderVersion}`), json(`${base}/versions/${latest}`)]);
    setCompare({ older: (old.version as { content: string }).content, newer: (current.version as { content: string }).content, olderVersion, newerVersion: latest });
  });
  return <>
    <DropdownMenu>
      <Tooltip><DropdownMenuTrigger asChild><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${title}`} disabled={busy}><ActionIcons.more className="size-4" /></Button></TooltipTrigger></DropdownMenuTrigger><TooltipContent>Artifact actions</TooltipContent></Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => { setError(null); setPublishing(true); }}>Publish…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { setHistoryOpen(true); void run(() => loadHistory()); }}>Version history…</DropdownMenuItem>
        {version < latest ? <DropdownMenuItem onSelect={() => { setError(null); setRestoring(true); }}>Restore version {version}…</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={() => void duplicate()}>Make a copy</DropdownMenuItem>
        <DropdownMenuItem asChild><a href={`${base}/download?version=${version}`} download>Download this version</a></DropdownMenuItem>
        <DropdownMenuItem asChild><a href={`${base}/download?version=${version}&format=zip&history=1`} download>Download with history</a></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => { setError(null); setDeleting(true); }}>Move to Recently deleted…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {!deleting && !restoring && !historyOpen && error ? <span role="alert" className="text-caption text-destructive">{error}</span> : null}
    <ShareDialog kind="ARTIFACT" artifactId={id} open={publishing} onOpenChange={setPublishing} />
    <Dialog open={deleting || restoring} onOpenChange={(open) => { if (!open && !busy) { setDeleting(false); setRestoring(false); } }}>
      <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{deleting ? `Move “${title}” to Recently deleted?` : `Restore version ${version}?`}</DialogTitle><DialogDescription>{deleting ? "Its public links stop working until you restore it. You can bring it back from the Library." : "This makes a new version from the one you are viewing. The later versions stay in history."}</DialogDescription></DialogHeader>
        {error ? <p role="alert" className="text-ui text-destructive">{error}</p> : null}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => { setDeleting(false); setRestoring(false); }}>Cancel</Button><Button variant={deleting ? "destructive" : "default"} disabled={busy} onClick={() => void (deleting ? remove() : restore())}>{busy ? "Saving…" : deleting ? "Move to Recently deleted" : `Restore version ${version}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Version history</DialogTitle><DialogDescription>Every saved version of “{title}”. Open an older version to restore or publish it.</DialogDescription></DialogHeader>
      {error ? <p role="alert" className="text-ui text-destructive">{error}</p> : null}
      <ul className="max-h-96 overflow-y-auto">{history.map((item) => <li key={item.version} className="flex items-center justify-between gap-3 border-b border-border py-3"><Link href={`/a/${encodeURIComponent(id)}?v=${item.version}`} onClick={() => setHistoryOpen(false)} className="text-ui hover:underline">Version {item.version}{item.version === latest ? " — Current" : ""}<span className="mt-1 block text-caption text-muted-foreground">{item.origin || "Saved"} · {new Date(item.createdAt).toLocaleString()}</span></Link>{item.version < latest ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void compareVersion(item.version)}>Compare</Button> : null}</li>)}</ul>
      {busy ? <p role="status" className="text-caption text-muted-foreground">Loading…</p> : null}
      {nextBefore ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => loadHistory(nextBefore))}>Older versions</Button> : null}
    </DialogContent></Dialog>
    <Dialog open={compare !== null} onOpenChange={(open) => !open && setCompare(null)}><DialogContent className="max-w-5xl"><DialogHeader><DialogTitle>Compare versions</DialogTitle><DialogDescription>Source of version {compare?.olderVersion} and the current version {compare?.newerVersion}. Long sources show their first 20,000 characters.</DialogDescription></DialogHeader><div className="grid max-h-[60vh] gap-4 overflow-auto sm:grid-cols-2">{compare ? [compare.older, compare.newer].map((content, index) => <section key={index}><h3 className="mb-3 text-ui font-medium">Version {index ? compare.newerVersion : compare.olderVersion}</h3><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-caption">{content.slice(0, 20_000)}</pre></section>) : null}</div></DialogContent></Dialog>
  </>;
}
