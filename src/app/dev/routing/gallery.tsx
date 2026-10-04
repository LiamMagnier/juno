"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { MessageItem } from "@/components/chat/message-item";
import { AutoReceipt, AutoReceiptReasons } from "@/components/chat/auto-receipt";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import { resolveModel } from "@/lib/models";
import { effortLabel, type RoutingReceipt } from "@/lib/router/receipt";
import type { ChatMessage } from "@/hooks/use-chat";
import type { AppBootstrap } from "@/types/app";
import type { ClientArtifact } from "@/types/chat";

export interface RoutingCase {
  id: string;
  prompt: string;
  modelId: string;
  receipt: RoutingReceipt;
  taskClass: string;
  complexity: string;
  excluded: Record<string, number | undefined>;
  ranked: {
    modelId: string;
    name: string;
    effort: string | null;
    pSuccess: number;
    call: number;
    tools: number;
    retries: number;
    failure: number;
    latency: number;
    total: number;
  }[];
}

/* Only what the rendered components read is filled in (see /dev/transcript). */
const BOOTSTRAP = {
  user: { id: "dev", name: "Dev", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
    personality: "default",
    customInstructions: "",
    responseLanguage: "auto",
    uiLocale: "en",
    memoryEnabled: true,
    memorySensitiveTopics: [],
    memoryBackgroundLearning: false,
    backgroundProviderMode: "same_provider",
    autoPreference: "balanced",
    autoDataBoundary: "verified_no_training",
    voiceId: null,
    favoriteModels: [],
    emailBudgetAlerts: false,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: true,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic", "openai", "google"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

const AT = new Date(Date.now() - 60_000).toISOString();
const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const noop = () => {};

const ANSWER = "Here is the answer, written by the model Auto chose. The receipt sits at the end of the action row.";

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-routing-section={id} className="border-t border-border py-10">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-body text-muted-foreground">{note}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 5 : 4)}`;
}

export function RoutingGallery({ cases, only }: { cases: RoutingCase[]; only?: string }) {
  const show = (id: string) => !only || only === id;
  const coding = cases.find((c) => c.id === "coding") ?? cases[0];
  const codingName = resolveModel(coding.modelId)?.name ?? coding.modelId;

  const turns: ChatMessage[] = [
    { id: "u1", role: "USER", content: coding.prompt, createdAt: AT, attachments: [], conversationId: "dev" },
    {
      id: "a1",
      role: "ASSISTANT",
      content: ANSWER,
      model: coding.modelId,
      routing: coding.receipt,
      promptTokens: 2_140,
      completionTokens: 1_870,
      costUsd: 0.0412,
      createdAt: AT,
      attachments: [],
      conversationId: "dev",
    },
    { id: "u2", role: "USER", content: "Now just rename the variable.", createdAt: AT, attachments: [], conversationId: "dev" },
    {
      id: "a2",
      role: "ASSISTANT",
      content: "A turn the reader routed by hand: the model name only, no Auto receipt.",
      model: "anthropic:claude-sonnet-5-5",
      promptTokens: 410,
      completionTokens: 96,
      costUsd: 0.0018,
      createdAt: AT,
      attachments: [],
      conversationId: "dev",
    },
  ];

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        <div className="page-gutter mx-auto w-full max-w-3xl py-12">
          <h1 className="font-serif text-page-title">Auto routing</h1>
          <p className="mt-1 text-body text-muted-foreground">
            The receipt on the real message, its reasons, and the decision behind each pick.
          </p>

          {show("thread") && (
            <Section
              id="thread"
              title="In the thread"
              note="The real MessageItem. Hover or focus a turn to see its receipt; the Auto line opens “Selected for”."
            >
              <div role="log" aria-label="Conversation transcript" className="group/thread space-y-6">
                {turns.map((m, i) => (
                  <div key={m.id} data-message-id={m.id}>
                    <MessageItem
                      message={m}
                      isLast={i === turns.length - 1}
                      busy={false}
                      artifactsByIdentifier={NO_ARTIFACTS}
                      onOpenArtifact={noop}
                      onRegenerate={noop}
                      onFeedback={noop}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {show("receipt") && (
            <Section id="receipt" title="Receipt" note="The line at rest, and the popover body it opens.">
              <div className="space-y-8">
                {cases.map((c) => {
                  const name = resolveModel(c.modelId)?.name ?? c.modelId;
                  return (
                    <div key={c.id} data-case={c.id}>
                      <p className="max-w-prose font-serif text-body leading-relaxed">{c.prompt}</p>
                      <div className="mt-2 flex text-caption text-muted-foreground">
                        <AutoReceipt modelName={name} receipt={c.receipt} />
                      </div>
                      <div className="surface-float mt-3 w-72 rounded-popover">
                        <AutoReceiptReasons modelName={name} receipt={c.receipt} />
                      </div>
                    </div>
                  );
                })}
                <div data-case="rerouted">
                  <p className="text-caption text-muted-foreground">Rerouted after its first choice could not be reached</p>
                  <div className="surface-float mt-3 w-72 rounded-popover">
                    <AutoReceiptReasons modelName={codingName} receipt={{ ...coding.receipt, rerouted: "anthropic:claude-opus-5-5" }} />
                  </div>
                </div>
              </div>
            </Section>
          )}

          {show("decisions") && (
            <Section
              id="decisions"
              title="Decisions (developer view)"
              note="Never shown in the product. Expected total = call + tool rounds + retries + (1 − p) × recovery + latency, micro-USD shown as dollars."
            >
              <div className="space-y-10">
                {cases.map((c) => (
                  <div key={c.id} data-decision={c.id}>
                    <p className="font-mono text-[11px] tracking-[0.02em] text-muted-foreground">
                      {c.taskClass} · {c.complexity} · excluded{" "}
                      {Object.entries(c.excluded)
                        .filter(([, n]) => n)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(", ")}
                    </p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[36rem] border-collapse text-left font-mono text-[11px] tabular-nums">
                        <thead className="text-muted-foreground">
                          <tr className="border-b border-border">
                            <th className="py-1.5 pr-3 font-normal">model</th>
                            <th className="py-1.5 pr-3 font-normal">effort</th>
                            <th className="py-1.5 pr-3 font-normal">p</th>
                            <th className="py-1.5 pr-3 font-normal">call</th>
                            <th className="py-1.5 pr-3 font-normal">tools</th>
                            <th className="py-1.5 pr-3 font-normal">retry</th>
                            <th className="py-1.5 pr-3 font-normal">failure</th>
                            <th className="py-1.5 pr-3 font-normal">latency</th>
                            <th className="py-1.5 font-normal">total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.ranked.map((r, i) => (
                            <tr key={r.modelId} className={i === 0 ? "text-foreground" : "text-muted-foreground"}>
                              <td className="py-1 pr-3">{r.name}</td>
                              <td className="py-1 pr-3">{effortLabel(r.effort as never)}</td>
                              <td className="py-1 pr-3">{r.pSuccess.toFixed(2)}</td>
                              <td className="py-1 pr-3">{usd(r.call)}</td>
                              <td className="py-1 pr-3">{usd(r.tools)}</td>
                              <td className="py-1 pr-3">{usd(r.retries)}</td>
                              <td className="py-1 pr-3">{usd(r.failure)}</td>
                              <td className="py-1 pr-3">{usd(r.latency)}</td>
                              <td className="py-1">{usd(r.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </main>
    </AppProvider>
  );
}
