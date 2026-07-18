"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Markdown } from "@/components/chat/markdown";
import { CodeSurface } from "@/components/canvas/code-surface";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";

/*
 * Read-only artifact viewer for the public share page. Reuses the canvas
 * sandbox for live HTML/React/SVG/Mermaid previews (opaque-origin iframe, so
 * shared code can't touch the app) plus a Code tab. No editing, no history,
 * no console — the share shows one frozen version.
 */

export function SharedArtifactViewer({
  type,
  language,
  content,
  version,
}: {
  type: ArtifactType;
  language?: string | null;
  content: string;
  version: number;
}) {
  const rt = React.useMemo(() => runtimeFor(type, language), [type, language]);
  const isMarkdown = type === "MARKDOWN";
  // Console runtimes (JS/Python) aren't executed on public pages — code only.
  const hasPreview = isMarkdown || rt.mode === "web";
  const [tab, setTab] = React.useState<"preview" | "code">(hasPreview ? "preview" : "code");

  const panel = "min-h-0 flex-1 overflow-hidden rounded-[20px] border border-border/60 bg-card/40 shadow-soft";

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "code")} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-3">
        <TabsList className="h-8">
          {hasPreview && <TabsTrigger value="preview">Preview</TabsTrigger>}
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {rt.label}
          {version > 1 ? ` · v${version}` : ""}
        </span>
      </div>

      {hasPreview && (
        <TabsContent value="preview" className={panel}>
          {isMarkdown ? (
            <div className="h-full overflow-auto p-6">
              <Markdown content={content} />
            </div>
          ) : (
            <SandboxFrame type={type} content={content} language={language} mode={rt.mode} />
          )}
        </TabsContent>
      )}

      <TabsContent value="code" className={panel}>
        <CodeSurface value={content} language={rt.lang || language} readOnly wrap={isMarkdown} ariaLabel="Artifact source" />
      </TabsContent>
    </Tabs>
  );
}
