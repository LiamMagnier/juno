"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { ThoughtPanelProvider } from "@/components/chat/thought-panel-context";
import { ToolReceiptList } from "@/components/chat/tool-receipt";
import { ToolRunAnnouncer, ToolRunReceipt } from "@/components/chat/tool-run";
import { CodeActivity } from "@/components/code/code-activity";
import { WorkActivity, WorkCurrentAction, deriveActivity, deriveCurrentAction } from "@/components/work/work-timeline";
import { Button } from "@/components/ui/button";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import {
  pendingRunAnnouncements,
  readToolRun,
  runReceiptParts,
  runSummaryLine,
  type ToolRunPhase,
} from "@/lib/chat/tool-run";
import { TOOL_RUN_FIXTURES as F, type ToolRunFixtureName } from "@/lib/chat/tool-run-fixtures";
import { speechForReply, voiceRunCue, voiceRunOutcome } from "@/lib/chat/tool-run-speech";
import { workRunCapabilityDegraded, workToolFinishedEvents, workToolStartedPayload } from "@/lib/work/tool-run-events";
import type { ClientWorkEvent } from "@/lib/work/serializers";
import type { AppBootstrap } from "@/types/app";
import type { ClientActivityEvent } from "@/types/chat";

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

/** The phases, in the order the design lists them, and whether each is live. */
const PHASES: Array<{ name: ToolRunFixtureName; title: string; live: boolean }> = [
  { name: "queued", title: "Queued", live: true },
  { name: "running", title: "Running, with progress", live: true },
  { name: "awaitingApproval", title: "Waiting for your answer", live: true },
  { name: "succeeded", title: "Succeeded, with files", live: false },
  { name: "failedKeyError", title: "Failed (KeyError, exit 1), cut stderr", live: false },
  { name: "nodeExit3", title: "JavaScript, both streams, exit 3 (V4)", live: false },
  { name: "timedOut", title: "Timed out", live: false },
  { name: "stopped", title: "Stopped", live: false },
  { name: "outcomeUnknown", title: "Outcome unknown", live: false },
  { name: "unavailable", title: "Sandbox unavailable", live: false },
  { name: "missingDependency", title: "Missing package (V6)", live: false },
  { name: "skillRead", title: "Reading a skill", live: true },
  { name: "skillFile", title: "Read a skill file", live: false },
  { name: "skillScript", title: "A skill's script, with its file (V3)", live: false },
  { name: "longOutput", title: "Long output, head and tail", live: false },
  { name: "legacyCodeInterpreter", title: "Pre-rework code_interpreter row", live: false },
  { name: "contractRunning", title: "Tool contract shape: running, progress on the detail", live: true },
  { name: "contractSucceeded", title: "Tool contract shape: succeeded, result text, files without links", live: false },
  { name: "contractOutcomeUnknown", title: "Tool contract shape: failed + outcome_unknown", live: false },
  { name: "contractTimedOut", title: "Tool contract shape: shell script timed out", live: false },
  { name: "contractSkillScript", title: "Tool contract shape: a skill's script by slug", live: false },
];

const T = Date.parse("2026-10-02T09:00:00.000Z");
const at = (s: number) => new Date(T + s * 1000).toISOString();

function turn(...events: ClientActivityEvent[]): ClientActivityEvent[] {
  return [
    { id: "model", kind: "model", title: "Selected model", detail: "Claude Opus 5.5", createdAt: at(0) },
    ...events.map((e, i) => ({ ...e, createdAt: at(1 + i) })),
  ];
}

let workSeq = 0;
function workEvent(kind: ClientWorkEvent["kind"], payload: Record<string, unknown>): ClientWorkEvent {
  workSeq += 1;
  return {
    id: `w${workSeq}`,
    runId: "run-dev",
    seq: workSeq,
    kind,
    payloadVersion: 1,
    visibility: "user",
    payload: payload as ClientWorkEvent["payload"],
    eventKey: null,
    agentId: null,
    createdAt: at(workSeq),
  };
}

function Section({ id, title, children, only }: { id: string; title: string; children: React.ReactNode; only?: string }) {
  if (only && only !== id) return null;
  return (
    <section id={id} data-gallery-section={id} className="mt-12 first:mt-8">
      <h2 className="mb-4 text-heading font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function PhasesSection() {
  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      {PHASES.map(({ name, title, live }) => {
        const view = readToolRun(F[name], { live });
        if (!view) return null;
        return (
          <div key={name} data-phase-fixture={name} className="min-w-0">
            <p className="mb-1 font-mono text-caption text-muted-foreground">
              {title} · phase {view.phase} · {runSummaryLine(view)}
            </p>
            <ToolReceiptList label={title}>
              <ToolRunReceipt view={view} active={live} defaultOpen onRunAgain={() => {}} />
            </ToolReceiptList>
          </div>
        );
      })}
    </div>
  );
}

