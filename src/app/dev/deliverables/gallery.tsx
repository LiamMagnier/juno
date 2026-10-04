"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { SemanticArtifactView } from "@/components/semantic/semantic-artifact-view";
import { applySemanticOps, describeSemantic, type SemanticArtifactType } from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import { FIXTURES, chatEdit } from "./fixtures";

const KINDS: Record<string, SemanticArtifactType> = { spreadsheet: "SPREADSHEET", document: "DOCUMENT", presentation: "PRESENTATION" };

interface Version {
  content: string;
  origin: "generated" | "edit" | "restore";
  note: string;
}

/**
 * The canvas around a semantic artifact, without the server: the same engine
 * applies operations, each success is a new version, undo restores the
 * previous version as a new one (history is never rewritten).
 */
export function DeliverablesGallery() {
  const params = useSearchParams();
  const type = KINDS[params.get("kind") ?? "spreadsheet"] ?? "SPREADSHEET";
  const [versions, setVersions] = React.useState<Version[]>([{ content: FIXTURES[type], origin: "generated", note: "Created" }]);
  React.useEffect(() => setVersions([{ content: FIXTURES[type], origin: "generated", note: "Created" }]), [type]);
  const head = versions[versions.length - 1];

  const apply = React.useCallback(
    async (ops: Record<string, unknown>[], origin: Version["origin"] = "edit") => {
      try {
        const result = applySemanticOps(type, head.content, ops, { author: "You" });
        setVersions((list) => [...list, { content: result.content, origin, note: result.changes.join("; ") }]);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: error instanceof SemanticError ? error.message : String(error) };
      }
    },
    [type, head.content]
  );
  const edit = chatEdit(type, versions[0].content);

  return (
    <main className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h1 className="font-serif text-title">Semantic artifacts</h1>
        <nav className="flex gap-4 font-mono text-caption text-muted-foreground">
          {Object.keys(KINDS).map((kind) => (
            <a key={kind} href={`?kind=${kind}`} className={KINDS[kind] === type ? "text-foreground underline underline-offset-4" : undefined}>
              {kind}
            </a>
          ))}
        </nav>
      </header>
      <section className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border/60 pb-3 font-mono text-caption text-muted-foreground">
        <span className="text-foreground">“{edit.ask}”</span>
        <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => void apply(edit.ops, "generated")} data-testid="chat-edit">
          Send as a chat edit
        </button>
        <button
          type="button"
          className="underline underline-offset-4 hover:text-foreground disabled:opacity-40"
          disabled={versions.length < 2}
          data-testid="undo"
          onClick={() => setVersions((list) => [...list, { content: list[list.length - 2].content, origin: "restore", note: `Restored v${list.length - 1}` }])}
        >
          Undo
        </button>
        <span className="ml-auto">{describeSemantic(type, head.content)}</span>
      </section>
      <div className="min-h-0 flex-1 overflow-hidden border border-border/60" data-testid="canvas">
        <SemanticArtifactView type={type} content={head.content} readOnly={false} onApplyOps={(ops) => apply(ops)} />
      </div>
      <ol className="grid gap-1 font-mono text-caption text-muted-foreground" aria-label="Versions">
        {versions.map((v, i) => (
          <li key={i} className={i === versions.length - 1 ? "text-foreground" : undefined}>
            v{i + 1} · {v.origin} · {v.note}
          </li>
        ))}
      </ol>
    </main>
  );
}
