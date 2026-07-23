"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, Plus, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/components/app/app-provider";
import { ComparePane } from "@/components/compare/compare-pane";
import { IDLE_RUN, useCompare } from "@/components/compare/use-compare";
import { resolveModel, DEFAULT_MODEL, type ModelId, type ModelInfo } from "@/lib/models";
import { getModelMetrics, costScore } from "@/lib/model-metrics";
import { planRank, effectiveMinPlan } from "@/lib/plans";
import { cn, truncate } from "@/lib/utils";
import type { Provider } from "@/lib/providers";
import type { ClientMessage, ClientQuota } from "@/types/chat";

/**
 * Side-by-side model comparison — the aggregator's signature move. One prompt,
 * two or three models answering in parallel panes over the private (ephemeral)
 * chat transport, each with its live stream, response time, and real cost.
 * Nothing here is persisted: a fresh prompt replaces the panes.
 */

const MAX_PANES = 3;
const MIN_PANES = 2;
/** Last pane model selection, restored across visits. */
const PANE_MODELS_KEY = "juno:compare-models";
/** chat-view's branch-seeding stash — "Continue in chat" rides the fork flow. */
const FORK_STORAGE_KEY = "juno:fork";

// One-shot starter prompts: short enough to read at a glance, different enough
// (teach · write · plan) that the models' personalities actually show.
const SAMPLE_PROMPTS = [
  "Explain quantum entanglement like I'm a curious 12-year-old.",
  "Write a cold outreach email that doesn't feel cold.",
  "Plan a 3-day Lisbon trip on a €500 budget.",
];

interface PaneConfig {
  id: string;
  modelId: ModelId;
}

/** Chat models the user can actually run: configured provider + plan allows. */
function eligibleModels(models: ModelInfo[], plan: ClientQuota["plan"], providers: Provider[]): ModelInfo[] {
  return models.filter(
    (m) =>
      (m.modality ?? "chat") === "chat" &&
      !m.comingSoon &&
      providers.includes(m.provider) &&
      planRank(plan) >= planRank(effectiveMinPlan(m.minPlan))
  );
}

/**
 * The contrasting default for a new pane: a genuinely good model from a
 * provider not already on the board, favoring value (brains per dollar).
 */
