"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { LibraryNavigation } from "@/components/library/library-navigation";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { ContextTokenMark } from "@/components/chat/context-token-mark";
import { DriveBrowserControls, useDriveBrowser } from "@/components/drive/drive-browser-controls";
import { GoogleDriveMark } from "@/components/projects/google-drive-mark";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowUpRight, ChevronRight, Folder } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { CloudFileAttachResponse } from "@/lib/cloud-files/shared";
import { fileIconKey } from "@/lib/mentions/types";
import type { DriveBrowseEntry } from "@/lib/projects/drive-source";
import { driveWebUrl } from "@/lib/projects/project-sources-shared";
import { formatBytes } from "@/lib/utils";

const endpoint = "/api/connectors/google-drive/files";
/**
 * What whoever runs Alevr does to turn this page on. The Drive browser signs
 * in to Google with Alevr's own OAuth client (first-party-connectors), so a
 * Google Drive connection made in Composio does not reach it; saying so here
 * saves the owner from setting it up twice in the wrong place.
 */
export const DRIVE_SETUP_HELP =
  "This page signs in to Google with its own OAuth client, so a Drive connection made in Composio doesn’t turn it on. Whoever runs Alevr sets CONNECTOR_GOOGLE_DRIVE_CLIENT_ID and CONNECTOR_GOOGLE_DRIVE_CLIENT_SECRET on the server and restarts it. You can still upload files directly to Library.";

export function LibraryGoogleDrive({ connectError }: { connectError: string | null }) {
  const hrefFor = useWorkspaceHref();
  const filesHref = hrefFor("/library?view=files");
  const connectHref = `/api/connectors/google-drive/connect?return=${encodeURIComponent(hrefFor("/library?view=drive"))}`;
  const browser = useDriveBrowser(endpoint, true);
  const { entries, error, setError, loading, loadingMore, cursor, pageError, load, search, parent, enter } = browser;
  const [importing, setImporting] = React.useState<string | null>(null);
  const [imported, setImported] = React.useState<Set<string>>(new Set());
  const [failures, setFailures] = React.useState<Record<string, string>>({});
  const pending = React.useRef(false);
  const reconnect = error?.code === "connector_reconnect";
  const needsConnect = reconnect || error?.code === "connector_not_connected";
  const needsSetup = error?.code === "not_configured";
  const unavailable = error?.code === "not_enabled" || error?.code === "not_configured";

  async function importFile(entry: DriveBrowseEntry) {
    if (pending.current || imported.has(entry.id)) return;
    pending.current = true;
    setImporting(entry.id);
    setFailures((previous) => ({ ...previous, [entry.id]: "" }));
    try {
      const response = await fetch(`${endpoint}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ id: entry.id }] }),
      });
      const data = await response.json().catch(() => null) as (Partial<CloudFileAttachResponse> & { error?: string; code?: string }) | null;
      if (!response.ok || !data?.attachments?.length) {
        const message = data?.failed?.[0]?.error ?? data?.error ?? "Couldn’t import this file. Try again.";
        if (data?.code === "connector_reconnect" || data?.code === "connector_not_connected") setError({ message, code: data.code });
        else setFailures((previous) => ({ ...previous, [entry.id]: message }));
        return;
      }
      setImported((previous) => new Set(previous).add(entry.id));
      toast.success("File added to Library.");
    } catch {
      setFailures((previous) => ({ ...previous, [entry.id]: "Couldn’t import this file. Check your connection and try again." }));
    } finally {
      pending.current = false;
      setImporting(null);
    }
  }

  return (
    <AppPage measure="wide">
      <AppPageHeader heading="Google Drive"
        lede="Browse your Drive and import the files you want to use in Alevr."
        actions={imported.size > 0 ? <Button variant="outline" asChild><Link href={filesHref}>View imported files</Link></Button> : undefined}
      />
      <LibraryNavigation active="drive" />
      {connectError && connectError !== "not_configured" && <p role="status" className="mb-4 text-ui text-muted-foreground">{connectError === "denied" ? "Google Drive connection was canceled." : "Google Drive couldn’t connect. Try again."}</p>}
      {needsConnect || unavailable || error?.code === "connector_blocked" ? (
        <EmptyState size="panel" icon={GoogleDriveMark}
          title={needsConnect ? (reconnect ? "Reconnect Google Drive" : "Connect Google Drive") : needsSetup ? "Google Drive needs setup" : "Google Drive unavailable"}
          description={needsConnect && !reconnect ? "Authorize read-only access to open your folders and import selected files." : needsSetup ? DRIVE_SETUP_HELP : error?.message}
          action={needsConnect ? <Button asChild><a href={connectHref}>{reconnect ? "Reconnect Google Drive" : "Connect Google Drive"}</a></Button> : error?.code === "connector_blocked" ? <Button variant="outline" asChild><Link href="/settings?section=connectors">Open Apps settings</Link></Button> : unavailable ? <Button variant="outline" asChild><Link href={filesHref}>Browse Library files</Link></Button> : undefined}
        />
      ) : (
        <div className="space-y-4">
          <DriveBrowserControls browser={browser} />
          {error ? (
            <EmptyState size="panel" title="Couldn’t open Google Drive" description={error.message}
              action={<Button variant="outline" onClick={() => void load()}>Try again</Button>} />
          ) : loading ? (
            <div role="status" className="space-y-2"><span className="sr-only">Loading Google Drive…</span>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-card" />)}</div>
          ) : entries.length === 0 && !cursor ? (
            <EmptyState size="panel" title={search ? "No matching files" : "This folder is empty"} description={search ? "Try another name or open a folder." : undefined} />
          ) : (
            <ul aria-label={search ? "Search results" : parent.name} className="divide-y divide-border rounded-card border border-border">
              {entries.map((entry) => {
                const folder = entry.kind === "folder";
                const url = driveWebUrl({ kind: entry.kind, externalId: entry.id });
                return (
                  <li key={entry.id} className="px-3 py-1.5">
                    {folder ? (
                      <button type="button" onClick={() => enter(entry)} className="flex min-h-11 w-full items-center gap-3 rounded-control px-1 text-start hover:bg-accent">
                        <Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-ui font-medium">{entry.name}</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
                      </button>
                    ) : (
                      <div className="flex min-h-11 items-center gap-2 px-1 sm:gap-3">
                        <ContextTokenMark source={{ kind: "file", id: entry.id, icon: fileIconKey(entry.iconMime, entry.name) }} size={20} />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-ui font-medium" title={entry.name}>{entry.name}</span>
                          <span className="block text-caption text-muted-foreground">{entry.unavailable ?? (entry.size !== null && formatBytes(entry.size))}</span>
                        </div>
                        {!entry.unavailable && <Button type="button" variant="secondary" size="sm" loading={importing === entry.id} disabled={importing !== null || imported.has(entry.id)}
                          aria-label={`Import ${entry.name}`} onClick={() => void importFile(entry)}>{imported.has(entry.id) ? "Imported" : "Import"}</Button>}
                        <Button variant="ghost" size="icon-sm" asChild>
                          <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.name} in Google Drive`} title="Open in Google Drive"><ArrowUpRight className="size-4" aria-hidden="true" /></a>
                        </Button>
                      </div>
                    )}
                    {failures[entry.id] && <p role="alert" className="pb-2 ps-8 text-caption text-destructive-ink">{failures[entry.id]}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {pageError && <p role="alert" className="text-ui text-destructive-ink">{pageError}</p>}
          {cursor && !error && <Button variant="outline" loading={loadingMore} onClick={() => void load(cursor)}>Show more</Button>}
        </div>
      )}
    </AppPage>
  );
}
