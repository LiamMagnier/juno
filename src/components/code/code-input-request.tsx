"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { AgentPlanProposalItem, AgentQuestionItem } from "@/lib/agent-protocol/fold";
import { PRODUCT_NAME } from "@/lib/brand/names";

/** Reader input stays visible until the host records its resolution. */
export function CodeInputRequest({ question, plan, busy, answer, decide }: {
  question: AgentQuestionItem | null;
  plan: AgentPlanProposalItem | null;
  busy: boolean;
  answer: (id: string, text: string) => Promise<boolean>;
  decide: (id: string, decision: "approve" | "reject") => Promise<boolean>;
}) {
  const [draft, setDraft] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  React.useEffect(() => { setDraft(""); setSent(null); }, [question?.questionId, plan?.planId]);
  if (!question && !plan) return null;
  const waiting = sent === (question?.questionId ?? plan?.planId);
  return (
    <section className="mb-3 border-t border-border pt-4" aria-label={question ? `${PRODUCT_NAME} needs an answer` : `Review ${PRODUCT_NAME}’s plan`}>
      <p className="mb-2 text-sm font-medium">{question ? `${PRODUCT_NAME} needs your answer` : "Review the plan"}</p>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{question?.prompt ?? plan?.text}</p>
      {question ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim() || busy || waiting) return;
          if (await answer(question.questionId, draft.trim())) setSent(question.questionId);
        }}>
          {question.options && <p className="text-sm text-muted-foreground">{question.options.map((option) => option.label).join(" · ")}</p>}
          <textarea aria-label="Your answer" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={32000} rows={2} disabled={busy || waiting} className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <Button type="submit" disabled={busy || waiting || !draft.trim()} className="self-start">Send answer</Button>
        </form>
      ) : plan && (
        <div className="mt-3 flex gap-2">
          <Button variant="outline" disabled={busy || waiting} onClick={async () => { if (await decide(plan.planId, "reject")) setSent(plan.planId); }}>Keep planning</Button>
          <Button disabled={busy || waiting} onClick={async () => { if (await decide(plan.planId, "approve")) setSent(plan.planId); }}>Approve plan</Button>
        </div>
      )}
      {waiting && <p role="status" className="mt-2 text-sm text-muted-foreground">Answer sent. Waiting for the computer to confirm.</p>}
    </section>
  );
}
