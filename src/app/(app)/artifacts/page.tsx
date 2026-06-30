"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { timeAgo } from "@/components/roadmap/roadmap-ui";

type ArtifactType = "HTML" | "REACT" | "CODE" | "MARKDOWN" | "SVG" | "MERMAID";

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
        <h1 className="font-serif text-display font-medium tracking-tight">Your artifacts</h1>
        <p className="mt-1 text-sm text-muted-foreground">Apps, components, and docs Juno built with you.</p>

        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load your artifacts.</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-lg" style={{ animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div>
              <p className="font-serif text-heading">No artifacts yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Ask Juno to build a component, page, or diagram — it opens in the Canvas and collects here.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((a, i) => {
              const Icon = ICONS[a.type] ?? FileCode2;
              return (
                <Card
                  key={a.id}
                  variant="interactive"
                  style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                  className="p-4 rounded-[24px] motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                >
                  <Link href={`/chat/${a.conversationId}`} className="flex gap-3 outline-none">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.title || "Untitled artifact"}</p>
                      <p className="mt-0.5 truncate text-caption text-muted-foreground">
                        {a.type.charAt(0) + a.type.slice(1).toLowerCase()}
                        {a.version > 1 ? ` · v${a.version}` : ""} · {timeAgo(a.updatedAt)}
                      </p>
                      <p className="mt-1 truncate text-caption text-muted-foreground/80">in “{a.conversationTitle}”</p>
                    </div>
                  </Link>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
