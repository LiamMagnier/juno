"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Check, Eye, Info, Plus, RotateCcw, Target, TriangleAlert, X, Zap } from "@/components/ui/icons";
import type { LiveCalloutTone, LiveComponent } from "@/lib/live-ui/spec";
import { cn } from "@/lib/utils";

/*
 * The Live UI components that teach rather than calculate: a guided
 * walkthrough (steps), a self-check (quiz), a key idea (callout) and an
 * ordered process (timeline). docs/design/LIVE_UI.md §2.
 *
 * Same grammar as the rest of Live UI: no card fill, structure from hairlines
 * and type, two weights. Newsreader carries the one display moment in each (a
 * step's title, a question, a key idea), the accent appears only on progress,
 * and motion only answers the reader (a step arriving from the side it was
 * asked for, a wrong answer's single nudge).
 */

type Steps = Extract<LiveComponent, { type: "steps" }>;
type Quiz = Extract<LiveComponent, { type: "quiz" }>;
type Callout = Extract<LiveComponent, { type: "callout" }>;
type Timeline = Extract<LiveComponent, { type: "timeline" }>;

/** Interpolates `{{expr}}` in authored text against the view's scope. */
type Interp = (text: string) => string;

// ── Shared pieces ───────────────────────────────────────────────────────────

/** Segmented progress: one hairline per step, the done ones inked. */
function Segments({
  count,
  current,
  state,
  onSelect,
  labels,
}: {
  count: number;
  current: number;
  /** Per segment: done, missed (a wrong answer) or upcoming. */
  state: (index: number) => "done" | "missed" | "todo";
  onSelect?: (index: number) => void;
  labels: (index: number) => string;
}) {
  return (
    <div className="flex items-center gap-1" role={onSelect ? "group" : undefined} aria-label={onSelect ? "Steps" : undefined}>
      {Array.from({ length: count }, (_, i) => {
        const s = state(i);
        const bar = (
          <span
            aria-hidden
            className={cn(
              "block h-[3px] w-full rounded-full transition-colors duration-base ease-out-soft motion-reduce:transition-none",
              i === current ? "bg-primary" : s === "done" ? "bg-foreground/55" : s === "missed" ? "bg-destructive/45" : "bg-foreground/[0.1]",
            )}
          />
        );
        return onSelect ? (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(i)}
            aria-label={labels(i)}
            aria-current={i === current ? "step" : undefined}
            className="group flex h-5 min-w-0 flex-1 items-center rounded-full outline-offset-2"
          >
            {bar}
          </button>
        ) : (
          <span key={i} className="flex h-5 min-w-0 flex-1 items-center">
            {bar}
          </span>
        );
      })}
    </div>
  );
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-fit items-center gap-1.5 rounded-control py-1 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none coarse:min-h-11"
      >
        {label}
        <Plus aria-hidden motion="none" className={cn("size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none", open && "rotate-45")} />
      </button>
      <div
        id={id}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-base ease-out-soft motion-reduce:[transition-property:opacity]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

const navButton =
  "inline-flex h-9 items-center gap-1.5 rounded-control px-3 text-ui transition-colors duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11 disabled:pointer-events-none disabled:opacity-40";

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * A guided walkthrough. The step list sits beside the stage once there is
 * room (a map you can jump around), and collapses to the segmented rail at
 * phone width. Each step can carry its own visual — any Live UI components —
 * a "notice" line saying what to look at, and optional detail. The takeaway
 * lands when the reader reaches the end.
 */
