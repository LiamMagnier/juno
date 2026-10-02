"use client";

import * as React from "react";

import { ReceiptLine } from "@/components/chat/run/step-row";
import { Collapse } from "@/components/ui/collapse";
import type { ClientActionApproval } from "@/lib/action-approval";
import { presentTool } from "@/lib/run/presentation";
import { useScrollAnchoredSize } from "@/lib/run/scroll-anchor";
import type { RunItem } from "@/lib/run/types";
import type { ToolCallApproval } from "@/types/run";

/*
 * One call's approval, anchored to that call (SPEC §7.10, DECISIONS U1).
 *
 * While the call waits on the reader, the full `ApprovalCard`, headed by the
 * call's own phrase ("GitHub · Create issue"). Once they answer here it folds
 * in place into a one-line receipt ("Allowed once · 14:02"); an answer given
 * elsewhere, or an expiry, lands as the same receipt, scroll-anchored because
 * the reader did not cause it. After `done` and on reload the receipt is read
 * from the call's stored approval, so it never unmounts at the end of the
 * turn (B2).
 *
 * The card's chunk is fetched as soon as the run makes its first call, so a
 * card never inserts blank while its code downloads (B19).
 */

type ToolItem = Extract<RunItem, { kind: "tool" }>;

const loadCard = () => import("@/components/chat/approval-card");
const ApprovalCard = React.lazy(() => loadCard().then((m) => ({ default: m.ApprovalCard })));

let prefetched = false;
/** Warms the card's chunk. Idempotent. */
export function prefetchApprovalCard(): void {
  if (prefetched || typeof window === "undefined") return;
  prefetched = true;
  void loadCard();
}

/** A live receipt as the call record stores it. */
export function receiptOf(approval: ClientActionApproval): ToolCallApproval {
  return {
    id: approval.id,
    status: approval.status,
    riskClass: approval.riskClass,
    decision: approval.decision === "allow_once" || approval.decision === "allow_scope" || approval.decision === "deny" ? approval.decision : null,
    decidedAt: approval.decidedAt,
    expiresAt: approval.expiresAt,
  };
}

/** Whether a call has an approval slot at all: it asked, or it is asking. */
export function hasApprovalSlot(item: ToolItem): boolean {
  return Boolean(item.call.approval) || item.call.status === "awaiting_approval";
}

export function ApprovalSlot({ item, approval }: { item: ToolItem; approval?: ClientActionApproval }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useScrollAnchoredSize(ref);
  const [decided, setDecided] = React.useState<ClientActionApproval | null>(null);
  const { call } = item;

  const asking = !decided && call.status === "awaiting_approval" && approval?.status === "pending";
  const receipt: ToolCallApproval | null = decided
    ? receiptOf(decided)
    : call.approval && call.approval.status !== "pending"
      ? call.approval
      : approval && approval.status !== "pending"
        ? receiptOf(approval)
        : null;

  return (
    <div ref={ref} data-approval-slot={call.callId}>
      <Collapse open={asking}>
        {approval ? (
          <React.Suspense fallback={null}>
            <ApprovalCard approval={approval} callLine={presentTool(call).running(call)} onDecided={setDecided} />
          </React.Suspense>
        ) : null}
      </Collapse>
      {!asking && receipt ? <ReceiptLine approval={receipt} className="block py-1 ps-7" /> : null}
    </div>
  );
}
