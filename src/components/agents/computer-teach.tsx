"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GraduationCap, StopCircle } from "@/components/ui/icons";
import { QuietButton } from "@/components/chat/decision";
import { SkillDraftCard } from "@/components/skills/skill-draft-card";
import { readSkillDraft, type ClientSkillDraft } from "@/lib/skills/teach";
import type { ClientDemonstration, ClientTeachState } from "@/lib/teach/service";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

/*
 * Teach by demonstration in the computer overlay (docs/design/agents-v2/TEACH.md).
 *
 *   Show it how     takes control and starts recording once control is live
 *   Recording your steps · 6 steps   [Stop]      while it records
 *   Turn this into a skill?  6 steps on shop.example.com   [Draft skill] Discard
 *   → the skill draft card (Review opens the Teach page; only its Save writes)
 *
 * Shown only when the server says the switch is on. Every decision is the
 * server's; this file draws it and calls back.
 */

export const TEACH_UI_COPY = {
  showItHow: "Show it how",
  record: "Record steps",
  stop: "Stop",
  recordingTitle: "Recording your steps",
  reviewTitle: "Turn this into a skill?",
  draft: "Draft skill",
  discard: "Discard",
  noSteps: "Nothing was recorded. Click, type and submit in the browser while recording.",
  redactedMessage: "Passwords, codes and card numbers were left out.",
  offlineMessage: `${PRODUCT_NAME} could not be reached. Check your connection and try again.`,
} as const;

type Outcome<T> = { kind: "ok"; value: T } | { kind: "failed"; message: string };

async function teachCall<T>(url: string, body: unknown, pick: (data: Record<string, unknown>) => T): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { kind: "failed", message: TEACH_UI_COPY.offlineMessage };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // An empty body reads as a failure below.
  }
  if (!res.ok) {
    return { kind: "failed", message: typeof data.message === "string" && data.message ? data.message : "Couldn’t do that right now. Try again in a moment." };
  }
  return { kind: "ok", value: pick(data) };
}

function readDemonstration(raw: unknown): ClientDemonstration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    status: r.status === "recording" || r.status === "discarded" ? r.status : "recorded",
    steps: typeof r.steps === "number" ? r.steps : 0,
    site: typeof r.site === "string" ? r.site : null,
    redactions: typeof r.redactions === "number" ? r.redactions : 0,
    truncated: r.truncated === true,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : new Date(0).toISOString(),
    endedAt: typeof r.endedAt === "string" ? r.endedAt : null,
    endReason: typeof r.endReason === "string" ? r.endReason : null,
  };
}

function readTeachState(raw: unknown): ClientTeachState {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { enabled: r.enabled === true, recording: readDemonstration(r.recording), latest: readDemonstration(r.latest) };
}

const teachUrl = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/computer/demonstration`;

/** The overlay's teach state: read when it opens, every few seconds while recording, and after each action. */
export function useComputerTeach(agentId: string, open: boolean) {
  const [state, setState] = React.useState<ClientTeachState>({ enabled: false, recording: null, latest: null });
  const [busy, setBusy] = React.useState<"start" | "stop" | "draft" | "discard" | null>(null);
  const [draft, setDraft] = React.useState<ClientSkillDraft | null>(null);

  const refresh = React.useCallback(async () => {
    const outcome = await teachCall(teachUrl(agentId), undefined, (data) => readTeachState(data.teach));
    if (outcome.kind === "ok") setState(outcome.value);
  }, [agentId]);

  React.useEffect(() => {
    if (!open) return;
    setDraft(null);
    void refresh();
  }, [open, refresh]);

  const recording = state.recording !== null;
  React.useEffect(() => {
    if (!open || !recording) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [open, recording, refresh]);

  const act = async (action: "start" | "stop") => {
    setBusy(action);
    const outcome = await teachCall(teachUrl(agentId), { action }, (data) => readDemonstration(data.demonstration));
    setBusy(null);
    if (outcome.kind === "failed") toast.error(outcome.message);
    await refresh();
    return outcome.kind === "ok";
  };

  const discard = async (demonstrationId: string) => {
    setBusy("discard");
    const outcome = await teachCall(teachUrl(agentId), { action: "discard", demonstrationId }, () => true);
    setBusy(null);
    if (outcome.kind === "failed") toast.error(outcome.message);
    setDraft(null);
    await refresh();
  };

  const draftSkill = async (demonstrationId: string) => {
    setBusy("draft");
    const outcome = await teachCall(`${teachUrl(agentId)}/draft`, { demonstrationId }, (data) => readSkillDraft(data.draft) ?? null);
    setBusy(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    if (outcome.value) setDraft(outcome.value);
  };

  return {
    state,
    busy,
    draft,
    refresh,
    start: () => act("start"),
    stop: () => act("stop"),
    discard,
    draftSkill,
  };
}

export type ComputerTeach = ReturnType<typeof useComputerTeach>;

/** "6 steps on shop.example.com". */
export function demonstrationSummary(demonstration: Pick<ClientDemonstration, "steps" | "site">): string {
  const steps = `${demonstration.steps} step${demonstration.steps === 1 ? "" : "s"}`;
  return demonstration.site ? `${steps} on ${demonstration.site}` : steps;
}

/** The line under the control sentence while recording, with Stop. Plain text: no dot, no pill. */
export function TeachRecordingLine({ teach, className }: { teach: ComputerTeach; className?: string }) {
  const recording = teach.state.recording;
  if (!recording) return null;
  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <p className="flex min-w-0 items-center gap-2 text-ui text-foreground" aria-live="polite">
        <StopCircle className="size-4 shrink-0 text-destructive-ink" aria-hidden="true" />
        <span className="truncate">
          {TEACH_UI_COPY.recordingTitle} · {demonstrationSummary(recording)}
        </span>
      </p>
      <QuietButton type="button" loading={teach.busy === "stop"} onClick={() => void teach.stop()}>
        {TEACH_UI_COPY.stop}
      </QuietButton>
    </div>
  );
}

/** After a recording: "Turn this into a skill?", then the ordinary skill draft card. */
export function TeachReviewCard({ teach, className }: { teach: ComputerTeach; className?: string }) {
  const latest = teach.state.latest;
  if (teach.draft) return <SkillDraftCard draft={teach.draft} className={className} />;
  if (!latest || latest.status !== "recorded") return null;
  return (
    <section aria-label={TEACH_UI_COPY.reviewTitle} className={cn("rounded-field bg-muted px-4 py-3", className)}>
      <div className="flex items-start gap-3">
        <GraduationCap className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-medium text-foreground">{TEACH_UI_COPY.reviewTitle}</h3>
          <p className="mt-px text-ui text-muted-on-fill" translate="no">
            {latest.steps > 0 ? demonstrationSummary(latest) : TEACH_UI_COPY.noSteps}
          </p>
          {latest.redactions > 0 ? <p className="mt-px text-ui text-muted-foreground">{TEACH_UI_COPY.redactedMessage}</p> : null}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 pl-7">
        {latest.steps > 0 ? (
          <Button type="button" size="sm" loading={teach.busy === "draft"} onClick={() => void teach.draftSkill(latest.id)}>
            {TEACH_UI_COPY.draft}
          </Button>
        ) : null}
        <QuietButton type="button" loading={teach.busy === "discard"} onClick={() => void teach.discard(latest.id)}>
          {TEACH_UI_COPY.discard}
        </QuietButton>
      </div>
    </section>
  );
}
