"use client";

import * as React from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Cloud, Loader2, Search } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ContextTokenMark } from "@/components/chat/context-token-mark";
import { fileIconKey, fileSubtitle } from "@/lib/mentions/types";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  CLOUD_FILE_SOURCE_LABEL,
  type CloudFileAttachResponse,
  type CloudFileListResponse,
  type CloudFileProvider,
  type CloudFileSummary,
} from "@/lib/cloud-files/shared";
import type { ClientAttachment } from "@/types/chat";

interface CloudFilePickerProps {
  provider: CloudFileProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with stored, ready-to-send attachments. */
  onAttach: (attachments: ClientAttachment[]) => void;
  /** Attachments already staged in the composer: they count against the per-message cap. */
  existingCount?: number;
  /** The chat the files are for, filed the way an upload would be. */
  conversationId?: string | null;
}

/** Codes after which "Try again" cannot help: the connection itself needs the person. */
const CONNECTION_CODES = new Set(["connector_not_connected", "connector_reconnect", "connector_blocked"]);

type LoadError = { message: string; code: string | null };

const keyOf = (file: Pick<CloudFileSummary, "id" | "driveId">) => `${file.driveId ?? ""}:${file.id}`;

/** "Spreadsheet · 2.4 MB · Oct 12, 2026": what the row is, how big, how recent. */
function rowDetail(file: CloudFileSummary): string {
  const parts = [fileSubtitle(fileIconKey(file.attachMime, file.attachName)) ?? "File"];
  if (file.size !== null) parts.push(formatBytes(file.size));
  if (file.modifiedAt) {
    const date = new Date(file.modifiedAt);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString(undefined, { dateStyle: "medium" }));
  }
  return parts.join(" · ");
}

/**
 * "Add from Google Drive" / "Add from OneDrive": the person's recent files, or
 * a search, with several picked at once. Picked files are fetched and stored
 * server-side (POST /api/connectors/[id]/files/attach), through the same gate
 * and quota as an upload, and come back as ordinary attachments — the
 * composer cannot tell them from a file dropped on it. The Library picker's
 * dialog, with a list in place of the grid because a drive's files are names
 * and dates, not thumbnails.
 *
 * The state lives in the dialog's content, which unmounts once the dialog has
 * closed: every opening starts from the drive's recent files with nothing
 * picked, and the closing dialog keeps what it showed until it is gone.
 */