function pickContrastModel(
  models: ModelInfo[],
  plan: ClientQuota["plan"],
  providers: Provider[],
  usedProviders: ReadonlySet<Provider>
): ModelId | null {
  const eligible = eligibleModels(models, plan, providers);
  const fresh = eligible.filter((m) => !m.legacy && !usedProviders.has(m.provider));
  const pool = fresh.length ? fresh : eligible.filter((m) => !usedProviders.has(m.provider));
  const pick = (list: ModelInfo[]) => {
    let best: ModelInfo | null = null;
    let bestScore = -Infinity;
    for (const m of list) {
      const metrics = getModelMetrics(m);
      // Value = intelligence weighted over cheapness (both 1–10 scales).
      const score = metrics.intelligence * 1.5 + costScore(metrics);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  };
  return (pick(pool) ?? pick(eligible))?.id ?? null;
}

export function CompareView() {
  const router = useRouter();
  const { models, settings, quota, features, setQuota } = useApp();
  const plan = quota.plan;
  const paneSeq = React.useRef(0);
  const nextPaneId = React.useCallback(() => `pane-${paneSeq.current++}`, []);

  // Runnable ids for the current plan/providers — a pane must never claim a
  // model the server would silently swap for its plan-aware fallback.
  const eligibleIds = React.useMemo(
    () => new Set(eligibleModels(models, plan, features.providers).map((m) => m.id)),
    [models, plan, features.providers]
  );

  // Defaults: pane 1 = the user's default model; pane 2 = a contrasting good
  // model from another provider (best value available to their plan).
  const [panes, setPanes] = React.useState<PaneConfig[]>(() => {
    let first = resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL;
    if (eligibleIds.size > 0 && !eligibleIds.has(first)) {
      first = pickContrastModel(models, plan, features.providers, new Set()) ?? first;
    }
    const firstProvider = resolveModel(first)?.provider;
    const contrast = pickContrastModel(models, plan, features.providers, new Set(firstProvider ? [firstProvider] : []));
    const second =
      contrast && contrast !== first
        ? contrast
        : models.find((m) => (m.modality ?? "chat") === "chat" && !m.comingSoon && m.id !== first)?.id ?? DEFAULT_MODEL;
    return [
      { id: nextPaneId(), modelId: first },
      { id: nextPaneId(), modelId: second },
    ];
  });

  // Restore the last selection after mount (not in the initializer — the page
  // is server-rendered, and localStorage must never shape the SSR output).
  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = window.localStorage.getItem(PANE_MODELS_KEY);
      if (!raw) return;
      const ids = (JSON.parse(raw) as unknown[]).filter((id): id is string => typeof id === "string");
      // Only restore ids that still run as-is (model exists, provider is
      // configured, plan allows) — anything else falls back to the defaults.
      const valid = ids
        .map((id) => resolveModel(id)?.id)
        .filter((id): id is string => !!id && (eligibleIds.size === 0 || eligibleIds.has(id)));
      if (valid.length >= MIN_PANES) {
        setPanes(valid.slice(0, MAX_PANES).map((modelId) => ({ id: nextPaneId(), modelId })));
      }
    } catch {
      /* malformed stash — defaults stand */
    }
    // One-shot on mount; eligibility is read from the mount-time snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextPaneId]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(PANE_MODELS_KEY, JSON.stringify(panes.map((p) => p.modelId)));
    } catch {
      /* storage may be unavailable */
    }
  }, [panes]);

  const compare = useCompare({ onQuota: setQuota });
  const { runs, anyStreaming, stopping } = compare;

  const [prompt, setPrompt] = React.useState("");
  // The prompt of the comparison currently on the board (in memory only — v1
  // keeps the last run, and a fresh prompt replaces the panes).
  const [lastPrompt, setLastPrompt] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const canSend = prompt.trim().length > 0 && !anyStreaming;

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [prompt, autoresize]);

  const runAll = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || anyStreaming) return;
      setLastPrompt(trimmed);
      compare.start(trimmed, panes);
    },
    [anyStreaming, compare, panes]
  );

  const submit = () => runAll(prompt);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const addPane = () => {
    if (panes.length >= MAX_PANES) return;
    const used = new Set(
      panes.map((p) => resolveModel(p.modelId)?.provider).filter((p): p is Provider => !!p)
    );
    const modelId =
      pickContrastModel(models, plan, features.providers, used) ??
      models.find((m) => (m.modality ?? "chat") === "chat" && !m.comingSoon)?.id ??
      DEFAULT_MODEL;
    const pane = { id: nextPaneId(), modelId };
    setPanes((prev) => [...prev, pane]);
    // Join the race late: run the new pane against the prompt on the board.
    if (lastPrompt) void compare.runPane(pane.id, modelId, lastPrompt);
  };

  const removePane = (paneId: string) => {
    if (panes.length <= MIN_PANES) return;
    compare.discardPane(paneId);
    setPanes((prev) => prev.filter((p) => p.id !== paneId));
  };

  const changeModel = (paneId: string, modelId: ModelId) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, modelId } : p)));
    // Same prompt, new mind — rerun just this pane so the answer never lies
    // about which model wrote it.
    if (lastPrompt) void compare.runPane(paneId, modelId, lastPrompt);
    else compare.resetPane(paneId);
  };

  // "Continue in chat": hand the winning prompt+answer to the chat view through
  // its existing fork stash — it opens as a seeded branch with full context.
  // (True DB seeding needs a message-create API that doesn't exist yet.)
  const continueInChat = (pane: PaneConfig) => {
    const run = runs[pane.id];
    if (!run?.content || !lastPrompt) return;
    const now = Date.now();
    const messages: ClientMessage[] = [
      {
        id: `compare-user-${now}`,
        role: "USER",
        content: lastPrompt,
        createdAt: new Date(run.startedAt ?? now).toISOString(),
        attachments: [],
      },
      {
        id: `compare-assistant-${now}`,
        role: "ASSISTANT",
        content: run.content,
        reasoning: run.reasoning || undefined,
        model: pane.modelId,
        createdAt: new Date().toISOString(),
        attachments: [],
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        costUsd: run.costUsd,
      },
    ];
    try {
      sessionStorage.setItem(FORK_STORAGE_KEY, JSON.stringify({ title: truncate(lastPrompt, 48), messages }));
    } catch {
      toast.error("Couldn't carry this answer into chat — it's too large.");
      return;
    }
    router.push("/chat");
  };

  const hasRun = lastPrompt !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Page header — serif heading, mono metadata, "not saved" said quietly. */}
      <header className="flex shrink-0 items-end justify-between gap-3 px-4 pb-3 pt-5 sm:px-6">
        <div>
          <p className="font-mono text-label text-muted-foreground">
            One prompt · {panes.length} models
          </p>
          <h1 className="mt-0.5 font-serif text-title tracking-tight">Compare</h1>
        </div>
        <span className="pb-0.5 text-right font-mono text-caption text-muted-foreground/70">
          Comparisons aren&rsquo;t saved
        </span>
      </header>

      {/* Prompt composer — one textarea, one coral action. */}
      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="flex w-full flex-col rounded-panel border border-border/70 bg-card/90 shadow-float backdrop-blur transition-[border-color,box-shadow] duration-base ease-out-soft focus-within:border-primary/30 focus-within:shadow-glass">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={anyStreaming}
            rows={1}
            autoFocus
            placeholder="Ask every model at once…"
            className="max-h-[160px] min-h-[56px] w-full resize-none bg-transparent px-3.5 py-3.5 text-body-lg leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 sm:px-4"
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2.5 pb-2.5 pt-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addPane}
                    disabled={panes.length >= MAX_PANES || anyStreaming}
                    className="gap-1.5 text-foreground/80"
                  >
                    <Plus className="h-4 w-4" /> Add model
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {panes.length >= MAX_PANES ? "Up to three models per race" : "Race a third model"}
              </TooltipContent>
            </Tooltip>
            <span className="font-mono text-caption text-muted-foreground/60">{panes.length}/{MAX_PANES}</span>

            {/* Primary action morphs in place: Send → Stop, shared by every pane. */}
            <div className="ml-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    onClick={anyStreaming ? compare.stopAll : submit}
                    disabled={anyStreaming ? stopping : !canSend}
                    aria-label={anyStreaming ? (stopping ? "Stopping all models" : "Stop all models") : "Send to every model"}
                    className={cn(
                      "coarse:h-11 coarse:w-11 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring",
                      anyStreaming ? "w-12 rounded-md shadow-soft ring-2 ring-primary/20" : "rounded-lg"
                    )}
                  >
                    {anyStreaming ? (
                      <Square key="stop" className="h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
                    ) : (
                      <ArrowUp key="send" className="h-4 w-4 motion-safe:animate-fade-in" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{anyStreaming ? "Stop" : "Send"}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>

      {/* Body: hero (until the first run) + the panes. Desktop keeps the page
          fixed-height with per-pane scroll; mobile stacks and scrolls whole. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
        {!hasRun && (
          <div className="flex shrink-0 flex-col items-center gap-4 px-6 pb-8 pt-6 text-center motion-safe:animate-rise-in">
            <h2 className="font-serif text-2xl font-normal tracking-tight sm:text-3xl">
              Same prompt, different minds
            </h2>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">
              Watch {panes.length} models answer live, side by side — with the real cost of every reply.
            </p>
            <div className="flex w-full max-w-2xl flex-wrap justify-center gap-2">
              {SAMPLE_PROMPTS.map((sample, i) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => {
                    setPrompt(sample);
                    runAll(sample);
                  }}
                  style={{ animationDelay: `${120 + i * 45}ms` }}
                  className="rounded-xl border border-border/70 bg-card/70 px-3.5 py-2.5 text-left font-sans text-sm leading-5 text-foreground/80 shadow-soft backdrop-blur transition-all duration-base ease-out-soft [animation-fill-mode:backwards] hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent hover:text-foreground hover:shadow-float active:translate-y-0 active:scale-[0.99] motion-safe:animate-rise-in"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          className={cn(
            "grid min-h-0 flex-1 grid-cols-1 divide-y divide-border/60 border-t border-border/60",
            "md:divide-x md:divide-y-0",
            panes.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"
          )}
        >
          {panes.map((pane) => (
            <ComparePane
              key={pane.id}
              modelId={pane.modelId}
              run={runs[pane.id] ?? IDLE_RUN}
              onChangeModel={(id) => changeModel(pane.id, id)}
              onRemove={panes.length > MIN_PANES ? () => removePane(pane.id) : undefined}
              onRetry={() => lastPrompt && void compare.runPane(pane.id, pane.modelId, lastPrompt)}
              onContinue={() => continueInChat(pane)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