function StripSection() {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const panel = React.useMemo(
    () => ({ openId, setOpenId, container, seedDraft: (text: string) => setDraft(text), coversChat: () => false }),
    [openId, container],
  );
  return (
    <ThoughtPanelProvider value={panel}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
        <div className="grid gap-8 [&>*]:min-w-0">
          <div data-strip="live">
            <p className="mb-1 font-mono text-caption text-muted-foreground">Live: a run is the turn&apos;s one working row</p>
            <ActivityTimeline messageId="strip-live" events={turn(F.succeeded, F.running)} streaming />
          </div>
          <div data-strip="settled">
            <p className="mb-1 font-mono text-caption text-muted-foreground">Settled: the run&apos;s files above the answer</p>
            <ActivityTimeline messageId="strip-settled" events={turn(F.failedKeyError, F.succeeded)} />
            <p className="text-reading">The West leads at 24,410.75 on average; the chart and the CSV are attached.</p>
          </div>
          <div data-strip="unknown">
            <p className="mb-1 font-mono text-caption text-muted-foreground">Settled: one run, outcome unknown</p>
            <ActivityTimeline messageId="strip-unknown" events={turn(F.outcomeUnknown)} />
          </div>
          {draft ? (
            <p data-seeded-draft className="font-mono text-caption text-muted-foreground">
              Run again seeded: {draft}
            </p>
          ) : null}
        </div>
        <div ref={setContainer} className="min-h-40 rounded-card border border-border/60" aria-label="Thought process dock" />
      </div>
    </ThoughtPanelProvider>
  );
}

function CodeSection() {
  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <div data-code="live">
        <p className="mb-1 font-mono text-caption text-muted-foreground">Live</p>
        <CodeActivity events={[F.skillFile, F.running]} streaming />
      </div>
      <div data-code="settled">
        <p className="mb-1 font-mono text-caption text-muted-foreground">Settled</p>
        <CodeActivity events={[F.failedKeyError, F.succeeded, F.nodeExit3, F.stopped]} />
      </div>
    </div>
  );
}

function OrbitSection() {
  const events = React.useMemo(() => {
    workSeq = 0;
    const failedRun = (F.failedKeyError as unknown as { call: { run: Record<string, unknown> } }).call.run;
    const okRun = (F.succeeded as unknown as { call: { run: Record<string, unknown> } }).call.run;
    const settled: ClientWorkEvent[] = [
      workEvent("step_started", { title: "Summarise revenue by region" }),
      workEvent("tool_started", workToolStartedPayload({ callId: "c1", tool: "run_code", status: "running", run: failedRun })!),
      ...workToolFinishedEvents({ callId: "c1", tool: "run_code", status: "failed", durationMs: 1_108, run: failedRun }).map((e) => workEvent(e.kind, e.payload)),
      workEvent("tool_started", workToolStartedPayload({ callId: "c2", tool: "run_code", status: "running", run: okRun })!),
      ...workToolFinishedEvents({ callId: "c2", tool: "run_code", status: "succeeded", durationMs: 2_412, run: okRun }).map((e) => workEvent(e.kind, e.payload)),
      workEvent("tool_started", workToolStartedPayload({ callId: "c3", tool: "run_code", status: "running", run: { language: "python", context: "hosted_sandbox" } })!),
      ...workToolFinishedEvents({ callId: "c3", tool: "run_code", status: "outcome_unknown", run: { status: "outcome_unknown", language: "python" } }).map((e) => workEvent(e.kind, e.payload)),
    ];
    const degraded = workRunCapabilityDegraded("tool_calling_unverified", { modelLabel: "Kimi K3" });
    const unverified = [workEvent(degraded.kind, degraded.payload)];
    const live = [workEvent("tool_started", workToolStartedPayload({ callId: "c9", tool: "run_code", status: "running", run: { language: "bash", context: "hosted_sandbox" } })!)];
    return { settled, unverified, live };
  }, []);
  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <div data-orbit="current">
        <p className="mb-1 font-mono text-caption text-muted-foreground">Current action while a task runs a script</p>
        <WorkCurrentAction action={deriveCurrentAction(events.live)} />
      </div>
      <div data-orbit="feed">
        <p className="mb-1 font-mono text-caption text-muted-foreground">Task feed: failed, corrected, files, unknown</p>
        <WorkActivity entries={deriveActivity(events.settled)} phase="settled" />
      </div>
      <div data-orbit="degraded">
        <p className="mb-1 font-mono text-caption text-muted-foreground">An unverified model: the existing degradation</p>
        <WorkActivity entries={deriveActivity(events.unverified)} phase="settled" />
      </div>
    </div>
  );
}

