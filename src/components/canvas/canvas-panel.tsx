"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Download, Maximize2, Minimize2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Markdown } from "@/components/chat/markdown";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { cn } from "@/lib/utils";
import type { ClientArtifact } from "@/types/chat";

const EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
  CODE: "txt",
};

const PREVIEWABLE = new Set(["HTML", "REACT", "SVG", "MERMAID", "MARKDOWN"]);

export function CanvasPanel({
  artifact,
  onClose,
  onArtifactUpdated,
  fullscreen,
  onToggleFullscreen,
}: {
  artifact: ClientArtifact;
  onClose: () => void;
  onArtifactUpdated: (a: ClientArtifact) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [tab, setTab] = React.useState<"preview" | "code">(PREVIEWABLE.has(artifact.type) ? "preview" : "code");
  const [selectedVersion, setSelectedVersion] = React.useState(artifact.currentVersion);
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Reset when a different artifact (or new version) is shown.
  React.useEffect(() => {
    setSelectedVersion(artifact.currentVersion);
    setEditing(false);
    setTab(PREVIEWABLE.has(artifact.type) ? "preview" : "code");
  }, [artifact.id, artifact.currentVersion, artifact.type]);

  const versionContent =
    artifact.versions.find((v) => v.version === selectedVersion)?.content ?? artifact.content;
  const isLatest = selectedVersion === artifact.currentVersion;

  const copy = async () => {
    await navigator.clipboard.writeText(versionContent).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const ext = artifact.language || EXTENSIONS[artifact.type] || "txt";
    const blob = new Blob([versionContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.identifier}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startEdit = () => {
    setDraft(versionContent);
    setEditing(true);
    setTab("code");
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      onArtifactUpdated(data.artifact);
      setEditing(false);
      toast.success("Saved as a new version");
    } catch {
      toast.error("Could not save the artifact.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("flex h-full flex-col bg-background", fullscreen && "fixed inset-0 z-50")}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{artifact.title}</h2>
            <Badge variant="muted" className="shrink-0">{artifact.type.toLowerCase()}</Badge>
          </div>
        </div>

        {artifact.versions.length > 1 && (
          <Select value={String(selectedVersion)} onValueChange={(v) => setSelectedVersion(Number(v))}>
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...artifact.versions].reverse().map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  Version {v.version}
                  {v.version === artifact.currentVersion ? " (latest)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={download} aria-label="Download">
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
          {isLatest && !editing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={startEdit} aria-label="Edit">
                  <Pencil className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggleFullscreen} aria-label="Fullscreen">
                {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close canvas">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "code")} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-3 py-2">
          <TabsList>
            <TabsTrigger value="preview" disabled={!PREVIEWABLE.has(artifact.type)}>Preview</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="preview" className="min-h-0 flex-1 overflow-hidden">
          {artifact.type === "MARKDOWN" ? (
            <div className="h-full overflow-auto p-6">
              <Markdown content={versionContent} />
            </div>
          ) : (
            <SandboxFrame type={artifact.type} content={versionContent} />
          )}
        </TabsContent>

        <TabsContent value="code" className="min-h-0 flex-1 overflow-hidden">
          {editing ? (
            <div className="flex h-full flex-col">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="flex-1 resize-none bg-muted/40 p-4 font-mono text-xs outline-none"
              />
              <div className="flex justify-end gap-2 border-t p-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveEdit} disabled={saving}>
                  {saving ? "Saving…" : "Save version"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <Markdown content={`\`\`\`${artifact.language ?? ""}\n${versionContent}\n\`\`\``} className="p-4" />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
