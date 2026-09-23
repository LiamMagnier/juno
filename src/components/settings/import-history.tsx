"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { useApp } from "@/components/app/app-provider";
import { SettingRow } from "@/components/settings/setting-row";
import { cn } from "@/lib/utils";

const MAX_BYTES = 100 * 1024 * 1024;

export type ImportPhase =
  | { name: "idle" }
  | { name: "uploading"; progress: number } // 0..1 of bytes on the wire
  | { name: "importing" } // upload finished; the server is unzipping and writing
  | {
      name: "done";
      imported: number;
      skipped: number;
      projectsImported: number;
      memoriesImported: number;
      attachmentsImported: number;
      attachmentsSkipped: number;
      providerLabel: string;
    }
  | { name: "error"; message: string };

const FORMAT_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  juno: "Juno",
};

/**
 * Importing a ChatGPT, Claude, Gemini or Juno export: one settings row, with
 * the upload's progress and its result unfolding under it.
 *
 * It was a card inside the Import history group, with its own "Import"
 * eyebrow, a dashed drop zone titled "Import your history" and a paragraph of
 * instructions, so the same words appeared three times in one group. The row
 * still takes a dropped file (it lights up while one is over it), and the
 * instructions are one disclosure away.
 *
 * XHR rather than fetch so a large archive shows real upload progress before
 * the server's import phase takes over.
 */
export function ImportHistoryRow() {
  const { setConversations } = useApp();
  const [phase, setPhase] = React.useState<ImportPhase>({ name: "idle" });
  const [dragging, setDragging] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const busy = phase.name === "uploading" || phase.name === "importing";

  // The sidebar list lives in the app provider (seeded at bootstrap), so pull
  // a fresh copy after a successful import to make the chats appear at once.
  const refreshSidebar = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
    } catch {
      // Non-fatal: the import succeeded; the list catches up on next load.
    }
  };

  const start = (file: File) => {
    if (busy) return;
    if (!/\.(zip|json)$/i.test(file.name)) {
      setPhase({ name: "error", message: "Choose a .zip or .json export from ChatGPT, Claude, Gemini or Juno." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPhase({ name: "error", message: "The export must be under 100 MB." });
      return;
    }

    setPhase({ name: "uploading", progress: 0 });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPhase({ name: "uploading", progress: e.loaded / e.total });
    };
    xhr.upload.onload = () => setPhase({ name: "importing" });
    xhr.onerror = () => setPhase({ name: "error", message: "The upload failed. Check your connection and try again." });
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as {
        imported?: number;
        skipped?: number;
        projectsImported?: number;
        memoriesImported?: number;
        attachmentsImported?: number;
        attachmentsSkipped?: number;
        format?: string;
        error?: string;
      };
      if (xhr.status >= 200 && xhr.status < 300 && typeof body.imported === "number") {
        const imported = body.imported;
        const providerLabel = FORMAT_LABEL[body.format ?? ""] ?? "the export";
        setPhase({
          name: "done",
          imported,
          skipped: body.skipped ?? 0,
          projectsImported: body.projectsImported ?? 0,
          memoriesImported: body.memoriesImported ?? 0,
          attachmentsImported: body.attachmentsImported ?? 0,
          attachmentsSkipped: body.attachmentsSkipped ?? 0,
          providerLabel,
        });
        if (imported > 0) void refreshSidebar();
        else toast.info("Nothing new to import. Those conversations are already here.");
      } else {
        setPhase({ name: "error", message: body.error ?? "The import failed. Try again." });
      }
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  };

  const pick = () => fileRef.current?.click();

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      // Only when the file leaves the row itself: moving between the row's own
      // children fires dragleave too, and the highlight blinked at each one.
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) start(file);
      }}
      // The row itself is the drop target, so there is no separate zone to
      // aim at. It lights with the hover tone on a layer of its own, reaching
      // past the row's sides, that fades in: only opacity animates. The fill
      // used to be the row's own background, rounded, with a spread shadow for
      // the margin, and the rounding bent the group's hairline above the row
      // at both ends even when nothing was being dragged.
      className={cn(
        "relative isolate before:pointer-events-none before:absolute before:-inset-x-3 before:inset-y-0 before:-z-10 before:rounded-control before:bg-accent before:opacity-0 before:transition-opacity before:duration-fast before:ease-out-soft before:content-['']",
        dragging && "before:opacity-100"
      )}
    >
      <SettingRow
        label="Import chat history"
        description="From ChatGPT, Claude, Gemini or another Juno account. A .zip or .json export up to 100 MB, or drop it here."
        control={
          <Button variant="outline" size="sm" onClick={pick} loading={busy}>
            Choose file
          </Button>
        }
      >
        <ImportProgress phase={phase} onRetry={pick} />
        <ExportHelp />
      </SettingRow>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) start(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** A count in its own node, so the words around it stay whole, translatable strings. */
function Num({ n }: { n: number }) {
  return <span className="tabular-nums">{n.toLocaleString()}</span>;
}

/** Where to get each export. Closed by default: most readers already have the file. */
function ExportHelp() {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-xs text-ui text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:decoration-foreground"
      >
        Where to find your export
      </button>
      <Collapse open={open} innerClassName="pt-2">
        <p className="max-w-prose text-ui text-muted-foreground">
          In ChatGPT, open Settings, Data controls, Export data. In Claude, open Settings, Privacy, Export data. Both
          email you a .zip. Imported messages are encrypted at rest like everything else in Juno.
        </p>
      </Collapse>
    </div>
  );
}

