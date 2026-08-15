"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileUp, Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

const MAX_BYTES = 100 * 1024 * 1024;

type Phase =
  | { name: "idle" }
  | { name: "uploading"; progress: number } // 0..1 of bytes on the wire
  | { name: "importing" } // upload finished; server is unzipping + writing
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

/**
 * "Import your history" card for the profile page: drop (or pick) a ChatGPT,
 * Claude, Gemini, or Juno export ZIP/JSON and POST it to /api/import. Uses XHR instead of fetch
 * so the upload of a large archive shows real progress before the server-side
 * importing phase takes over.
 */
export function ImportHistoryCard() {
  const { setConversations } = useApp();
  const [phase, setPhase] = React.useState<Phase>({ name: "idle" });
  const [dragging, setDragging] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const busy = phase.name === "uploading" || phase.name === "importing";

  // The sidebar list lives in the app provider (seeded at bootstrap), so pull
  // a fresh copy after a successful import to make the chats appear right away.
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
      setPhase({ name: "error", message: "Choose a .zip or .json export from ChatGPT, Claude, Gemini, or Juno." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPhase({ name: "error", message: "Export must be under 100 MB." });
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
    xhr.onerror = () => setPhase({ name: "error", message: "Upload failed — check your connection and try again." });
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
        const providerLabel =
          body.format === "chatgpt"
            ? "ChatGPT"
            : body.format === "claude"
              ? "Claude"
              : body.format === "gemini"
                ? "Gemini"
                : body.format === "juno"
                  ? "Juno"
                  : "the export";
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
        if (imported > 0) {
          toast.success(`Imported ${imported} conversation${imported === 1 ? "" : "s"} from ${providerLabel}.`);
          void refreshSidebar();
        } else {
          toast.info("Nothing new to import — those conversations are already here.");
        }
      } else {
        setPhase({ name: "error", message: body.error ?? "Import failed — try again." });
      }
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  };

  const pick = () => fileRef.current?.click();

  return (
    <Card className="rounded-surface p-5">
      <CardEyebrow className="mb-4">Import</CardEyebrow>

      {phase.name === "error" ? (
        // A failure must not wear the drop zone's chrome. Rendering it inside the
        // dashed, bg-muted/10 placeholder fenced "couldn't import that file" in
        // the border that means "nothing here yet" — the two states differed only
        // by an icon colour, which is exactly the collapse EmptyState's tones
        // exist to prevent.
        <EmptyState
          tone="error"
          size="panel"
          icon={StatusIcons.error}
          title="Couldn't import that file"
          description={phase.message}
          action={
            <Button variant="outline" size="sm" onClick={pick}>
              Try again
            </Button>
          }
        />
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) start(file);
          }}
          className={cn(
            // `bg-muted/10` composited to ~1% lightness over pure black — the
            // drop zone had no ground at all and the dashed edge was carrying
            // the whole affordance. One real rung instead — and the rung
            // undiluted: at /60 over the 6.5% Card that holds it, --secondary
            // composited back down to ~8.3%, a 1.8-point step its own parent,
            // which is under the threshold where an edge-free fill reads at all.
            "rounded-card border border-dashed border-border/60 bg-secondary px-5 py-8 text-center transition-colors duration-fast ease-out-soft",
            dragging && "border-primary/60 bg-primary/10"
          )}
        >
          {phase.name === "uploading" ? (
            <div className="mx-auto max-w-xs">
              <p className="font-serif text-heading">Uploading your export</p>
              {/* duration-base ease-out-soft: the visually identical meters on
                  the profile page run on those rungs, and this one was on the
                  browser's 150ms `ease` — two progress bars in the same product
                  moving on different curves. */}
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(phase.progress * 100)}
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
                  style={{ width: `${Math.round(phase.progress * 100)}%` }}
                />
              </div>
              <p className="mt-2 font-mono text-caption tabular-nums text-muted-foreground">
                {Math.round(phase.progress * 100)}%
              </p>
            </div>
          ) : phase.name === "importing" ? (
            <div className="mx-auto max-w-sm">
              <Loader2 className="mx-auto mb-2 size-6 animate-spin text-muted-foreground/70" />
              <p className="font-serif text-heading">Importing conversations</p>
              <p className="pt-1 text-sm text-muted-foreground">Rebuilding your chats with their original titles and dates.</p>
            </div>
          ) : phase.name === "done" ? (
            <div className="mx-auto max-w-sm">
              <StatusIcons.success className="mx-auto mb-2 size-6 text-primary" />
              <p className="font-serif text-heading">
                {phase.imported > 0
                  ? `Imported ${phase.imported.toLocaleString()} conversation${phase.imported === 1 ? "" : "s"}`
                  : "Nothing new to import"}
              </p>
              <p className="pt-1 text-sm text-muted-foreground">
                {phase.imported > 0 || phase.projectsImported > 0 || phase.memoriesImported > 0 || phase.attachmentsImported > 0
                  ? `${phase.imported.toLocaleString()} conversation${phase.imported === 1 ? "" : "s"}, ${phase.projectsImported.toLocaleString()} project${phase.projectsImported === 1 ? "" : "s"}, ${phase.memoriesImported.toLocaleString()} memor${phase.memoriesImported === 1 ? "y" : "ies"}, and ${phase.attachmentsImported.toLocaleString()} file${phase.attachmentsImported === 1 ? "" : "s"} restored.${phase.skipped > 0 || phase.attachmentsSkipped > 0 ? ` ${phase.skipped + phase.attachmentsSkipped} already present or unavailable.` : ""}`
                  : "Everything in that export is already here."}
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={pick}>
                Import another
              </Button>
            </div>
          ) : (
            <div className="mx-auto max-w-sm">
              <FileUp className="mx-auto mb-2 size-6 text-muted-foreground/70" />
              <p className="font-serif text-heading">Import your history</p>
              <p className="pt-1 text-sm text-muted-foreground">
                ChatGPT, Claude, Gemini, or Juno export (.zip or .json) — drop it here, up to 100 MB.
              </p>
              <Button size="sm" className="mt-4" onClick={pick}>
                Choose file
              </Button>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Get the ZIP from ChatGPT under Settings → Data controls → Export data, Claude under Settings → Privacy → Export
        data, or export a Juno JSON from your profile. Imported messages are encrypted at rest like everything else.
      </p>

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
    </Card>
  );
}
