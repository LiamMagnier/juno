"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Markdown } from "@/components/chat/markdown";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { CitationCard } from "@/components/research/citation-card";
import { estimateLine, researchRefusalLine } from "@/components/research/copy";
import { GuideModeSwitch } from "@/components/research/guide-mode-switch";
import { useReportModel } from "@/components/research/report-document";
import { ReportFullscreen } from "@/components/research/report-fullscreen";
import { ResearchFactLine, ResearchReportCard } from "@/components/research/report-card";
import { citationPassages } from "@/components/research/report-structure";
import { ResearchPanel } from "@/components/research/research-panel";
import { ResearchRow } from "@/components/research/research-row";
import { HistoricalResearchRunPanel } from "@/components/chat/research-run-panel";
import { ScopeCard } from "@/components/research/scope-card";
import { NOTIFY_ASKED_KEY, draftEstimate, removeQuestion, seedDraft } from "@/components/research/scope-draft";
import { steerTarget, type GuideMode } from "@/components/research/steer";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import type { SplitPane } from "@/hooks/use-split-pane";
import { ACCENT_IDS } from "@/lib/accents";
import { PhraseWithArgs } from "@/lib/i18n-phrase";
import type { ResearchEventDTO } from "@/lib/research/domain";
import { cn } from "@/lib/utils";
import {
  AUDIT,
  CONVERSATION_ID,
  GALLERY_STATES,
  MESSAGE_SOURCES,
  REPORT_MARKDOWN,
  SUMMARY,
  fixturesFor,
  isGalleryState,
  summaryOf,
  type FixtureRun,
  type GalleryState,
} from "./fixtures";

/*
 * `/dev/research` (SPEC §11.2). The research routes need a session and a run
 * row; the fixtures have neither. So, in this dev page only, every request the
 * Research UI makes for a `dev-*` run — the run view and its events, the
 * controls, the plan decisions, steering, discovery, the live list, the
 * citation audit and Keep researching — is answered from `fixtures.ts`, and
 * the real hooks, store and components run unchanged. Controls mutate the
 * fixture in memory, so Pause, Finish now, Start and Cancel can be pressed.
 */

type Entry = { fixture: FixtureRun; openedAt: number; run: ResearchRunView; events: ResearchEventDTO[] };

const REGISTRY = new Map<string, Entry>();
let galleryState: GalleryState = "scope";
let keepCounter = 0;
let extraSeq = 10_000;

function register(state: GalleryState) {
  galleryState = state;
  for (const [id, fixture] of Object.entries(fixturesFor(state))) {
    if (!REGISTRY.has(id)) REGISTRY.set(id, { fixture, openedAt: Date.now(), run: fixture.run, events: fixture.events });
  }
}

/** The run as it stands now: its script's patches whose time has come. */
function current(entry: Entry): Entry {
  const elapsed = Date.now() - entry.openedAt;
  for (const step of entry.fixture.script ?? []) {
    if (elapsed < step.afterMs) continue;
    entry.run = { ...entry.run, ...step.patch };
    if (step.events) entry.events = [...entry.events, ...step.events.filter((e) => !entry.events.some((x) => x.seq === e.seq))];
  }
  entry.fixture = { ...entry.fixture, script: (entry.fixture.script ?? []).filter((s) => elapsed < s.afterMs) };
  return entry;
}

