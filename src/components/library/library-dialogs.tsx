"use client";

import * as React from "react";
import { toast } from "sonner";
import { History } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LibraryItem, LibraryVersion } from "@/components/library/library-types";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { formatBytes } from "@/lib/utils";

/**
 * Rename, as a small dialog.
 *
 * The field arrives with the name selected up to its extension, so typing
 * replaces "Q3 report" and keeps ".pdf": the same thing Finder does, and the
 * reason nobody renames a file into one with no extension by accident.
 */
export function RenameFileDialog({
  item,
  onOpenChange,
  onRename,
}: {
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the new name was saved. */
  onRename: (item: LibraryItem, name: string) => Promise<boolean>;
}) {
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (item) setValue(item.fileName);
  }, [item]);

  const submit = async () => {
    if (!item || saving) return;
    const name = value.trim();
    if (!name || name === item.fileName) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(item, name);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={!!item} onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          const dot = input.value.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="space-y-5"
        >
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="File name"
            translate="no"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!value.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every stored version of one file, newest first, with Restore on each older one.
 *
 * Restoring keeps the version it replaces (the route snapshots it first), so
 * the dialog can say so and the button does not need a confirmation.
 */
export function FileVersionsDialog({
  item,
  onOpenChange,
  onRestored,
}: {
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = React.useState<LibraryVersion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [restoring, setRestoring] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setLoading(true);
    setVersions([]);
    fetch(`/api/attachments/${item.id}/versions`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as { versions?: LibraryVersion[] };
      })
      .then((data) => {
        if (!cancelled) setVersions(data.versions ?? []);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn’t load this file’s versions.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const restore = async (version: LibraryVersion) => {
    if (!item || version.current) return;
    setRestoring(version.version);
    try {
      const response = await fetch(`/api/attachments/${item.id}/versions/${version.version}/restore`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "");
      toast.success("Version restored");
      onOpenChange(false);
      onRestored();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Couldn’t restore that version.");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>Restoring an earlier version keeps the current one.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-72 overflow-y-auto px-1">
          {loading ? (
            <div className="divide-y divide-border" role="status" aria-label="Loading versions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 py-3 [animation-fill-mode:backwards] motion-safe:animate-rise-in" style={staggerDelay(i, "tight")}>
                  <span className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="block h-3 w-24 rounded-xs" />
                    <Skeleton className="block h-2.5 w-40 rounded-xs" />
                  </span>
                </div>
              ))}
            </div>
          ) : versions.length === 0 ? (
            <EmptyState
              size="panel"
              icon={History}
              title="No earlier versions"
              description="When this file is replaced, the earlier version is kept here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {versions.map((version) => (
                <li key={version.version} className="flex min-h-14 items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2 text-ui font-medium text-foreground">
                      <span className="tabular-nums">v{version.version}</span>
                      {version.current && <span className="text-caption font-normal text-muted-foreground">Current</span>}
                    </p>
                    <p className="mt-0.5 truncate text-caption tabular-nums text-muted-foreground">
                      <span translate="no">{version.fileName}</span> · {formatBytes(version.size)} · {timeAgo(version.createdAt)}
                    </p>
                  </div>
                  {!version.current && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void restore(version)}
                      loading={restoring === version.version}
                      disabled={restoring !== null && restoring !== version.version}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
