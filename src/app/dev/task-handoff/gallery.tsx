"use client";

import * as React from "react";
import { ApprovalCard } from "@/components/chat/approval-card";
import type { ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";

const BRIEF = `Request: Can you put together a spreadsheet comparing the pricing of the top 15 project management tools for a 40-person team? Include annual vs monthly pricing and which tiers have SSO.

Brief: Research the 15 most widely used project management tools (Asana, Monday.com, ClickUp, Jira, Linear, Notion, Smartsheet, Wrike, Basecamp, Trello, Teamwork, Height, Airtable, Todoist Business, Microsoft Planner). For each, record the per-seat price on monthly and annual billing for a 40-person team, the cheapest tier that includes SSO (SAML), and a source link for every figure. Use each vendor's public pricing page as of today. Done means every cell is filled or marked "not published".

Deliverable: a spreadsheet with one row per tool and a total annual cost column for 40 seats`;

/** A receipt as the stream delivers it, with the fields a fixture varies. */
function fixture(overrides: Partial<ClientActionApproval> & { expiresInMs?: number }): ClientActionApproval {
  const { expiresInMs = 14 * 60_000, ...rest } = overrides;
  const now = Date.now();
  return {
    id: `dev-${Math.random().toString(36).slice(2, 10)}`,
    surface: "chat",
    sessionId: "dev-generation",
    conversationId: "dev-conversation",
    connectorId: "juno_work",
    connectorLabel: "Juno",
    toolName: "start_task",
    action: "connector.juno_work.start_task",
    riskClass: "external_write",
    preview: "Start a background task: Project management pricing spreadsheet. Estimated cost about $0.64.",
    detail: {
      title: "Project management pricing spreadsheet",
      estimate: "about $0.64",
      goal: BRIEF,
    },
    receiptDigest: "dev-digest",
    status: "pending" as ActionReceiptStatus,
    decision: null,
    canAllowScope: false,
    derivedFromUntrusted: false,
    expiresAt: new Date(now + expiresInMs).toISOString(),
    decidedAt: null,
    completedAt: null,
    createdAt: new Date(now).toISOString(),
    ...rest,
  };
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 py-8 first:border-t-0 first:pt-0">
      <h2 className="text-label font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-label text-muted-foreground">{note}</p>
      {children}
    </section>
  );
}

export function TaskHandoffGallery() {
  // Built after mount: the countdown and the relative deadlines are clock
  // reads, and the server's clock is not the reader's.
  const [cards, setCards] = React.useState<Record<string, ClientActionApproval> | null>(null);
  React.useEffect(() => {
    setCards({
      expensive: fixture({}),
      untrusted: fixture({
        derivedFromUntrusted: true,
        detail: {
          title: "Reply to open vendor threads",
          estimate: "about $0.18",
          goal: "Request: Go through my inbox and draft replies to every vendor thread that is waiting on me.\n\nBrief: In Gmail, find threads from vendors where the last message is from them and unanswered for more than 2 days. Draft a short, polite reply for each in the user's voice. Do not send anything; leave every reply as a draft.",
        },
      }),
      started: fixture({ status: "executed", decision: "allow_once", completedAt: new Date().toISOString() }),
      declined: fixture({ status: "denied", decision: "deny" }),
      expired: fixture({ status: "expired", expiresInMs: -60_000 }),
      connector: fixture({
        connectorId: "github",
        connectorLabel: "GitHub",
        toolName: "create_issue",
        action: "connector.github.create_issue",
        preview: "GitHub wants to create issue.",
        detail: { repo: "juno/web", title: "Settings rail loses focus on close", labels: ["bug"] },
      }),
    });
  }, []);

  return (
    <main className="min-h-dvh bg-background px-4 py-10 text-foreground">
      <div className="mx-auto max-w-[44rem]">
        <h1 className="text-title font-semibold">Task handoff approvals</h1>
        <p className="mt-2 text-ui text-muted-foreground">
          The card the chat raises when the model wants to start a background task that needs a person first.
        </p>
        <div className="mt-8">
          {cards && (
            <>
              <Section title="Above the cost bar" note="A task whose estimate crossed the preflight bar.">
                <ApprovalCard approval={cards.expensive} />
              </Section>
              <Section title="Outside content in the turn" note="The turn read a web page, file or app, so the start asks first.">
                <ApprovalCard approval={cards.untrusted} />
              </Section>
              <Section title="Settled" note="Scrolled back to later: started, declined, expired.">
                <ApprovalCard approval={cards.started} />
                <ApprovalCard approval={cards.declined} />
                <ApprovalCard approval={cards.expired} />
              </Section>
              <Section title="Connector approval" note="The existing variant, for comparison.">
                <ApprovalCard approval={cards.connector} />
              </Section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