function view(entry: Entry, after = 0) {
  const events = entry.events.filter((e) => e.seq > after);
  const maxSeq = entry.events.reduce((m, e) => Math.max(m, e.seq), 0);
  return { run: entry.run, events, lastSeq: events.at(-1)?.seq ?? after, maxSeq };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function event(kind: ResearchEventDTO["kind"], payload: Record<string, unknown> = {}): ResearchEventDTO {
  extraSeq += 1;
  return { id: `dev-x${extraSeq}`, seq: extraSeq, kind, payload, createdAt: new Date().toISOString() };
}

function mutate(entry: Entry, path: string, body: Record<string, unknown>): Response {
  const run = entry.run;
  const patch = (next: Partial<ResearchRunView>, kinds: ResearchEventDTO[] = []) => {
    entry.run = { ...entry.run, ...next };
    entry.events = [...entry.events, ...kinds];
  };
  if (path === "/plan") {
    const questions = Array.isArray(body.questions)
      ? (body.questions as Array<{ id?: string; question: string }>).map((q, i) => ({ id: q.id ?? `new${i}`, question: q.question, status: "pending" as const }))
      : run.questions;
    if (body.decision === "confirm") patch({ state: "investigating", phase: "searching", phaseDetail: { query: "heat pump COP -20" }, questions, live: true }, [event("plan_confirmed")]);
    else if (body.decision === "cancel") patch({ state: "cancelled", phase: "stopped", live: false }, [event("cancelled")]);
    else if (body.decision === "revise") {
      patch({ revising: true, questions });
      window.setTimeout(() => patch({ revising: false }, [event("plan_revised")]), 2_500);
    }
  } else if (path === "/control") {
    if (body.action === "pause") patch({ state: "paused", phase: "paused" }, [event("paused")]);
    else if (body.action === "resume") patch({ state: "investigating", phase: "searching" }, [event("resumed")]);
    else if (body.action === "finish") patch({ finishRequested: true });
    else if (body.action === "cancel") patch({ state: "cancelled", phase: "stopped", live: false }, [event("cancelled")]);
  } else if (path === "/steer") {
    const text = typeof body.guidance === "string" ? body.guidance : "";
    patch({ steering: [...(run.steering ?? []), { text, appliedAtRound: null, createdAt: new Date().toISOString() }] });
    return json({ queued: true, appliesAt: "next_round", ...view(entry) });
  } else if (path === "/clarify") {
    patch({ state: "awaiting_plan_confirmation", phase: "awaiting_start" });
  }
  return json(view(entry));
}

function answer(url: URL, init?: RequestInit): Response | null {
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/research/citations") {
    const messageId = url.searchParams.get("messageId") ?? "";
    return messageId.startsWith("dev-msg-") ? json({ audit: { ...AUDIT, runId: messageId.slice("dev-msg-".length) } }) : null;
  }
  if (url.pathname === "/api/research") {
    if (method === "POST") {
      if (galleryState === "refused-budget") {
        return json({ error: "research.budget", reason: "budget", params: { resetsOn: "2026-10-01T00:00:00.000Z" } }, 402);
      }
      if (galleryState === "refused-live-runs") return json({ error: "research.live_runs", reason: "live_runs" }, 429);
      keepCounter += 1;
      const id = `dev-keep-${keepCounter}`;
      const [fixture] = Object.values(fixturesFor("scope"));
      const run = { ...fixture.run, id, goal: JSON.parse(String(init?.body ?? "{}")).goal ?? fixture.run.goal };
      REGISTRY.set(id, { fixture: { ...fixture, run }, openedAt: Date.now(), run, events: fixture.events });
      return json(view(REGISTRY.get(id)!), 201);
    }
    const rows = [...REGISTRY.values()].map((entry) => summaryOf(current(entry).run));
    return json(url.searchParams.get("live") === "1" ? rows : rows.filter((r) => r.conversationId === url.searchParams.get("conversationId")));
  }
  const match = /^\/api\/research\/(dev-[\w-]+)(\/(plan|control|steer|clarify))?$/.exec(url.pathname);
  if (!match) return null;
  const entry = REGISTRY.get(match[1]);
  if (!entry) return json({ error: "Not found" }, 404);
  current(entry);
  if (method === "POST" && match[2]) return mutate(entry, match[2], JSON.parse(String(init?.body ?? "{}")));
  return json(view(entry, Number(url.searchParams.get("after") ?? 0)));
}

if (typeof window !== "undefined" && !(window as unknown as { __junoResearchShim?: boolean }).__junoResearchShim) {
  (window as unknown as { __junoResearchShim?: boolean }).__junoResearchShim = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handled = answer(new URL(raw, window.location.origin), init);
    return handled ?? original(input, init);
  };
}

// ── The gallery ───────────────────────────────────────────────────────────────

