"use client";

import * as React from "react";

import { ThoughtProcessPanel } from "@/components/chat/thought-process-panel";
import type { LiveCopy, RunModel, Step } from "@/components/chat/thought-process-model";

/*
 * Fixed runs for the thought-process panel. Hand-built `RunModel`s rather than
 * event scripts: the panel's contract is the model, and these are the shapes
 * `buildRun` produces for the four states worth looking at. The live states
 * tick their own clock so the elapsed figure and the trajectory move as they
 * do in a chat.
 */

const TRACE = `The question is whether the move to a four-day week changed output, not hours. The two studies measure different things: one counts closed tickets, the other self-reported focus.

Tickets are the cleaner signal, but they reward small work. I should say what each measures before comparing them, and keep the comparison to the teams that kept the same scope.

The answer should lead with the finding, then the caveat about scope, then the two sources.`;

const FACTS = [
  { label: "Model", value: "Claude Fable 5.1" },
  { label: "Effort", value: "High" },
  { label: "Context", value: "18.4k of 200k tokens" },
];

function phases(active: "research" | "think" | "write" | null, ms: { research?: number; think?: number; write?: number }) {
  return (["research", "think", "write"] as const)
    .filter((key) => key !== "research" || ms.research !== undefined)
    .map((key) => ({
      key,
      label: key === "research" ? "Research" : key === "think" ? "Think" : "Write",
      object: "",
      ms: ms[key] ?? null,
      active: active === key,
    }));
}

const SOURCES = [
  { url: "https://www.autonomy.work/four-day-week-uk-results", domain: "autonomy.work", title: "The results are in: the UK's four-day week pilot", access: "read" as const },
  { url: "https://www.nber.org/papers/w31209", domain: "nber.org", title: "Working time and productivity: evidence from a field trial", access: "read" as const },
  { url: "https://hbr.org/2023/02/the-four-day-week-is-here", domain: "hbr.org", title: "The four-day week is here", access: "listed" as const },
];

function sourceSteps(count: number): Step[] {
  return SOURCES.slice(0, count).map((s, i) => ({
    id: `src-${i}`,
    kind: "source",
    phase: "research",
    label: s.title,
    detail: s.domain,
    ms: null,
    running: false,
    failed: false,
    source: { url: s.url, domain: s.domain, access: s.access, citeIndex: i < 2 ? i + 1 : null },
  }));
}

const thinkStep = (running: boolean): Step => ({
  id: "reason-full",
  kind: "think",
  phase: "think",
  label: "Full reasoning trace",
  detail: "This model streams one unbroken trace.",
  ms: running ? null : 6200,
  running,
  failed: false,
  body: running ? undefined : { type: "prose", text: TRACE },
});

const writeStep = (running: boolean, ms: number | null): Step => ({
  id: "write",
  kind: "write",
  phase: "write",
  label: running ? "Writing the answer" : "Wrote the answer",
  detail: null,
  ms,
  running,
  failed: false,
});

const base: Omit<RunModel, "phases" | "steps" | "elapsedMs" | "stopped"> = {
  t0: 0,
  facts: FACTS,
  memoryReceipt: [],
  calls: [],
  sources: [],
  searches: 0,
  sourceCount: 0,
  query: null,
  note: null,
  outputTokens: null,
};

