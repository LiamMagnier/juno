import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { IDLE_RUN, type PaneRun } from "@/lib/compare/pane-run";
import { buildCompareReport } from "@/lib/compare/report";
import { createRunSpec, plannedEffort, type CompareSettings } from "@/lib/compare/run-spec";
import { MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";

/*
 * The /compare components, rendered: each pane says what it actually ran
 * with, labels an estimated cost as an estimate and a measured time as
 * measured, warns when its conditions differ from what was asked, and marks
 * the sources other models share. The summary states the checked input
 * fingerprint and the verdicts. A smoke render of the whole view keeps the
 * page server-renderable.
 */

const scope = globalThis as { React?: typeof React };
scope.React ??= React;
// The pane's idle cover imports a stylesheet; Node's renderer has no CSS
// loader, so the asset is ignored for this SSR-only test (download-feed.test.ts).
type Ui = {
  AppProvider: typeof import("@/components/app/app-provider").AppProvider;
  TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
  ComparePane: typeof import("@/components/compare/compare-pane").ComparePane;
  CompareSummary: typeof import("@/components/compare/compare-summary").CompareSummary;
  CompareView: typeof import("@/components/compare/compare-view").CompareView;
  BOOTSTRAP: typeof import("@/app/dev/transcript/gallery").BOOTSTRAP;
};
let ui: Ui;
before(async () => {
  createRequire(import.meta.url).extensions[".css"] = () => {};
  ui = {
    AppProvider: (await import("@/components/app/app-provider")).AppProvider,
    TooltipProvider: (await import("@/components/ui/tooltip")).TooltipProvider,
    ComparePane: (await import("@/components/compare/compare-pane")).ComparePane,
    CompareSummary: (await import("@/components/compare/compare-summary")).CompareSummary,
    CompareView: (await import("@/components/compare/compare-view")).CompareView,
    BOOTSTRAP: (await import("@/app/dev/transcript/gallery")).BOOTSTRAP,
  };
});
const noop = () => {};
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };

function render(node: React.ReactElement): string {
  const providerProps = { bootstrap: ui.BOOTSTRAP } as React.ComponentProps<Ui["AppProvider"]>;
  const app = React.createElement(ui.AppProvider, providerProps, React.createElement(ui.TooltipProvider, null, node));
  return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never }, app));
}

const chatModels = MODEL_LIST.filter((m) => (m.modality ?? "chat") === "chat" && !m.comingSoon && !m.legacy);
const REASONER = chatModels.find((m) => m.reasoning && plannedEffort(m, "medium")?.honoured) as ModelInfo;
const NO_MAX = chatModels.find((m) => m.reasoning && plannedEffort(m, "max")?.honoured === false);
const OTHER = chatModels.find((m) => m.provider !== REASONER.provider) as ModelInfo;

const OFF: CompareSettings = { webSearch: false, reasoningEffort: null };

function doneRun(partial: Partial<PaneRun>): PaneRun {
  return {
    ...IDLE_RUN,
    status: "done",
    specId: "spec-1",
    requestedModelId: REASONER.id,
    servedModelId: REASONER.id,
    content: "An answer.",
    startedAt: 1_000,
    firstOutputAt: 1_600,
    firstAnswerAt: 2_000,
    finishedAt: 4_000,
    elapsedMs: 3_000,
    promptTokens: 800,
    completionTokens: 120,
    finishReason: "stop",
    ...partial,
  };
}

function pane(run: PaneRun, extra: Partial<React.ComponentProps<Ui["ComparePane"]>> = {}): string {
  return render(
    React.createElement(ui.ComparePane, {
      modelId: REASONER.id,
      run,
      requested: OFF,
      onChangeModel: noop,
      onRetry: noop,
      onContinue: noop,
      ...extra,
    })
  );
}

test("fixtures: the catalogue has the models these renders need", () => {
  assert.ok(REASONER, "a reasoning chat model that takes Medium");
  assert.ok(OTHER, "a chat model from another provider");
});

test("a reported cost reads plainly; measured times are labelled first and total", () => {
  const html = pane(doneRun({ costUsd: 0.0042, usageBasis: "reported", appliedEffort: "medium" }));
  assert.match(html, /first<\/span> <span class="tabular-nums">0\.6 s<\/span>/);
  assert.match(html, />3\.0s</, "the total time");
  assert.match(html, /\$0\.0042/);
  assert.doesNotMatch(html, /~\$0\.0042/);
  assert.doesNotMatch(html, / est\./);
  assert.match(html, /Times are measured in this browser/);
  assert.match(html, /as the provider reported them/);
  assert.match(html, />Medium</, "the effort the server reported");
  assert.match(html, /Reported by the server for this run/);
});