function VoiceSection() {
  const rows = PHASES.flatMap(({ name, title, live }) => {
    const view = readToolRun(F[name], { live });
    if (!view) return [];
    const cue = live ? voiceRunCue([view], 5_000, false) : null;
    return [{ name, title, cue, outcome: live ? null : voiceRunOutcome(view) }];
  });
  return (
    <div className="grid gap-4">
      <table className="w-full text-left text-ui" data-voice-table>
        <thead className="text-caption text-muted-foreground">
          <tr>
            <th className="py-1 pr-4 font-medium">Phase</th>
            <th className="py-1 pr-4 font-medium">Spoken phase (after 4 s)</th>
            <th className="py-1 font-medium">Spoken outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-t border-border/60">
              <td className="py-1.5 pr-4">{row.title}</td>
              <td className="py-1.5 pr-4 text-muted-foreground">{row.cue ?? "nothing"}</td>
              <td className="py-1.5 text-muted-foreground">{row.outcome ?? "the reply says it"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-ui" data-voice-readaloud>
        <span className="font-medium">Read aloud:</span>{" "}
        {speechForReply("The West leads at 24,410.75 on average.\n\n```python\nprint(df)\n```", [F.succeeded])}
      </p>
      <p className="text-caption text-muted-foreground">
        The realtime voice call has no tools: every call says it cannot run code and that it can be done in the chat.
      </p>
    </div>
  );
}

/** One run stepping through its phases, as a stream would deliver them. */
const SEQUENCE: Array<{ phase: string; event: ClientActivityEvent }> = [
  { phase: "queued", event: { ...F.queued, id: "seq" } },
  { phase: "running", event: { ...F.running, id: "seq" } },
  {
    phase: "running, more output",
    event: { ...F.running, id: "seq", call: { ...(F.running as unknown as { call: Record<string, unknown> }).call, progress: { seq: 7, lines: ["West     24410.75"], stdoutBytes: 640, stderrBytes: 0 } } } as ClientActivityEvent,
  },
  { phase: "succeeded", event: { ...F.succeeded, id: "seq" } },
];

function LiveSection() {
  const [step, setStep] = React.useState(0);
  const [log, setLog] = React.useState<string[]>([]);
  const seen = React.useRef(new Map<string, ToolRunPhase>());
  const current = SEQUENCE[step];
  const view = readToolRun(current.event, { live: true })!;
  React.useEffect(() => {
    const said = pendingRunAnnouncements([view], seen.current);
    if (said.length) setLog((prev) => [...prev, ...said]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  return (
    <div className="grid gap-3" data-live-sequence>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setStep((s) => Math.min(SEQUENCE.length - 1, s + 1))} disabled={step === SEQUENCE.length - 1}>
          Next frame
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setStep(0);
            setLog([]);
            seen.current = new Map();
          }}
        >
          Restart
        </Button>
        <span className="font-mono text-caption text-muted-foreground">
          frame {step + 1}/{SEQUENCE.length}: {current.phase} · {runReceiptParts(view).label}
        </span>
      </div>
      <ToolReceiptList label="Live run">
        <ToolRunReceipt key={view.phase} view={view} active={view.phase === "running" || view.phase === "queued"} defaultOpen />
      </ToolReceiptList>
      <ToolRunAnnouncer views={[view]} live />
      <div className="rounded-field border border-border/60 px-3 py-2">
        <p className="text-caption font-medium text-muted-foreground">Announced to screen readers (once per phase)</p>
        <ol className="mt-1 list-decimal pl-5 text-ui" data-announcement-log>
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function ToolRunsGallery({ only }: { only?: string }) {
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        <div className="page-gutter mx-auto w-full max-w-5xl py-12">
          <h1 className="font-serif text-page-title">Tool runs</h1>
          <p className="mt-2 max-w-2xl text-ui text-muted-foreground">
            Every phase of a real run on every surface, from the wire fixtures. Words come from lib/chat/tool-run; no status pills, one live mark.
          </p>
          <Section id="phases" title="Every phase, as a chat receipt" only={only}>
            <PhasesSection />
          </Section>
          <Section id="strip" title="The run strip, files and the Thought process" only={only}>
            <StripSection />
          </Section>
          <Section id="code" title="Web Code activity" only={only}>
            <CodeSection />
          </Section>
          <Section id="orbit" title="Orbit: an agent's task" only={only}>
            <OrbitSection />
          </Section>
          <Section id="voice" title="Voice" only={only}>
            <VoiceSection />
          </Section>
          <Section id="live" title="One run, frame by frame, with announcements" only={only}>
            <LiveSection />
          </Section>
        </div>
      </main>
    </AppProvider>
  );
}