const WIDTHS = [375, 800, 1440] as const;
const FAKE_PANE: SplitPane = {
  width: null,
  bounds: { minWidth: 360, maxWidth: 720 },
  resizing: false,
  reset: () => {},
  reclamp: () => {},
  separatorProps: {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuenow": 480,
    "aria-valuemin": 360,
    "aria-valuemax": 720,
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    onPointerCancel: () => {},
    onLostPointerCapture: () => {},
    onDoubleClick: () => {},
    onKeyDown: () => {},
  },
};

function Toggle<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange(v: NoInfer<T>): void }) {
  return (
    <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
      {label}
      <select className="rounded-control border border-border bg-background px-1.5 py-1 text-caption text-foreground" value={String(value)} onChange={(e) => onChange(options.find((o) => String(o) === e.target.value) as T)}>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What the page shows about motion and the loop arbiter (§11, §7.9.1). */
function Readout() {
  const [numbers, setNumbers] = React.useState({ animations: 0, owners: 0 });
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setNumbers({
        animations: typeof document.getAnimations === "function" ? document.getAnimations().length : 0,
        owners: document.querySelectorAll("[data-run-loop-owner]").length,
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="font-mono text-caption text-muted-foreground">
      animations {numbers.animations} (≤ 20) · loop owners {numbers.owners} (1 while anything works)
    </p>
  );
}

function CompletionMessage({ runId, onOpen }: { runId: string; onOpen(runId: string, view: "report" | "progress"): void }) {
  const { run } = useResearchRun(runId);
  if (!run || !run.report) return null;
  return (
    <div className="space-y-3 motion-safe:animate-fade-in">
      <ResearchFactLine
        fact={{
          key: "research",
          runId,
          title: run.title ?? "",
          workedMs: run.workingMs ?? 0,
          cited: run.counts?.cited ?? 0,
          read: run.counts?.read ?? 0,
          pages: run.counts?.pages ?? 0,
          leadModel: run.leadModel?.label ?? "",
          state: run.state === "partially_completed" ? "partially_completed" : "completed",
        }}
        onOpen={(id) => onOpen(id, "report")}
      />
      <div lang={run.language ?? undefined}>
        <Markdown content={SUMMARY} sources={MESSAGE_SOURCES} className="text-reading" />
      </div>
      <ResearchReportCard
        identifier={`research-report-${runId}`}
        title={run.title ?? ""}
        content={REPORT_MARKDOWN}
        sources={MESSAGE_SOURCES}
        onOpenReport={(id) => onOpen(id, "report")}
      />
    </div>
  );
}

function AutoFullscreen({ runId }: { runId: string }) {
  const { run } = useResearchRun(runId);
  const model = useReportModel(run);
  const [open, setOpen] = React.useState(true);
  if (!run) return null;
  return <ReportFullscreen run={run} model={model} open={open} onOpenChange={setOpen} />;
}

function SteerComposer({ runId }: { runId: string }) {
  const { run } = useResearchRun(runId);
  const [mode, setMode] = React.useState<GuideMode>("ask");
  const [text, setText] = React.useState("");
  const target = steerTarget(mode, run, text);
  return (
    <div className="space-y-2 rounded-card border border-border/70 bg-card p-3">
      <GuideModeSwitch mode={mode} onModeChange={setMode} />
      <input
        className="w-full rounded-sm border border-input bg-background px-3 py-2 text-ui"
        placeholder={mode === "guide" ? "Add guidance for the research…" : "Ask Juno…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="font-mono text-caption text-muted-foreground">
        send → {target.kind === "research" ? `POST ${target.url} ${JSON.stringify(target.body)}` : "POST /api/chat"}
      </p>
    </div>
  );
}

function ScopeEditedNote({ runId }: { runId: string }) {
  const { run } = useResearchRun(runId);
  if (!run) return null;
  const draft = seedDraft(run, 0);
  const fewer = removeQuestion(removeQuestion(draft, draft.questions[0].key), draft.questions[1].key);
  const before = draftEstimate(draft, run);
  const after = draftEstimate(fewer, run);
  return (
    <div className="space-y-1 rounded-card border border-dashed border-border p-3 text-caption text-muted-foreground">
      <p>Edit the card above: the estimate recomputes client-side. With all four questions, then with two:</p>
      {before && <PhraseWithArgs spec={estimateLine(before)} className="block" />}
      {after && <PhraseWithArgs spec={estimateLine(after)} className="block" />}
    </div>
  );
}

export function ResearchGallery() {
  const params = useSearchParams();
  const requested = params.get("state");
  const state: GalleryState = isGalleryState(requested) ? requested : "scope";
  const runIds = React.useMemo(() => {
    register(state);
    return Object.keys(fixturesFor(state));
  }, [state]);
  const runId = runIds[0];

  const { setTheme, resolvedTheme } = useTheme();
  const requestedWidth = WIDTHS.find((w) => String(w) === params.get("width"));
  const [width, setWidth] = React.useState<(typeof WIDTHS)[number]>(requestedWidth ?? (state === "mobile-scope" ? 375 : 1440));
  const [locale, setLocale] = React.useState<"en" | "de">("en");
  const [dir, setDir] = React.useState<"ltr" | "rtl">("ltr");
  const [accent, setAccent] = React.useState<string>("coral");
  const [textSize, setTextSize] = React.useState<16 | 20>(16);
  const [reduced, setReduced] = React.useState<"off" | "on">("off");
  const [shell, setShell] = React.useState<"frame" | "shell">("frame");
  // "chat" is what the conversation mounts (ResearchRunPanel: the live Deep
  // Field console, the gates and the finished recap); "legacy" is the older
  // row + side panel set kept for comparison until it is removed.
  const surface: "chat" | "legacy" = params.get("surface") === "legacy" ? "legacy" : "chat";

  const gateStates: GalleryState[] = ["planning", "scope", "scope-edited", "tiny", "revising", "scope-not-at-tail", "notify-prompt", "mobile-scope"];
  const doneStates: GalleryState[] = ["completed", "report-fullscreen", "citation-card", "export", "refused-budget", "refused-live-runs", "partial"];
  const [panel, setPanel] = React.useState<{ runId: string; view: "progress" | "sources" | "plan" | "report" | "details" } | null>(null);
  React.useEffect(() => {
    setPanel(surface === "chat" || gateStates.includes(state) ? null : { runId, view: doneStates.includes(state) ? "report" : "progress" });
    if (state === "notify-prompt") {
      try {
        window.localStorage.removeItem(NOTIFY_ASKED_KEY);
      } catch {
        // Storage refused: the line may not show.
      }
    }
    // The lists are constants of this component; the state and run decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, runId, surface]);

  React.useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.fontSize = `${textSize}px`;
  }, [locale, accent, textSize]);

  const open = (id: string, view: "progress" | "sources" | "plan" | "report" | "details") => setPanel({ runId: id, view });

  return (
    <div dir={dir} data-motion={reduced === "on" ? "reduce" : undefined} className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 space-y-2 border-b border-border/70 bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-heading font-semibold">Research — dev gallery</h1>
          <Readout />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle label="theme" value={(resolvedTheme ?? "light") as "light" | "dark"} options={["light", "dark"] as const} onChange={(v) => setTheme(v)} />
          <Toggle label="width" value={width} options={WIDTHS} onChange={setWidth} />
          <Toggle label="locale" value={locale} options={["en", "de"] as const} onChange={setLocale} />
          <Toggle label="direction" value={dir} options={["ltr", "rtl"] as const} onChange={setDir} />
          <Toggle label="accent" value={accent} options={ACCENT_IDS} onChange={setAccent} />
          <Toggle label="root text" value={textSize} options={[16, 20] as const} onChange={setTextSize} />
          <Toggle label="reduced motion" value={reduced} options={["off", "on"] as const} onChange={setReduced} />
          <Toggle label="panel" value={shell} options={["frame", "shell"] as const} onChange={setShell} />
          <Link href={`/dev/research?state=${state}${surface === "chat" ? "&surface=legacy" : ""}`} className="text-caption text-muted-foreground underline">
            surface: {surface}
          </Link>
        </div>
        <nav className="flex flex-wrap gap-1">
          {GALLERY_STATES.map((s) => (
            <Link
              key={s}
              href={`/dev/research?state=${s}${surface === "legacy" ? "&surface=legacy" : ""}`}
              className={cn("rounded-full border px-2 py-0.5 font-mono text-caption", s === state ? "border-primary text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {s}
            </Link>
          ))}
        </nav>
        {locale === "de" && (
          <p className="text-caption text-muted-foreground">
            de: numbers, dates and plurals follow the locale; phrases follow once the phrase store can be seeded from RESEARCH_COPY_DE.
          </p>
        )}
      </header>

      <div className="overflow-x-auto p-4">
        <div className="@container/split relative mx-auto flex h-[calc(100dvh-12rem)] min-h-[36rem] overflow-hidden rounded-card border border-border/70" style={{ width }}>
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
                <div className="flex justify-end">
                  <div className={cn(USER_BUBBLE_CLASS, "max-w-[85%]")}>How well do heat pumps work in cold climates?</div>
                </div>
                {runIds.map((id) =>
                  surface === "chat" ? (
                    <HistoricalResearchRunPanel key={id} runId={id} />
                  ) : (
                    <div key={id} className="space-y-3">
                      <ScopeCard runId={id} atTail={state !== "scope-not-at-tail"} />
                      <ResearchRow runId={id} onOpen={open} />
                    </div>
                  ),
                )}
                {state === "scope-not-at-tail" && (
                  <>
                    <div className="flex justify-end">
                      <div className={cn(USER_BUBBLE_CLASS, "max-w-[85%]")}>Meanwhile, what is a COP exactly?</div>
                    </div>
                    <p className="text-reading">The coefficient of performance is the heat delivered per unit of electricity used.</p>
                  </>
                )}
                {state === "scope-edited" && <ScopeEditedNote runId={runId} />}
                {surface === "legacy" && (doneStates.includes(state) || state === "completed-while-panel-open") && <CompletionMessage runId={runId} onOpen={open} />}
                {(state === "refused-budget" || state === "refused-live-runs") && (
                  <p className="text-caption text-warning-foreground">
                    <PhraseWithArgs spec={researchRefusalLine(state === "refused-budget" ? "budget" : "live_runs", state === "refused-budget" ? { resetsOn: "2026-10-01T00:00:00.000Z" } : {})} />
                  </p>
                )}
                {state === "citation-card" && (
                  <div className="w-80 rounded-popover border border-border/70 bg-card p-4">
                    <CitationCard n={1} source={MESSAGE_SOURCES[0]} passages={citationPassages(AUDIT, 1)} language="en" />
                  </div>
                )}
                {state === "report-fullscreen" && <AutoFullscreen runId={runId} />}
              </div>
            </div>
            {(state === "steer-mode" || state === "mobile-scope") && (
              <div className="sticky bottom-0 border-t border-border/70 bg-background px-4 py-3">
                {state === "steer-mode" ? (
                  <SteerComposer runId={runId} />
                ) : (
                  <div className="rounded-card border border-border/70 bg-card px-3 py-3 text-caption text-muted-foreground">Composer dock</div>
                )}
              </div>
            )}
          </div>

          {panel && (
            <div className="h-full w-[min(480px,50%)] shrink-0 border-s border-border/70">
              <ResearchPanel
                runId={panel.runId}
                view={panel.view}
                onViewChange={(view) => setPanel((p) => (p ? { ...p, view } : p))}
                onClose={() => setPanel(null)}
                coversChat={() => width < 800}
                eurPerUsd={0.92}
                shell={shell === "shell" ? { open: true, pane: FAKE_PANE, mode: width < 800 ? "sheet" : "column" } : undefined}
              />
            </div>
          )}
        </div>
      </div>
      <p className="px-4 pb-4 text-caption text-muted-foreground">Conversation {CONVERSATION_ID} · state {state}</p>
    </div>
  );
}