export function LiveSteps({
  steps,
  interp,
  renderUI,
}: {
  steps: Steps;
  interp: Interp;
  renderUI: (list: readonly LiveComponent[]) => React.ReactNode;
}) {
  const total = steps.steps.length;
  const [active, setActive] = React.useState(0);
  const [reached, setReached] = React.useState(0);
  const dir = React.useRef(1);
  const step = steps.steps[Math.min(active, total - 1)];
  const last = active === total - 1;
  const finished = reached >= total - 1 && last;

  const go = React.useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(total - 1, next));
      dir.current = clamped >= active ? 1 : -1;
      setActive(clamped);
      setReached((r) => Math.max(r, clamped));
    },
    [active, total],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(active + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(active - 1);
    }
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-5 rounded-control outline-offset-4"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-roledescription="walkthrough"
      aria-label={steps.title ? interp(steps.title) : "Walkthrough"}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-ui font-medium text-foreground">{steps.title ? interp(steps.title) : null}</p>
          <p className="shrink-0 text-ui tabular-nums text-muted-foreground">
            {active + 1} of {total}
          </p>
        </div>
        <div className="@[40rem]:hidden">
          <Segments
            count={total}
            current={active}
            state={(i) => (i <= reached ? "done" : "todo")}
            onSelect={go}
            labels={(i) => `Step ${i + 1}: ${steps.steps[i].title}`}
          />
        </div>
      </div>

      <div className="grid min-w-0 gap-8 @[40rem]:grid-cols-[12rem_minmax(0,1fr)]">
        <ol className="hidden min-w-0 flex-col @[40rem]:flex" aria-label="Steps">
          {steps.steps.map((s, i) => {
            const on = i === active;
            const done = i < active || (i <= reached && i !== active);
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={on ? "step" : undefined}
                  className={cn(
                    "group relative grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-baseline gap-2 py-2 pl-3 text-left transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
                    "before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:transition-colors before:duration-base",
                    on ? "before:bg-primary" : "before:bg-transparent hover:before:bg-foreground/15",
                  )}
                >
                  <span className={cn("text-caption tabular-nums", on ? "text-foreground" : "text-muted-foreground")}>
                    {done ? <Check aria-hidden className="inline-block size-3.5 align-[-2px] text-muted-foreground" /> : String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={cn("min-w-0 text-ui leading-snug", on ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                    {s.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div
          key={active}
          className="flex min-w-0 flex-col gap-4 motion-safe:animate-stage-in"
          style={{ "--stage-dx": dir.current > 0 ? "12px" : "-12px" } as React.CSSProperties}
          aria-live="polite"
        >
          <div className="flex flex-col gap-2">
            <h5 className="font-serif text-[1.375rem] font-normal leading-[1.2] tracking-[-0.01em] text-foreground">{step.title}</h5>
            {step.summary ? <p className="text-body leading-7 text-foreground/85">{interp(step.summary)}</p> : null}
          </div>

          {step.ui.length ? <div className="flex min-w-0 flex-col gap-5 py-1">{renderUI(step.ui)}</div> : null}

          {step.notice ? (
            <p className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-ui leading-6">
              <Eye aria-hidden className="mt-1 size-3.5 text-muted-foreground" />
              <span className="min-w-0 text-foreground/80">
                <span className="font-medium text-foreground">Notice </span>
                {interp(step.notice)}
              </span>
            </p>
          ) : null}

          {step.detail ? (
            <Disclosure label="More detail">
              <p className="whitespace-pre-line border-l border-border pl-4 pt-1 text-ui leading-relaxed text-foreground/85">{interp(step.detail)}</p>
            </Disclosure>
          ) : null}

          {finished && steps.takeaway ? (
            <p className="border-l-2 border-primary/70 pl-4 font-serif text-[1.125rem] italic leading-relaxed text-foreground/90 motion-safe:animate-fade-in-up">
              {interp(steps.takeaway)}
            </p>
          ) : null}
        </div>
      </div>

      {total > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
          <button type="button" onClick={() => go(active - 1)} disabled={active === 0} className={cn(navButton, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back
          </button>
          {last ? (
            <button type="button" onClick={() => go(0)} className={cn(navButton, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              <RotateCcw aria-hidden className="size-3.5" />
              Start over
            </button>
          ) : (
            <button
              type="button"
              onClick={() => go(active + 1)}
              className={cn(navButton, "max-w-[70%] bg-foreground text-background hover:bg-foreground/85")}
            >
              <span className="truncate">Next: {steps.steps[active + 1].title}</span>
              <ArrowRight aria-hidden className="size-3.5 shrink-0" />
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Quiz ────────────────────────────────────────────────────────────────────

const LETTERS = "ABCDEF";

/**
 * A self-check, answered in place (it never sends a message). One question at
 * a time; choosing locks the answer, marks it, and explains. The end is a
 * score with the questions it came from, and a way to go again.
 */
export function LiveQuiz({ quiz, interp }: { quiz: Quiz; interp: Interp }) {
  const total = quiz.questions.length;
  const [current, setCurrent] = React.useState(0);
  const [answers, setAnswers] = React.useState<(number | null)[]>(() => quiz.questions.map(() => null));
  const [done, setDone] = React.useState(false);
  const q = quiz.questions[Math.min(current, total - 1)];
  const chosen = answers[current];
  const answered = chosen !== null && chosen !== undefined;
  const right = answered && chosen === q.answer;
  const score = answers.filter((a, i) => a === quiz.questions[i].answer).length;

  const reset = () => {
    setAnswers(quiz.questions.map(() => null));
    setCurrent(0);
    setDone(false);
  };

  if (done) {
    return (
      <div className="flex min-w-0 flex-col gap-4" aria-live="polite">
        {quiz.title ? <p className="text-ui font-medium">{interp(quiz.title)}</p> : null}
        <p className="flex items-baseline gap-3">
          <span className="font-serif text-[2.25rem] leading-none tabular-nums text-foreground">
            {score}
            <span className="text-muted-foreground">/{total}</span>
          </span>
          <span className="text-ui text-muted-foreground">{score === total ? "All correct." : score === 0 ? "Worth another look." : "Correct answers."}</span>
        </p>
        <ol className="flex flex-col divide-y divide-border/40 border-y border-border/40">
          {quiz.questions.map((item, i) => {
            const ok = answers[i] === item.answer;
            return (
              <li key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-2.5 py-2.5">
                {ok ? <Check aria-label="Correct" className="size-3.5 text-success-ink" /> : <X aria-label="Missed" className="size-3.5 text-destructive-ink" />}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-ui text-foreground">{interp(item.question)}</span>
                  {!ok ? <span className="text-caption text-muted-foreground">Answer: {item.options[item.answer].label}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={reset} className={cn(navButton, "-ml-3 w-fit text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <RotateCcw aria-hidden className="size-3.5" />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-ui font-medium">{quiz.title ? interp(quiz.title) : total > 1 ? "Check yourself" : null}</p>
          {total > 1 ? (
            <p className="shrink-0 text-ui tabular-nums text-muted-foreground">
              {current + 1} of {total}
            </p>
          ) : null}
        </div>
        {total > 1 ? (
          <Segments
            count={total}
            current={current}
            state={(i) => (answers[i] === null ? "todo" : answers[i] === quiz.questions[i].answer ? "done" : "missed")}
            labels={(i) => `Question ${i + 1}`}
          />
        ) : null}
      </div>

      <p key={current} className="font-serif text-[1.25rem] leading-snug tracking-[-0.005em] text-foreground motion-safe:animate-fade-in">
        {interp(q.question)}
      </p>

      <div role="group" aria-label="Answers" className="flex flex-col gap-1.5">
        {q.options.map((o, i) => {
          const state = !answered ? "idle" : i === q.answer ? "right" : i === chosen ? "wrong" : "dim";
          return (
            <button
              key={`${current}-${i}`}
              type="button"
              aria-disabled={answered}
              aria-pressed={i === chosen}
              onClick={() => {
                if (answered) return;
                setAnswers((prev) => prev.map((a, k) => (k === current ? i : a)));
              }}
              className={cn(
                "grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-3 rounded-control border px-3 py-2.5 text-left transition-[background-color,border-color,opacity] duration-base ease-out-soft motion-reduce:transition-none coarse:min-h-11",
                state === "idle" && "border-border/70 hover:border-foreground/25 hover:bg-accent",
                state === "right" && "border-success/50 bg-success/[0.07]",
                state === "wrong" && "border-destructive/45 bg-destructive/[0.06] motion-safe:animate-nudge",
                state === "dim" && "border-border/50 opacity-55",
                answered && "cursor-default",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border text-caption tabular-nums",
                  state === "right" ? "border-success/60 text-success-ink" : state === "wrong" ? "border-destructive/50 text-destructive-ink" : "border-border text-muted-foreground",
                )}
              >
                {state === "right" ? <Check className="size-3.5 motion-safe:animate-pop-in" /> : state === "wrong" ? <X className="size-3.5 motion-safe:animate-pop-in" /> : LETTERS[i]}
              </span>
              <span className="min-w-0 text-ui leading-snug text-foreground">{o.label}</span>
            </button>
          );
        })}
      </div>

      {q.hint && !answered ? (
        <Disclosure label="Hint">
          <p className="pt-1 text-ui italic leading-relaxed text-muted-foreground">{interp(q.hint)}</p>
        </Disclosure>
      ) : null}

      {answered ? (
        <div className="flex flex-col gap-3 border-t border-border/50 pt-3 motion-safe:animate-fade-in" aria-live="polite">
          <p className="text-ui leading-relaxed text-foreground/85">
            <span className={cn("font-medium", right ? "text-success-ink" : "text-destructive-ink")}>{right ? "Correct." : "Not quite."}</span>{" "}
            {interp(q.options[chosen].explanation ?? q.explanation ?? (right ? "" : `The answer is ${q.options[q.answer].label}.`))}
          </p>
          <div className="flex justify-end">
            {current < total - 1 ? (
              <button type="button" onClick={() => setCurrent((c) => c + 1)} className={cn(navButton, "bg-foreground text-background hover:bg-foreground/85")}>
                Next question
                <ArrowRight aria-hidden className="size-3.5" />
              </button>
            ) : total > 1 ? (
              <button type="button" onClick={() => setDone(true)} className={cn(navButton, "bg-foreground text-background hover:bg-foreground/85")}>
                See your score
                <ArrowRight aria-hidden className="size-3.5" />
              </button>
            ) : (
              <button type="button" onClick={reset} className={cn(navButton, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                <RotateCcw aria-hidden className="size-3.5" />
                Try again
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Callout ─────────────────────────────────────────────────────────────────

const TONE: Record<LiveCalloutTone, { label: string; Icon: typeof Info; rule: string }> = {
  insight: { label: "Key idea", Icon: Target, rule: "border-primary/70" },
  tip: { label: "Tip", Icon: Zap, rule: "border-success/60" },
  warning: { label: "Watch out", Icon: TriangleAlert, rule: "border-warning/70" },
  note: { label: "Note", Icon: Info, rule: "border-foreground/25" },
};

/** One idea, set apart: a ruled margin, its kind in small type, the idea in Newsreader. */
export function LiveCallout({ callout, interp }: { callout: Callout; interp: Interp }) {
  const tone = TONE[callout.tone];
  return (
    <aside className={cn("flex min-w-0 flex-col gap-2 border-l-2 py-0.5 pl-4", tone.rule)}>
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <tone.Icon aria-hidden className="size-3.5" />
        {callout.title ? interp(callout.title) : tone.label}
      </p>
      <p className="whitespace-pre-line font-serif text-[1.125rem] leading-relaxed text-foreground">{interp(callout.text)}</p>
      {callout.more ? (
        <Disclosure label="Read more">
          <p className="whitespace-pre-line pt-1 text-ui leading-relaxed text-foreground/85">{interp(callout.more)}</p>
        </Disclosure>
      ) : null}
    </aside>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

/** Ordered stages on a single rail; a time, when given, sits right of the label. */
export function LiveTimeline({ timeline, interp }: { timeline: Timeline; interp: Interp }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {timeline.title ? <p className="text-ui font-medium">{interp(timeline.title)}</p> : null}
      <ol className="flex min-w-0 flex-col">
        {timeline.items.map((item, i) => {
          const last = i === timeline.items.length - 1;
          return (
            <li key={i} className="relative grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
              {!last ? <span aria-hidden className="absolute bottom-0 left-[0.875rem] top-7 w-px -translate-x-1/2 bg-border" /> : null}
              <span
                aria-hidden
                className="relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full border border-foreground/20 bg-background text-caption tabular-nums text-foreground"
              >
                {i + 1}
              </span>
              <div className={cn("flex min-w-0 flex-col gap-0.5 pt-1", !last && "pb-4")}>
                <p className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 text-ui font-medium text-foreground">{interp(item.label)}</span>
                  {item.time ? <span className="shrink-0 text-ui tabular-nums text-muted-foreground">{item.time}</span> : null}
                </p>
                {item.detail ? <p className="text-ui leading-relaxed text-muted-foreground">{interp(item.detail)}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
