"use client";

import * as React from "react";
import { DeckView } from "@/components/semantic/deck-view";
import { DocumentView } from "@/components/semantic/document-view";
import { SpreadsheetView } from "@/components/semantic/spreadsheet-view";
import { normalizeSemantic, type SemanticArtifactType } from "@/lib/work/deliverables/semantic";
import type { DeckModel } from "@/lib/work/deliverables/semantic/deck/model";
import type { DocumentModel } from "@/lib/work/deliverables/semantic/document/model";
import type { WorkbookModel } from "@/lib/work/deliverables/semantic/workbook/model";

/** Apply operations to the artifact and report the outcome; the caller saves a version. */
export type SemanticOpsHandler = (ops: Record<string, unknown>[]) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * A workbook, document or deck rendered from its model. The body is parsed
 * with the same validator the server stores it through; a body that does not
 * open says so plainly instead of showing JSON.
 */
export function SemanticArtifactView({
  type,
  content,
  readOnly = true,
  onApplyOps,
}: {
  type: SemanticArtifactType;
  content: string;
  readOnly?: boolean;
  onApplyOps?: SemanticOpsHandler;
}) {
  const parsed = React.useMemo(() => {
    try {
      return { model: normalizeSemantic(type, content), error: null };
    } catch (error) {
      return { model: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [type, content]);

  if (!parsed.model) {
    return (
      <div className="sx">
        <div className="sx-bar">
          <span className="sx-annot" data-tone="attention">
            This version could not be opened · {parsed.error}
          </span>
        </div>
      </div>
    );
  }
  switch (type) {
    case "SPREADSHEET":
      return <SpreadsheetView model={parsed.model as WorkbookModel} readOnly={readOnly} onApplyOps={onApplyOps} />;
    case "DOCUMENT":
      return <DocumentView model={parsed.model as DocumentModel} readOnly={readOnly} onApplyOps={onApplyOps} />;
    case "PRESENTATION":
      return <DeckView model={parsed.model as DeckModel} readOnly={readOnly} onApplyOps={onApplyOps} />;
  }
}

/** POST the operations to the ops route; resolves with the saved artifact or the refusal. */
export async function postSemanticOps<A>(
  artifactId: string,
  baseVersion: number,
  ops: Record<string, unknown>[]
): Promise<{ ok: true; artifact: A } | { ok: false; error: string; artifact?: A }> {
  try {
    const res = await fetch(`/api/artifacts/${artifactId}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion, ops }),
    });
    const body = (await res.json().catch(() => ({}))) as { artifact?: A; error?: string };
    if (res.ok && body.artifact) return { ok: true, artifact: body.artifact };
    if (res.status === 409) return { ok: false, error: "This changed since you opened it — showing the latest version.", artifact: body.artifact };
    return { ok: false, error: body.error ?? "The edit could not be saved." };
  } catch {
    return { ok: false, error: "The edit could not be saved." };
  }
}