test("an estimated cost and its tokens carry ~ and est., and say why", () => {
  const html = pane(doneRun({ costUsd: 0.0042, usageBasis: "estimated" }));
  assert.match(html, /~\$0\.0042/);
  assert.match(html, /~920/);
  assert.match(html, / est\./);
  assert.match(html, /partly estimated from text length/);
  assert.match(html, /is an estimate/);
});

test("an effort the model cannot take is flagged, with what it ran at instead", { skip: !NO_MAX && "no catalogue model lacks Max" }, () => {
  const model = NO_MAX as ModelInfo;
  const html = pane(doneRun({ requestedModelId: model.id, servedModelId: model.id }), {
    modelId: model.id,
    requested: { webSearch: false, reasoningEffort: "max" },
  });
  assert.match(html, /bg-warning\/10/);
  assert.match(html, /Max was asked for, but this model can’t take it, so it runs at/);
  assert.match(html, /Planned from the model’s settings/);
});

test("search asked for but not applied is struck through and explained", () => {
  const html = pane(doneRun({ webSearchApplied: false }), { requested: { webSearch: true, reasoningEffort: null } });
  assert.match(html, /line-through/);
  assert.match(html, /can’t search here, so it answers from what it knows/);
});

test("an answer from another model than the pane asked for says so above the answer", () => {
  const html = pane(doneRun({ servedModelId: OTHER.id }));
  assert.match(html, new RegExp(`Answered by ${OTHER.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
  assert.match(html, /couldn’t use/);
});

test("sources list marks the pages other models share and opens them safely", () => {
  const html = pane(doneRun({}), {
    citations: {
      total: 2,
      shared: 1,
      unique: 1,
      refs: [
        { title: "Shared page", url: "https://shared.example/x", host: "shared.example", inSources: true, inText: false, sharedWith: ["GPT-6 Luna"] },
        { title: "Own page", url: "https://own.example/", host: "own.example", inSources: false, inText: true, sharedWith: [] },
      ],
    },
  });
  assert.match(html, /2 sources/);
  assert.match(html, /1 shared/);
  assert.match(html, /title="Also cited by GPT-6 Luna"/);
  assert.match(html, />in text</);
  assert.match(html, /href="https:\/\/shared\.example\/x" target="_blank" rel="noopener noreferrer"/);
});

test("an idle pane shows no receipt figures", () => {
  const html = pane(IDLE_RUN);
  assert.doesNotMatch(html, /tokens/);
  assert.match(html, /opacity-0/, "the footer is held invisible until a run");
});

test("the summary states the checked fingerprint, the verdicts and every difference", () => {
  const spec = createRunSpec({ id: "spec-1", prompt: "Hi", settings: { webSearch: true, reasoningEffort: "high" }, timeZone: "UTC" });
  const report = buildCompareReport({
    spec,
    resolveModel: (id) => resolveModel(id) ?? undefined,
    panes: [
      {
        paneId: "a",
        modelId: REASONER.id,
        run: doneRun({ specId: spec.id, inputFingerprint: spec.fingerprint, appliedEffort: "high", webSearchApplied: true, costUsd: 0.01, usageBasis: "reported" }),
      },
      {
        paneId: "b",
        modelId: OTHER.id,
        run: doneRun({
          specId: spec.id,
          requestedModelId: OTHER.id,
          servedModelId: OTHER.id,
          inputFingerprint: spec.fingerprint,
          appliedEffort: null,
          webSearchApplied: false,
          firstOutputAt: 1_200,
          finishedAt: 2_500,
          costUsd: 0.002,
          usageBasis: "estimated",
        }),
      },
    ],
  });
  const html = render(React.createElement(ui.CompareSummary, { report, streaming: false }));
  assert.match(html, /Same input to every model/);
  assert.match(html, new RegExp(`#${spec.fingerprint.slice(0, 8)}`));
  assert.match(html, /First to answer/);
  assert.match(html, /First to finish/);
  assert.match(html, /Lowest cost/);
  assert.match(html, /~\$0\.0020/, "the cheaper pane's cost is an estimate and reads as one");
  assert.match(html, /Thinking effort differs/);
  assert.match(html, /couldn’t search the web/);
  assert.match(html, /aria-label="Export comparison"/);
  const streaming = render(React.createElement(ui.CompareSummary, { report, streaming: true }));
  assert.match(streaming, /Export comparison \(available when every model has finished\)/);
});

test("the whole view renders on the server with its run settings", () => {
  const html = render(React.createElement(ui.CompareView));
  assert.match(html, /Compare/);
  assert.match(html, /aria-pressed="false"[^>]*>.*Search/s);
  assert.match(html, /Thinking effort for every model: Model default/);
  assert.match(html, /Try one/);
  assert.doesNotMatch(html, /Comparison summary/, "no summary before the first run");
});
