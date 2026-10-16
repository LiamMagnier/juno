/**
 * The inline trace: the run's steps folded into the few rows that read well
 * under the live line, without opening the docked panel (thought-inline.tsx).
 *
 * The panel draws every step as its own row, filed under phases, with filters,
 * find and expandable bodies. Under an answer that is too much: a deep
 * research turn reads 30 pages, and thirty source rows would push the answer
 * a screen down. So this keeps the run's own order and words (it invents no
 * label — every string comes from `buildRun`) and only folds:
 *
 *   - the model's reasoning parts into reading sections (heading + prose);
 *   - every source into one row, placed where the first one was read;
 *   - every memory the turn drew on into one row.
 *
 * Searches, tool and skill calls, notices and the write step stay one row
 * each, because each is one thing the run did.
 */

import type { ReceiptIconKind } from "@/lib/chat/tool-receipt";
import { STEP_LABEL, type RunModel, type Step, type StepKind } from "@/components/chat/thought-process-model";

export type CompactRow =
  | {
      kind: "reasoning";
      id: string;
      /** The model's own bold heading for the part, or null when it wrote none. */
      heading: string | null;
      text: string;
    }
  | {
      kind: "step";
      id: string;
      stepKind: StepKind;
      label: string;
      detail: string | null;
      ms: number | null;
      running: boolean;
      failed: boolean;
      icon?: ReceiptIconKind;
    }
  | { kind: "sources"; id: "sources"; sources: { url: string; domain: string; title: string }[] }
  | { kind: "memory"; id: "memory"; items: string[] };

/** Generic labels `buildRun` gives a part with no heading of its own. */
const UNTITLED_PART = new Set<string>([STEP_LABEL.reasoning, STEP_LABEL.fullTrace]);

function stepRow(step: Step): CompactRow {
  return {
    kind: "step",
    id: step.id,
    stepKind: step.kind,
    label: step.label,
    detail: step.detail,
    ms: step.ms,
    running: step.running,
    failed: step.failed,
    ...(step.icon ? { icon: step.icon } : {}),
  };
}

export function compactTrace(run: Pick<RunModel, "steps">): CompactRow[] {
  const rows: CompactRow[] = [];
  let sources: Extract<CompactRow, { kind: "sources" }> | null = null;
  let memory: Extract<CompactRow, { kind: "memory" }> | null = null;
  for (const step of run.steps) {
    if (step.kind === "source" && step.source) {
      if (!sources) {
        sources = { kind: "sources", id: "sources", sources: [] };
        rows.push(sources);
      }
      // One row per page, even when a run read it twice.
      if (!sources.sources.some((s) => s.url === step.source!.url)) {
        sources.sources.push({ url: step.source.url, domain: step.source.domain, title: step.label });
      }
      continue;
    }
    if (step.kind === "memory") {
      if (!memory) {
        memory = { kind: "memory", id: "memory", items: [] };
        rows.push(memory);
      }
      memory.items.push(step.label);
      continue;
    }
    if (step.kind === "think" && step.body?.type === "prose" && step.body.text.trim()) {
      rows.push({
        kind: "reasoning",
        id: step.id,
        heading: UNTITLED_PART.has(step.label) ? null : step.label,
        text: step.body.text.trim(),
      });
      continue;
    }
    rows.push(stepRow(step));
  }
  return rows;
}

/**
 * The tail of a growing trace, cut at a paragraph or sentence boundary, for
 * the live view: the inline section shows what the model is on now, not the
 * first screen of what it was on a minute ago. Settled traces are shown whole.
 */
export function traceTail(text: string, limit = 1200): { text: string; clipped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return { text: trimmed, clipped: false };
  const slice = trimmed.slice(trimmed.length - limit);
  const para = slice.indexOf("\n\n");
  if (para >= 0 && para < limit / 2) return { text: slice.slice(para + 2).trim(), clipped: true };
  const sentence = slice.search(/[.!?]\s/);
  if (sentence >= 0 && sentence < limit / 2) return { text: slice.slice(sentence + 2).trim(), clipped: true };
  return { text: slice.trim(), clipped: true };
}