/** The upload's state, under the row, only while there is one to report. */
export function ImportProgress({ phase, onRetry }: { phase: ImportPhase; onRetry: () => void }) {
  return (
    <Collapse open={phase.name !== "idle"} innerClassName="pb-3">
      <div aria-live="polite">
        {phase.name === "uploading" ? (
          <div key="uploading" className="max-w-sm">
            <div className="flex items-baseline justify-between text-ui text-muted-foreground">
              <span>Uploading</span>
              <span className="tabular-nums">{Math.round(phase.progress * 100)}%</span>
            </div>
            {/* The fill travels by scaleX from the left edge, not by width:
                only transform and opacity animate. */}
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(phase.progress * 100)}
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-base ease-out-soft motion-reduce:transition-none"
                style={{ transform: `scaleX(${phase.progress})` }}
              />
            </div>
          </div>
        ) : phase.name === "importing" ? (
          <p key="importing" className="flex items-center gap-2 text-ui text-muted-foreground">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            Rebuilding your chats with their original titles and dates.
          </p>
        ) : phase.name === "done" ? (
          <p key="done" className="flex items-start gap-2 text-ui text-foreground">
            <StatusIcons.success className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
            {phase.imported + phase.projectsImported + phase.memoriesImported + phase.attachmentsImported > 0 ? (
              <span>
                <Num n={phase.imported} /> <span>{phase.imported === 1 ? "conversation" : "conversations"}</span>,{" "}
                <Num n={phase.projectsImported} /> <span>{phase.projectsImported === 1 ? "project" : "projects"}</span>,{" "}
                <Num n={phase.memoriesImported} /> <span>{phase.memoriesImported === 1 ? "memory" : "memories"}</span> and{" "}
                <Num n={phase.attachmentsImported} /> <span>{phase.attachmentsImported === 1 ? "file" : "files"}</span>{" "}
                restored from{" "}
                <span translate="no">{phase.providerLabel}</span>.
                {/* What was left out, as the old card said: without it an
                    export whose files were missing read as a complete import. */}
                {phase.skipped + phase.attachmentsSkipped > 0 && (
                  <>
                    {" "}
                    <Num n={phase.skipped + phase.attachmentsSkipped} />{" "}
                    <span>already here or unavailable.</span>
                  </>
                )}
              </span>
            ) : (
              <span>Everything in that export is already here.</span>
            )}
          </p>
        ) : phase.name === "error" ? (
          <div key="error" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-start gap-2 text-ui text-destructive-ink">
              <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden />
              {phase.message}
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try another file
            </Button>
          </div>
        ) : null}
      </div>
    </Collapse>
  );
}