export function CloudFilePicker({ open, onOpenChange, ...body }: CloudFilePickerProps) {
  // An import in flight keeps the dialog open: closing it would hide the one
  // place its result is reported.
  const busy = React.useRef(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy.current && onOpenChange(next)}>
      <DialogContent className="max-w-2xl overflow-hidden p-6">
        <CloudFilePickerBody {...body} busy={busy} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CloudFilePickerBody({
  provider,
  onAttach,
  existingCount = 0,
  conversationId = null,
  busy,
  onClose,
}: Omit<CloudFilePickerProps, "open" | "onOpenChange"> & { busy: React.MutableRefObject<boolean>; onClose: () => void }) {
  const label = CLOUD_FILE_SOURCE_LABEL[provider];
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [files, setFiles] = React.useState<CloudFileSummary[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<LoadError | null>(null);
  const [selected, setSelected] = React.useState<Map<string, CloudFileSummary>>(new Map());
  const [attaching, setAttaching] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);

  const load = React.useCallback(
    async (q: string, after: string | null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setError(null);
      if (after) setLoadingMore(true);
      else setFiles(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (after) params.set("cursor", after);
        const response = await fetch(`/api/connectors/${provider}/files?${params}`, { signal: controller.signal });
        const data = (await response.json().catch(() => ({}))) as Partial<CloudFileListResponse> & { error?: string; code?: string };
        if (!response.ok) throw Object.assign(new Error(data.error ?? `Couldn’t load your ${label}.`), { code: data.code ?? null });
        setFiles((prev) => [...(after ? (prev ?? []) : []), ...(data.files ?? [])]);
        setCursor(data.nextCursor ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : `Couldn’t load your ${label}.`;
        const code = (caught as { code?: string | null }).code ?? null;
        // A failed "More files" keeps the page already shown.
        if (after) toast.error(message);
        else {
          setError({ message, code });
          setFiles([]);
        }
      } finally {
        if (request.current === controller) {
          setLoadingMore(false);
          request.current = null;
        }
      }
    },
    [label, provider],
  );

  // A search waits for a pause in typing, then replaces the list; clearing
  // the field goes straight back to recent files.
  React.useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => setSearch(trimmed), trimmed ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    void load(search, null);
  }, [search, load]);

  // Nothing is left listening once the dialog has gone.
  React.useEffect(() => () => request.current?.abort(), []);

  React.useEffect(() => {
    busy.current = attaching;
  }, [attaching, busy]);

  const loading = files === null;
  const searching = search.length > 0;
  const remaining = Math.max(0, MAX_ATTACHMENTS - existingCount);

  const toggle = (file: CloudFileSummary, next: boolean) => {
    const key = keyOf(file);
    if (next && !selected.has(key) && selected.size >= remaining) {
      toast.error(
        remaining === 0
          ? `You’ve reached the ${MAX_ATTACHMENTS}-file limit for this message.`
          : `You can attach ${remaining} more ${remaining === 1 ? "file" : "files"} to this message.`,
      );
      return;
    }
    setSelected((prev) => {
      const updated = new Map(prev);
      if (next) updated.set(key, file);
      else updated.delete(key);
      return updated;
    });
  };

  const attach = async () => {
    if (selected.size === 0) return;
    setAttaching(true);
    busy.current = true;
    try {
      const response = await fetch(`/api/connectors/${provider}/files/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Selections survive a new search, so picks from several searches go together.
          files: [...selected.values()].map((file) => ({ id: file.id, driveId: file.driveId })),
          conversationId,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<CloudFileAttachResponse> & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Couldn’t add those files from ${label}.`);
      const attachments = data.attachments ?? [];
      const failed = data.failed ?? [];
      if (attachments.length > 0) onAttach(attachments);
      if (failed.length > 0) {
        toast.error(failed.length === 1 ? failed[0].error : `${failed.length} files weren’t added. ${failed[0].error}`);
      }
      busy.current = false;
      onClose();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : `Couldn’t add those files from ${label}.`);
    } finally {
      busy.current = false;
      setAttaching(false);
    }
  };

  return (
    <>
      <DialogHeader className="gap-2">
        <div className="flex items-center gap-3">
          {/* The Library picker's quiet tile: the accent is for Attach. */}
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground">
            <Cloud aria-hidden="true" className="size-4" />
          </div>
          <div>
            <DialogTitle className="font-sans text-title font-normal tracking-tight text-foreground">{`Add from ${label}`}</DialogTitle>
            <DialogDescription className="text-caption text-muted-foreground">
              {provider === "google-drive"
                ? `${PRODUCT_NAME} attaches a copy of each file you pick. Docs, Sheets and Slides arrive as .docx, .xlsx and .pptx.`
                : `${PRODUCT_NAME} attaches a copy of each file you pick, so later edits in ${label} don’t change it.`}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <label className="relative block">
        <span className="sr-only">{`Search ${label}`}</span>
        <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-muted-foreground">
          {loading && searching ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Search aria-hidden="true" className="size-4" />}
        </span>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${label}`}
          autoComplete="off"
          maxLength={200}
          aria-busy={loading}
          className="pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
      </label>

      <div className="max-h-[50vh] min-h-[16rem] overflow-y-auto overscroll-contain pr-1">
        {error ? (
          <EmptyState
            tone="error"
            size="panel"
            icon={StatusIcons.error}
            title={`Couldn’t load your ${label}`}
            description={error.message}
            action={
              error.code && CONNECTION_CODES.has(error.code) ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/connections">Open Apps</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void load(search, null)}>
                  Try again
                </Button>
              )
            }
          />
        ) : loading ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">{`Loading your ${label}…`}</span>
            {[...Array(6)].map((_, index) => (
              <div key={index} aria-hidden className="skeleton h-12 rounded-field" style={staggerDelay(index)} />
            ))}
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            size="panel"
            title={searching ? "No files match" : "Nothing here yet"}
            description={
              searching
                ? `Nothing in your ${label} matches “${search}”. Try another word from the name or the text.`
                : `Files you open in ${label} show up here first. Search to find anything else.`
            }
          />
        ) : (
          <div role="list" aria-label={searching ? `Results in ${label}` : `Recent in ${label}`} className="divide-y divide-border/70">
            {files.map((file) => (
              <CloudFileRow
                key={keyOf(file)}
                file={file}
                checked={selected.has(keyOf(file))}
                disabled={attaching}
                onCheckedChange={(next) => toggle(file, next)}
              />
            ))}
            {cursor ? (
              <div className="flex justify-center py-3">
                <Button variant="ghost" size="sm" loading={loadingMore} className="text-muted-foreground" onClick={() => void load(search, cursor)}>
                  More files
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button variant="ghost" onClick={onClose} disabled={attaching}>
          Cancel
        </Button>
        <Button onClick={() => void attach()} disabled={selected.size === 0} loading={attaching}>
          {selected.size > 0 ? `Attach ${selected.size} ${selected.size === 1 ? "file" : "files"}` : "Attach"}
        </Button>
      </DialogFooter>
    </>
  );
}

function CloudFileRow({
  file,
  checked,
  disabled,
  onCheckedChange,
}: {
  file: CloudFileSummary;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  const unavailable = file.unavailable !== null;
  return (
    <div
      role="listitem"
      className={cn(
        "flex items-center gap-3 px-1 py-2.5 transition-colors duration-fast ease-out-soft",
        !unavailable && !disabled && "hover:bg-accent/60",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={unavailable || disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-describedby={`${id}-detail`}
      />
      {/* The mention palette's file marks: a sheet is green, a PDF red, by the type it arrives as. */}
      <ContextTokenMark source={{ kind: "file", id: file.id, icon: fileIconKey(file.attachMime, file.attachName) }} size={20} />
      <div className={cn("min-w-0 flex-1", unavailable && "opacity-60")}>
        <label htmlFor={id} className={cn("block truncate text-ui font-medium text-foreground", !unavailable && "cursor-pointer")}>
          {file.name}
        </label>
        <p id={`${id}-detail`} className="truncate text-caption text-muted-foreground">
          {unavailable ? `${rowDetail(file)} · ${file.unavailable}` : rowDetail(file)}
        </p>
      </div>
    </div>
  );
}
