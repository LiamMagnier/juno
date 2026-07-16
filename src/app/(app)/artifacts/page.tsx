"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, Play, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
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
          <div className="mt-12 flex flex-col items-center gap-4 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Code2 className="h-7 w-7" />
            </span>
            <div>
              <p className="font-serif text-heading">No artifacts yet.</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Ask Juno to build a component, page, or diagram — it opens in the Canvas and collects here.
              </p>
            </div>
            <Button size="sm" onClick={() => router.push("/chat")}>Start building</Button>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((a, i) => {
              const Icon = ICONS[a.type] ?? FileCode2;
              const rt = runtimeFor(a.type, a.language);
              const runnable = rt.mode !== "none";
              const RunIcon = rt.mode === "console" ? Terminal : Play;
              return (
                <Link
                  key={a.id}
                  href={`/chat/${a.conversationId}`}
                  style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                  className="group/art block rounded-[16px] border border-border/70 bg-card p-4 shadow-soft outline-none transition-all duration-base ease-out-soft [animation-fill-mode:backwards] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-rise-in"
                >
                  <div className="flex items-start gap-3.5">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary transition-transform duration-base ease-out-soft group-hover/art:scale-105">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold tracking-tight">{a.title || "Untitled artifact"}</p>
                        <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-all duration-base ease-out-soft group-hover/art:translate-x-0.5 group-hover/art:-translate-y-0.5 group-hover/art:text-primary" />
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                        <span className="font-medium text-foreground/70">{rt.label}</span>
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
