"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckCircle2, FileUp, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

const MAX_BYTES = 100 * 1024 * 1024;

type Phase =
  | { name: "idle" }
  | { name: "uploading"; progress: number } // 0..1 of bytes on the wire
  | { name: "importing" } // upload finished; server is unzipping + writing
  | { name: "done"; imported: number; skipped: number; providerLabel: string }
  | { name: "error"; message: string };

/**
 * "Import your history" card for the profile page: drop (or pick) a ChatGPT
 * or Claude export ZIP and POST it to /api/import. Uses XHR instead of fetch
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
    if (!/\.zip$/i.test(file.name)) {
      setPhase({ name: "error", message: "That's not a .zip — upload the export archive exactly as ChatGPT or Claude gave it to you." });
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
      const body = (xhr.response ?? {}) as { imported?: number; skipped?: number; format?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && typeof body.imported === "number") {
        const imported = body.imported;
        const providerLabel = body.format === "chatgpt" ? "ChatGPT" : body.format === "claude" ? "Claude" : "the export";
        setPhase({ name: "done", imported, skipped: body.skipped ?? 0, providerLabel });
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
    <Card className="p-5 rounded-[28px]">
      <CardEyebrow className="mb-4">Import</CardEyebrow>

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
          "rounded-2xl border border-dashed border-border/60 bg-muted/10 px-5 py-8 text-center transition-colors duration-fast ease-out-soft",
          dragging && "border-primary/60 bg-primary/5"
        )}
      >
        {phase.name === "uploading" ? (
          <div className="mx-auto max-w-xs">
            <p className="font-serif text-heading">Uploading your export</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
            </div>
            <p className="mt-2 font-mono text-caption text-muted-foreground">{Math.round(phase.progress * 100)}%</p>
          </div>
        ) : phase.name === "importing" ? (
          <div className="mx-auto max-w-sm">
            <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-muted-foreground/60" />
            <p className="font-serif text-heading">Importing conversations</p>
            <p className="pt-1 text-sm text-muted-foreground">Rebuilding your chats with their original titles and dates.</p>
          </div>
        ) : phase.name === "done" ? (
          <div className="mx-auto max-w-sm">
            <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-primary" />
            <p className="font-serif text-heading">
              {phase.imported > 0
                ? `Imported ${phase.imported.toLocaleString()} conversation${phase.imported === 1 ? "" : "s"}`
                : "Nothing new to import"}
            </p>
            <p className="pt-1 text-sm text-muted-foreground">
              {phase.imported > 0
                ? `They're in your sidebar with their original dates${phase.skipped > 0 ? ` — ${phase.skipped.toLocaleString()} already here or empty, skipped` : ""}.`
                : "Every conversation in that export already exists here."}
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={pick}>
              Import another
            </Button>
          </div>
        ) : phase.name === "error" ? (
          <div className="mx-auto max-w-sm">
            <TriangleAlert className="mx-auto mb-2 h-6 w-6 text-destructive" />
            <p className="font-serif text-heading">Couldn&apos;t import that file</p>
            <p className="pt-1 text-sm text-muted-foreground">{phase.message}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={pick}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="mx-auto max-w-sm">
            <FileUp className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
            <p className="font-serif text-heading">Import your history</p>
            <p className="pt-1 text-sm text-muted-foreground">
              ChatGPT or Claude export (.zip) — drop it here, up to 100 MB.
            </p>
            <Button size="sm" className="mt-4" onClick={pick}>
              Choose file
            </Button>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Get the ZIP from ChatGPT under Settings → Data controls → Export data, or from Claude under Settings → Privacy →
        Export data. Imported messages are encrypted at rest like everything else.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
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
