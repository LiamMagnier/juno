"use client";

import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon } from "lucide-react";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import type { ArtifactType } from "@/lib/message-content";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
};

export function ArtifactInlineCard({
  title,
  type,
  streaming,
  onOpen,
}: {
  title: string;
  type: ArtifactType;
  streaming?: boolean;
  onOpen?: () => void;
}) {
  const Icon = ICONS[type] ?? FileCode2;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      aria-busy={streaming || undefined}
      className="group/art my-2 flex w-full max-w-md items-center gap-3 rounded-xl border bg-card p-3 text-left shadow-soft transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-float disabled:cursor-default disabled:shadow-none disabled:hover:translate-y-0"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {streaming ? <ThinkingDots className="text-primary" /> : <Icon className="h-5 w-5" />}
      </div>
      <div className="min-w-0">
        <p className="truncate text-body font-medium">{title || "Untitled artifact"}</p>
        <p className="text-caption text-muted-foreground">
          {streaming ? "Writing…" : `${type.charAt(0) + type.slice(1).toLowerCase()} · Click to open`}
        </p>
      </div>
    </button>
  );
}
