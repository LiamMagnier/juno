"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { AppProvider } from "@/components/app/app-provider";
import { BOOTSTRAP } from "@/app/dev/composer-landing/fixture";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { GEN_MODELS, MODEL_LIST, resolveModel, type ModelId } from "@/lib/models";
import { clampReasoningEffort, defaultReasoning, reasoningOptions, supportsProMode, withSupersededMarked } from "@/lib/model-metrics";
import { fastModeMultiplier, supportsFastMode, ultraFastMultiplier } from "@/lib/pricing";
import { PROVIDER_LIST } from "@/lib/providers";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/lib/model-metrics";

const ModelSelector = nextDynamic(() => import("@/components/chat/model-selector").then((m) => m.ModelSelector), {
  ssr: false,
});

const CATALOG = withSupersededMarked([...MODEL_LIST, ...GEN_MODELS], "2026-10-10");

/** Every lab configured, a Pro plan: the account the Mac fixture describes. */
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

function Stage() {
  const params = useSearchParams();
  const [value, setValue] = React.useState<ModelId>((params.get("model") ?? "anthropic:claude-opus-5-5") as ModelId);
  const resolved = resolveModel(value);
  const options = resolved ? reasoningOptions(resolved) : [];
  const requested = params.get("effort");
  const [effort, setEffort] = React.useState<ReasoningEffort>(
    requested == null ? (resolved ? defaultReasoning(resolved) : null) : requested === "instant" ? null : (requested as ReasoningEffort),
  );
  const [fast, setFast] = React.useState(params.get("fast") === "1");
  const [pro, setPro] = React.useState(params.get("pro") === "1");
  // ?ultra=1 with ?model=openai:gpt-6.1-sol: the Ultra fast switch on.
  const [ultra, setUltra] = React.useState(params.get("ultra") === "1");
  const ultraRate = resolved ? ultraFastMultiplier(resolved) : null;
  const thinking =
    !resolved || options.length < 2 ? null : (
      <ReasoningSlider
        variant="panel"
        defaultValue={defaultReasoning(resolved)}
        options={options}
        value={clampReasoningEffort(resolved, effort)}
        onChange={setEffort}
        fastMode={fast && !(ultra && ultraRate != null)}
        fastModeMultiplier={fastModeMultiplier(resolved) ?? undefined}
        onFastModeChange={supportsFastMode(resolved) ? (v) => { setFast(v); if (v) setUltra(false); } : undefined}
        ultraFast={ultra && ultraRate != null}
        ultraFastMultiplier={ultraRate ?? undefined}
        onUltraFastChange={ultraRate != null ? (v) => { setUltra(v); if (v) setFast(false); } : undefined}
        proMode={pro}
        onProModeChange={supportsProMode(resolved) ? setPro : undefined}
      />
    );
  const effortLabel =
    resolved && options.length >= 2 && effort !== defaultReasoning(resolved)
      ? options.find((o) => o.value === clampReasoningEffort(resolved, effort))?.label
      : undefined;
  return (
    <div className="flex min-h-screen items-end justify-end bg-background p-6">
      <div data-testid="chip-host" className="flex items-center rounded-full border border-border bg-card px-2 py-1">
        <ModelSelector value={value} onChange={setValue} thinking={thinking} inComposer effortLabel={effortLabel} />
      </div>
    </div>
  );
}

export function ModelPickerFixture() {
  useModelsShim();
  return (
    <AppProvider bootstrap={FIXTURE_BOOTSTRAP}>
      <React.Suspense>
        <Stage />
      </React.Suspense>
    </AppProvider>
  );
}
