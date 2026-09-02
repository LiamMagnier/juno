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

  // The framing card: the same `surface-raised-lg` panel every centred card in
  // the unauthenticated product is cut from. The recipe carries its own
  // hairline and per-theme throw, so nothing is hand-written for dark.
  const panel = "surface-raised-lg min-h-0 flex-1 overflow-hidden rounded-panel";

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "code")} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-3">
        {/* No `h-8` override. TabsList is h-9 with p-1, and its triggers are
            `py-1` around a 20px line — 28px of content that needs a 36px shell.
            Forcing the track to 32px left 24px of slot, so both triggers hung
            2px past the top and bottom of the well they are supposed to sit in,
            on the one tab row a visitor sees before signing up. It also put this
            row at a height no other TabsList in the product uses. */}
        <TabsList>
          {hasPreview && <TabsTrigger value="preview">Preview</TabsTrigger>}
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
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
