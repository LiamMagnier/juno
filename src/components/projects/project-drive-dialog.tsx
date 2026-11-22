"use client";

import * as React from "react";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { toast } from "sonner";
import { ChevronRight, Folder, Loader2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextTokenMark } from "@/components/chat/context-token-mark";
import { GoogleDriveMark } from "@/components/projects/google-drive-mark";
import { fileIconKey } from "@/lib/mentions/types";
import { cn, formatBytes } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { DriveBrowseEntry } from "@/lib/projects/drive-source";
import { DriveBrowserControls, useDriveBrowser } from "@/components/drive/drive-browser-controls";
import type { DriveAvailability, ProjectSourceView } from "@/lib/projects/project-sources-shared";

interface Picked {
  id: string;
  name: string;
  kind: "file" | "folder";
}

/** Where the connect flow brings the person back to: this project, with the picker open. */
export function driveConnectHref(projectId: string, hrefFor = (href: string) => href): string {
  return `/api/connectors/google-drive/connect?return=${encodeURIComponent(hrefFor(`/projects/${encodeURIComponent(projectId)}?drive=1`))}`;
}

/**
 * Add a Google Drive file, several files, or whole folders to a project.
 *
 * Three faces, in the order a person meets them:
 *
 *  - Drive is off on this server: one sentence, nothing to press.
 *  - Drive is not connected (or needs reconnecting): what will happen, in
 *    three steps, and one button that starts Google's consent screen and comes
 *    back here with this picker open (`?drive=1`).
 *  - Connected: My Drive and Shared with me, browsed folder by folder, or a
 *    search. A folder is picked whole (its checkbox) or opened (its name or
 *    chevron). Picked items survive opening other folders, so one trip can
 *    pick a folder here and two files there.
 *
 * Adding files the picks as sources (POST /api/projects/[id]/sources); the
 * first sync runs after the response and the panel shows it arriving.
 */
