"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, Play, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { runtimeFor } from "@/lib/artifact-runtime";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
};

// One quiet accent per artifact kind, driven entirely by theme tokens (no raw
// hex): a tinted icon tile, a small dot beside the type label, and a hover
// border + colored ambient shadow so cards answer the cursor in their own hue.
// Markdown stays neutral ink — documents read as paper, not product.
const ACCENTS: Record<ArtifactType, { tile: string; dot: string; card: string }> = {
  HTML: {
    tile: "border-primary/15 bg-primary/10 text-primary",
    dot: "bg-primary",
    card: "hover:border-primary/40 hover:shadow-[0_14px_36px_-18px_hsl(var(--primary)/0.55)]",
  },
  REACT: {
    tile: "border-source/15 bg-source/10 text-source",
    dot: "bg-source",
    card: "hover:border-source/40 hover:shadow-[0_14px_36px_-18px_hsl(var(--source)/0.55)]",
  },
  CODE: {
    tile: "border-warning/15 bg-warning/10 text-warning",
    dot: "bg-warning",
    card: "hover:border-warning/40 hover:shadow-[0_14px_36px_-18px_hsl(var(--warning)/0.55)]",
  },
  SVG: {
    tile: "border-ultra/15 bg-ultra/10 text-ultra",
    dot: "bg-ultra",
    card: "hover:border-ultra/40 hover:shadow-[0_14px_36px_-18px_hsl(var(--ultra)/0.55)]",
  },
  MARKDOWN: {
    tile: "border-foreground/10 bg-foreground/[0.06] text-foreground/75",
    dot: "bg-foreground/50",
    card: "hover:border-foreground/25 hover:shadow-float",
  },
  MERMAID: {
    tile: "border-success/15 bg-success/10 text-success",
    dot: "bg-success",
    card: "hover:border-success/40 hover:shadow-[0_14px_36px_-18px_hsl(var(--success)/0.55)]",
  },
};

interface Item {
  id: string;
  title: string;
  type: ArtifactType;
  language: string | null;
  version: number;
  conversationId: string;
  conversationTitle: string;
  updatedAt: string;
}

export default function ArtifactsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/artifacts");
      if (!r.ok) throw new Error();
      setItems((await r.json()).items);
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  const loading = items === null;
  const empty = !loading && items.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Canvas</span>
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-display font-medium tracking-tight">Your artifacts</h1>
            <p className="mt-1 text-sm text-muted-foreground">Apps, components, and docs Juno built with you.</p>
          </div>
          {!loading && !empty && !error && (
            <span className="hidden shrink-0 rounded-full border border-border/60 bg-card/60 px-3 py-1 font-mono text-caption text-muted-foreground shadow-soft sm:inline-block">
              {items.length} {items.length === 1 ? "artifact" : "artifacts"}
            </span>
          )}
        </div>

        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load your artifacts.</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-28 rounded-[16px]" style={{ animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 motion-safe:animate-rise-in">
            <div className="field-well mx-auto flex max-w-md flex-col items-center rounded-panel border border-dashed border-border/60 bg-muted/10 px-8 py-12 text-center">
              {/* A small fan of the kinds of things the canvas builds. */}
              <div aria-hidden className="flex items-end -space-x-2">
                <span className="flex size-10 rotate-[-8deg] items-center justify-center rounded-[12px] border border-source/15 bg-source/10 text-source shadow-soft">
                  <Code2 className="h-[18px] w-[18px]" />
                </span>
                <span className="z-10 flex size-12 -translate-y-1 items-center justify-center rounded-[12px] border border-primary/20 bg-primary/10 text-primary shadow-soft">
                  <Globe className="size-5" />
                </span>
                <span className="flex size-10 rotate-[8deg] items-center justify-center rounded-[12px] border border-success/15 bg-success/10 text-success shadow-soft">
                  <GitBranch className="h-[18px] w-[18px]" />
                </span>
              </div>
              <p className="mt-5 font-serif text-heading">No artifacts yet.</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Ask Juno to build a component, page, or diagram — it opens in the Canvas and collects here.
              </p>
              <Button size="sm" className="mt-5" onClick={() => router.push("/chat")}>Start building</Button>
              <p className="mt-3 font-mono text-caption text-muted-foreground/60">Try “/artifact” in any chat</p>
            </div>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((a, i) => {
              const Icon = ICONS[a.type] ?? FileCode2;
              const accent = ACCENTS[a.type] ?? ACCENTS.CODE;
              const rt = runtimeFor(a.type, a.language);
              const runnable = rt.mode !== "none";
              const RunIcon = rt.mode === "console" ? Terminal : Play;
              return (
                <Link
                  key={a.id}
                  href={`/chat/${a.conversationId}`}
                  style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                  className={cn(
                    "group/art sheen-sweep block rounded-[16px] border border-border/70 bg-card p-4 shadow-soft outline-none",
                    "transition-all duration-base ease-out-soft [animation-fill-mode:backwards]",
                    "focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-rise-in motion-safe:hover:-translate-y-0.5",
                    accent.card
                  )}
                >
                  <div className="flex items-start gap-3.5">
                    <span
                      className={cn(
                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border shadow-soft transition-transform duration-base ease-out-soft group-hover/art:scale-105",
                        accent.tile
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold tracking-tight">{a.title || "Untitled artifact"}</p>
                        <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-all duration-base ease-out-soft group-hover/art:translate-x-0.5 group-hover/art:-translate-y-0.5 group-hover/art:text-primary" />
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/70">
                          <span aria-hidden className={cn("size-1.5 rounded-full", accent.dot)} />
                          {rt.label}
                        </span>
                        {runnable && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1">
                              <RunIcon className="h-3 w-3" />
                              {rt.runVerb}
                            </span>
                          </>
                        )}
                        <span aria-hidden>·</span>
                        <span>
                          {a.version > 1 ? `v${a.version} · ` : ""}
                          {timeAgo(a.updatedAt)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-caption text-muted-foreground/70">in “{a.conversationTitle}”</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
