"use client";
/**
 * The plan row: the agent's newest todo list, pinned above the composer
 * (plan-row.ts holds the rules). Collapsed it reads "Plan · 2 of 5 · <step>";
 * a press opens the whole checklist. No motion beyond the disclosure, which
 * the reduced-motion block in code-v2.css turns off.
 */
import * as React from "react";
import type { SessionState, TurnItem } from "@/lib/code-v2/contracts";
import { planRowModel } from "@/lib/code-v2/plan-row";
import { Checklist } from "./thread";

export function PlanRow({ items, state }: { items: readonly TurnItem[]; state: SessionState }) {
  const plan = React.useMemo(() => planRowModel(items, state), [items, state]);
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  if (!plan) return null;
  const summary = plan.finished ? "All steps done" : plan.current ?? "";
  return (
    <div className="cv2-plan" data-open={open || undefined}>
      <button
        type="button"
        className="cv2-plan-head"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cv2-plan-label">Plan</span>
        <span className="cv2-plan-count" aria-label={`${plan.done} of ${plan.total} steps done`}>
          {plan.done} of {plan.total}
        </span>
        <span className="cv2-plan-current">{summary}</span>
        <span className="cv2-plan-chev" aria-hidden>{open ? "Hide" : "Show"}</span>
      </button>
      <div className="cv2-plan-meter" role="presentation">
        <span style={{ width: `${Math.round((plan.done / plan.total) * 100)}%` }} />
      </div>
      {open && (
        <div id={listId} className="cv2-plan-list">
          <Checklist steps={plan.steps} />
        </div>
      )}
    </div>
  );
}