export function ProjectDriveDialog({
  open,
  onOpenChange,
  projectId,
  drive,
  availabilityError,
  onRetryAvailability,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  drive: DriveAvailability | null;
  availabilityError: boolean;
  onRetryAvailability: () => void;
  onAdded: (sources: ProjectSourceView[]) => void;
}) {
  const browser = useDriveBrowser(`/api/projects/${encodeURIComponent(projectId)}/sources/drive`, open && drive?.enabled === true && drive.connected);
  const { entries, error, setError, pageError, loading, loadingMore, cursor, load, search, parent, enter, changeLocation } = browser;
  const hrefFor = useWorkspaceHref();
  const [selected, setSelected] = React.useState<Map<string, Picked>>(new Map());
  const [includeSubfolders, setIncludeSubfolders] = React.useState(true);
  const [adding, setAdding] = React.useState(false);

  const needsConnect = drive !== null && drive.enabled && (!drive.connected || error?.code === "not_connected" || error?.code === "reconnect");
  const reconnect = drive?.connected === true && error?.code === "reconnect";
  const browsing = drive !== null && drive.enabled && !needsConnect && !availabilityError;

  React.useEffect(() => {
    if (open) return;
    changeLocation("folder");
    setSelected(new Map());
    setIncludeSubfolders(true);
    setError(null);
  }, [open, changeLocation, setError]);

  const toggle = (entry: DriveBrowseEntry, next: boolean) =>
    setSelected((current) => {
      const updated = new Map(current);
      if (next && updated.size < 20) updated.set(entry.id, { id: entry.id, name: entry.name, kind: entry.kind });
      else updated.delete(entry.id);
      return updated;
    });

  const picks = [...selected.values()];
  const folderCount = picks.filter((pick) => pick.kind === "folder").length;
  const fileCount = picks.length - folderCount;
  const summary = [folderCount ? `${folderCount} ${folderCount === 1 ? "folder" : "folders"}` : "", fileCount ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : ""]
    .filter(Boolean)
    .join(", ");

  const add = async () => {
    if (!picks.length || adding) return;
    setAdding(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-drive", items: picks.map(({ id, kind }) => ({ id, kind })), includeSubfolders }),
      });
      const data = (await response.json().catch(() => ({}))) as { sources?: ProjectSourceView[]; error?: string; code?: string };
      if (!response.ok) {
        if (data.code === "reconnect" || data.code === "not_connected") setError({ message: data.error ?? "Reconnect Google Drive.", code: data.code });
        else toast.error(data.error ?? "Couldn’t add that from Google Drive.");
        return;
      }
      onAdded(data.sources ?? []);
      onOpenChange(false);
    } catch {
      toast.error("Couldn’t add that from Google Drive. Check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !adding && onOpenChange(next)}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-secondary" aria-hidden="true">
              <GoogleDriveMark className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-ui font-semibold text-foreground">
                {needsConnect ? (reconnect ? "Reconnect Google Drive" : "Connect Google Drive") : "Add from Google Drive"}
              </DialogTitle>
              <DialogDescription className="text-caption text-muted-foreground">
                {browsing
                  ? `Pick files, or a whole folder. ${PRODUCT_NAME} keeps a folder in sync: new and changed files are added, removed ones leave the project.`
                  : drive === null
                    ? "Checking Google Drive…"
                    : !drive.enabled
                      ? "Google Drive isn’t available on this server."
                      : `Read-only access, used only for what you add to a project.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {availabilityError ? (
          <EmptyState
            size="panel"
            title="Couldn’t check Google Drive"
            description="Check your connection and try again."
            action={<Button variant="outline" size="sm" onClick={onRetryAvailability}>Try again</Button>}
          />
        ) : drive === null ? (
          <div className="grid min-h-40 place-items-center" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Checking Google Drive" />
          </div>
        ) : !drive.enabled ? (
          <p className="text-pretty text-ui text-muted-foreground">
            Whoever runs {PRODUCT_NAME} here can turn on Google Drive. Until then, upload the files or add them from your Library.
          </p>
        ) : needsConnect ? (
          <ConnectSteps reconnect={reconnect} accountLabel={drive.accountLabel} message={error?.code ? error.message : null} />
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <DriveBrowserControls browser={browser} />

            <div className="-mx-2 max-h-[46vh] min-h-[16rem] overflow-y-auto overscroll-contain px-2" aria-busy={loading}>
              {error ? (
                <EmptyState
                  tone="error"
                  size="panel"
                  icon={StatusIcons.error}
                  title="Couldn’t open Google Drive"
                  description={error.message}
                  action={
                    <Button variant="outline" size="sm" onClick={() => void load(null)}>
                      Try again
                    </Button>
                  }
                />
              ) : loading ? (
                <div role="status" className="flex flex-col gap-1.5">
                  <span className="sr-only">Loading Google Drive…</span>
                  {[...Array(6)].map((_, index) => (
                    <div key={index} aria-hidden className="skeleton h-11 rounded-inner" style={staggerDelay(index)} />
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <EmptyState
                  size="panel"
                  title={search ? "Nothing matches" : "This folder is empty"}
                  description={search ? `Nothing in your Google Drive is called “${search}”.` : "Open another folder, or search your Drive."}
                />
              ) : (
                <div role="list" aria-label={search ? "Search results" : parent.name} className="space-y-px">
                  {entries.map((entry) => (
                    <DriveRow
                      key={entry.id}
                      entry={entry}
                      checked={selected.has(entry.id)}
                      disabled={adding || (picks.length >= 20 && !selected.has(entry.id))}
                      onCheckedChange={(next) => toggle(entry, next)}
                      onOpen={() => enter(entry)}
                    />
                  ))}
                  {pageError && <p role="alert" className="px-2 py-2 text-ui text-destructive-ink">{pageError}</p>}
                  {cursor && (
                    <div className="flex justify-center py-2">
                      <Button variant="ghost" size="sm" loading={loadingMore} className="text-muted-foreground" onClick={() => void load(cursor)}>
                        Show more
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <div className="min-h-9 sm:mr-auto">
            {browsing && folderCount > 0 && (
              <label className="flex min-h-9 items-center gap-2.5 text-ui text-foreground">
                <Switch checked={includeSubfolders} onCheckedChange={setIncludeSubfolders} aria-label="Include subfolders" />
                Include subfolders
              </label>
            )}
            {browsing && picks.length >= 20 && <p role="status" className="text-caption text-muted-foreground">20 items selected. Add these before selecting more.</p>}
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={adding}>
              {browsing || needsConnect ? "Cancel" : "Close"}
            </Button>
            {needsConnect ? (
              <Button asChild>
                <a href={driveConnectHref(projectId, hrefFor)}>
                  <GoogleDriveMark className="size-4" />
                  {reconnect ? "Reconnect Google Drive" : "Connect Google Drive"}
                </a>
              </Button>
            ) : browsing ? (
              <Button onClick={() => void add()} disabled={picks.length === 0} loading={adding}>
                {summary ? `Add ${summary}` : "Add"}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectSteps({ reconnect, accountLabel, message }: { reconnect: boolean; accountLabel: string | null; message: string | null }) {
  const steps = reconnect
    ? [
        `Google asks you to sign in${accountLabel ? ` as ${accountLabel}` : ""} and allow read-only access again.`,
        "You come straight back here, to this project.",
        "Your Drive sources sync again, with nothing to add twice.",
      ]
    : [
        "Google asks you to sign in and allow read-only access to your Drive.",
        "You come straight back here, to pick a folder or files.",
        `${PRODUCT_NAME} keeps what you add in sync. You can remove it, or disconnect Drive in Apps, at any time.`,
      ];
  return (
    <div className="space-y-4">
      {message && <p className="text-pretty text-ui text-destructive-ink">{message}</p>}
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border text-caption tabular-nums text-muted-foreground" aria-hidden="true">
              {index + 1}
            </span>
            <span className="text-pretty pt-0.5 text-ui text-foreground">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function entryDetail(entry: DriveBrowseEntry): string {
  if (entry.kind === "folder") return "Folder";
  const parts: string[] = [];
  if (entry.size !== null) parts.push(formatBytes(entry.size));
  if (entry.modifiedAt) {
    const date = new Date(entry.modifiedAt);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
  }
  return parts.join(" · ") || "File";
}

function DriveRow({
  entry,
  checked,
  disabled,
  onCheckedChange,
  onOpen,
}: {
  entry: DriveBrowseEntry;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const id = React.useId();
  const unavailable = entry.unavailable !== null;
  const folder = entry.kind === "folder";
  return (
    <div
      role="listitem"
      data-selected={checked ? "" : undefined}
      className={cn("pj-pick flex min-h-11 items-center gap-3 rounded-inner px-2 py-1.5 transition-colors duration-fast ease-out-soft", !unavailable && !disabled && "hover:bg-accent")}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={unavailable || disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-describedby={`${id}-detail`}
        aria-label={folder ? `Add the folder ${entry.name}` : undefined}
      />
      {folder ? (
        <Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ContextTokenMark source={{ kind: "file", id: entry.id, icon: fileIconKey(entry.iconMime, entry.name) }} size={20} />
      )}
      <div className={cn("min-w-0 flex-1", unavailable && "opacity-60")}>
        {folder ? (
          <button type="button" onClick={onOpen} className="block max-w-full truncate rounded-xs text-left text-ui font-medium text-foreground hover:underline">
            {entry.name}
          </button>
        ) : (
          <label htmlFor={id} className={cn("block truncate text-ui font-medium text-foreground", !unavailable && "cursor-pointer")}>
            {entry.name}
          </label>
        )}
        <p id={`${id}-detail`} className="truncate text-caption text-muted-foreground">
          {unavailable ? `${entryDetail(entry)} · ${entry.unavailable}` : entryDetail(entry)}
        </p>
      </div>
      {folder && (
        <Button variant="ghost" size="icon-sm" onClick={onOpen} aria-label={`Open ${entry.name}`} title="Open" className="shrink-0 text-muted-foreground">
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