function fixture(state: string, elapsed: number): { run: RunModel; streaming: boolean; live?: LiveCopy; reasoning?: string; finishNote?: string } {
  if (state === "research") {
    const arrived = Math.min(3, 1 + Math.floor(elapsed / 1600));
    return {
      streaming: true,
      live: { message: `Reading ${SOURCES[arrived - 1].domain}`, warning: false },
      run: {
        ...base,
        elapsedMs: elapsed,
        stopped: false,
        searches: 1,
        query: "four-day week productivity study results",
        sources: SOURCES.slice(0, arrived),
        sourceCount: arrived,
        phases: phases("research", { research: elapsed }),
        steps: [
          {
            id: "search-1",
            kind: "search",
            phase: "research",
            label: "four-day week productivity study results",
            detail: "Searched the web",
            ms: 1400,
            running: false,
            failed: false,
          },
          ...sourceSteps(arrived),
          { ...thinkStep(true), label: "Thinking", detail: null },
        ],
      },
    };
  }
  if (state === "finished") {
    return {
      streaming: false,
      reasoning: TRACE,
      run: {
        ...base,
        elapsedMs: 21400,
        stopped: false,
        searches: 1,
        query: "four-day week productivity study results",
        sources: SOURCES,
        sourceCount: 3,
        outputTokens: "1,284",
        facts: [...FACTS, { label: "Cost", value: "$0.0213 · 22,104 input, 1,284 output" }],
        calls: [
          {
            id: "call-1",
            label: "Searched issues",
            object: "Linear",
            offsetMs: null,
            warn: false,
            server: "Linear",
            name: "linear__search_issues",
            tool: {
              server: "Linear",
              name: "linear__search_issues",
              args: '{\n  "query": "four-day week",\n  "team": "People Ops"\n}',
              result: '[\n  { "id": "PEO-112", "title": "Pilot: four-day week for Support" }\n]',
              status: "succeeded",
              durationMs: 820,
            } as never,
          },
        ],
        phases: phases(null, { research: 4200, think: 6200, write: 11000 }),
        steps: [
          {
            id: "search-1",
            kind: "search",
            phase: "research",
            label: "four-day week productivity study results",
            detail: "Searched the web",
            ms: 1400,
            running: false,
            failed: false,
          },
          ...sourceSteps(3),
          {
            id: "tool-1",
            kind: "tool",
            phase: "think",
            label: "Searched issues in Linear",
            detail: "1 result",
            ms: 820,
            running: false,
            failed: false,
            icon: "search",
            body: {
              type: "tool",
              tool: {
                server: "Linear",
                name: "linear__search_issues",
                args: '{\n  "query": "four-day week",\n  "team": "People Ops"\n}',
                result: '[\n  { "id": "PEO-112", "title": "Pilot: four-day week for Support" }\n]',
                status: "succeeded",
              } as never,
            },
          },
          thinkStep(false),
          writeStep(false, 11000),
        ],
      },
    };
  }
  if (state === "stopped") {
    return {
      streaming: false,
      reasoning: TRACE,
      finishNote: "The answer stopped at the model's output limit.",
      run: {
        ...base,
        elapsedMs: 48200,
        stopped: true,
        phases: phases(null, { think: 9100, write: 39100 }),
        steps: [thinkStep(false), writeStep(false, 39100)],
      },
    };
  }
  // running: the reference screenshot's run, writing at 13s.
  return {
    streaming: true,
    reasoning: TRACE,
    live: { message: "Writing the answer", warning: false },
    run: {
      ...base,
      elapsedMs: elapsed,
      stopped: false,
      phases: phases("write", { think: 6200, write: elapsed - 6200 }),
      steps: [{ ...thinkStep(false) }, writeStep(true, null)],
    },
  };
}

export function ThinkingPanelGallery({ state, mobile }: { state: string; mobile: boolean }) {
  const live = state === "running" || state === "research";
  const [elapsed, setElapsed] = React.useState(live ? 13000 : 0);
  React.useEffect(() => {
    if (!live) return;
    const started = Date.now() - 13000;
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [live]);
  const f = React.useMemo(() => fixture(state, state === "research" ? Math.max(0, elapsed - 13000) : elapsed), [state, elapsed]);

  const panel = (
    <ThoughtProcessPanel
      id="tpp-dev"
      messageId="dev-message"
      onClose={() => undefined}
      run={f.run}
      reasoning={f.reasoning}
      streaming={f.streaming}
      live={f.live}
      finishNote={f.finishNote}
    />
  );

  if (mobile) {
    return (
      <div className="@container/split h-dvh w-full bg-background" data-gallery="thinking">
        {panel}
      </div>
    );
  }
  return (
    <div className="@container/split flex h-dvh w-full min-w-[56rem] bg-background" data-gallery="thinking">
      <div className="flex min-w-0 flex-1 items-start justify-center p-10">
        <div className="w-full max-w-[34rem] space-y-3 pt-16">
          <div className="h-3 w-2/3 rounded-full bg-muted" />
          <div className="h-3 w-full rounded-full bg-muted" />
          <div className="h-3 w-5/6 rounded-full bg-muted" />
        </div>
      </div>
      <div className="h-full w-[26rem] shrink-0 border-l border-border/60" data-panel>
        {panel}
      </div>
    </div>
  );
}
