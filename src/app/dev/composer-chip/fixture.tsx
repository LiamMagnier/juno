"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { TaskModeChip } from "@/components/chat/task-mode-chip";
import { BOOTSTRAP } from "@/app/dev/composer-landing/fixture";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import { GEN_MODELS, MODEL_LIST, type ModelId } from "@/lib/models";
import { withSupersededMarked } from "@/lib/model-metrics";
import { PROVIDER_LIST } from "@/lib/providers";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/types/chat";

/*
 * The chat composer's controls row with its paid modes wired, which the
 * composer-landing fixture leaves out: Fast, Ultra fast and Pro switch on in
 * the thinking panel and show on the closed chip. Every lab configured, the
 * whole catalogue served, so any model id can be opened.
 *
 *   ?model=<id>          the model (default Auto)
 *   ?effort=<value>      a rung (`instant` for none)
 *   ?fast=1 ?ultra=1 ?pro=1
 *   ?task=0              without the task-mode chip beside the model chip
 */

const CATALOG = withSupersededMarked([...MODEL_LIST, ...GEN_MODELS], "2026-10-10");

const FIXTURE_BOOTSTRAP = {
  ...BOOTSTRAP,
  features: { ...BOOTSTRAP.features, providers: [...PROVIDER_LIST] },
} as AppBootstrap;

/** /api/models answers with the bundled catalogue, text and media. */
function useModelsShim() {
  React.useState(() => {
    if (typeof window === "undefined") return null;
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/models")) {
        return new Response(JSON.stringify({ models: CATALOG }), { headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    };
    return null;
  });
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const effort = params.get("effort");
  return {
    model: (params.get("model") ?? AUTO_MODEL_ID) as ModelId,
    effort: effort == null ? undefined : effort === "instant" ? null : (effort as ReasoningEffort),
    fast: params.get("fast") === "1",
    ultra: params.get("ultra") === "1",
    pro: params.get("pro") === "1",
    task: params.get("task") !== "0",
  };
}

function Stage() {
  const [ready, setReady] = React.useState(false);
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const [fast, setFast] = React.useState(false);
  const [ultra, setUltra] = React.useState(false);
  const [pro, setPro] = React.useState(false);
  const [task, setTask] = React.useState(true);
  React.useEffect(() => {
    const p = readParams();
    setModel(p.model);
    if (p.effort !== undefined) setEffort(p.effort);
    setFast(p.fast);
    setUltra(p.ultra);
    setPro(p.pro);
    setTask(p.task);
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <section data-fixture="composer-chip" className="flex min-h-dvh flex-col justify-end">
      <div className="relative isolate w-full pb-6">
        <Composer
          conversationId="conv-dev"
          frame="dock"
          model={model}
          onModelChange={setModel}
          onSend={() => ({ accepted: true })}
          isBusy={false}
          status="idle"
          onStop={() => {}}
          reasoningEffort={effort}
          onReasoningChange={setEffort}
          fastMode={fast}
          onToggleFastMode={(v) => {
            setFast(v);
            if (v) setUltra(false);
          }}
          ultraFast={ultra}
          onToggleUltraFast={(v) => {
            setUltra(v);
            if (v) setFast(false);
          }}
          proMode={pro}
          onToggleProMode={setPro}
          webSearchEnabled
          onToggleWebSearch={() => {}}
          onToggleConnector={() => {}}
          onOpenVoiceMode={() => {}}
          taskModeControl={
            task ? <TaskModeChip chosen={null} effective="balanced" narrowedBy={null} onChange={() => {}} /> : undefined
          }
        />
      </div>
    </section>
  );
}

export function ComposerChipFixture() {
  useModelsShim();
  return (
    <AppProvider bootstrap={FIXTURE_BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background text-foreground">
        <Stage />
      </main>
    </AppProvider>
  );
}
