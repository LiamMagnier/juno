"use client";

import * as React from "react";
import { Bell, Check, ChevronRight, Pause, Play, RotateCcw } from "@/components/ui/icons";
import type { LiveComponent } from "@/lib/live-ui/spec";
import { useLiveReport } from "@/components/chat/live-ui/report";
import { cn } from "@/lib/utils";

/**
 * The doing set, round two (docs/design/LIVE_UI.md §2.5): an interval timer
 * and a weekly schedule. Both are things a reader keeps open while they DO
 * what the answer says (the workout, the revision week), so both report what
 * the reader has done back to the conversation (`useLiveReport`, or the
 * view's shared ticks for the schedule).
 */

type Of<T extends LiveComponent["type"]> = Extract<LiveComponent, { type: T }>;

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A short two-note chime on the Web Audio clock; silent where audio is blocked. */
function chime(final: boolean): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const notes = final ? [660, 880, 1320] : [880, 1175];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.34);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // No audio: the ring's pulse still marks the change.
  }
}

/* —————————————————————————————— Timer —————————————————————————————— */

interface TimerState {
  /** Index into the flattened run (round × interval). */
  at: number;
  running: boolean;
  /** Seconds left in the current interval while paused. */
  left: number;
  /** Wall-clock end of the current interval while running. */
  endsAt?: number;
  finished: boolean;
}

/**
 * A ring that empties as the interval runs, the time large in its middle,
 * the interval's name above it and what comes next below. The sequence sits
 * underneath as a rail of segments, each filling as it is done, so the
 * whole workout is visible at a glance. Space starts and pauses. Each
 * interval ends on a chime and a soft pulse of the ring (reduced motion
 * keeps the chime and drops the pulse).
 */
export function LiveTimer({ timer }: { timer: Of<"timer"> }) {
  const run = React.useMemo(() => {
    const out: { label: string; seconds: number; round: number; index: number }[] = [];
    for (let r = 0; r < timer.rounds; r++) timer.intervals.forEach((iv, i) => out.push({ ...iv, round: r + 1, index: i }));
    return out;
  }, [timer]);
  const [s, setS] = React.useState<TimerState>(() => ({ at: 0, running: false, left: run[0]?.seconds ?? 0, finished: false }));
  const [now, setNow] = React.useState(() => Date.now());
  const [sound, setSound] = React.useState(true);
  const [pulse, setPulse] = React.useState(0);
  const soundRef = React.useRef(sound);
  soundRef.current = sound;

  React.useEffect(() => {
    if (!s.running) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [s.running]);

  // Advance when an interval runs out.
  React.useEffect(() => {
    if (!s.running || s.endsAt === undefined || now < s.endsAt) return;
    const next = s.at + 1;
    if (next >= run.length) {
      if (soundRef.current) chime(true);
      setPulse((p) => p + 1);
      setS({ at: run.length - 1, running: false, left: 0, finished: true });
      return;
    }
    if (soundRef.current) chime(false);
    setPulse((p) => p + 1);
    setS({ at: next, running: true, left: run[next].seconds, endsAt: s.endsAt + run[next].seconds * 1000, finished: false });
  }, [now, s, run]);

  const cur = run[s.at];
  const left = s.running && s.endsAt !== undefined ? Math.max(0, (s.endsAt - now) / 1000) : s.left;
  const frac = cur ? 1 - left / cur.seconds : 1;
  const next = run[s.at + 1];
  const started = s.running || s.at > 0 || s.left !== (run[0]?.seconds ?? 0) || s.finished;

  const toggle = React.useCallback(() => {
    setNow(Date.now());
    setS((p) => {
      if (p.finished) return { at: 0, running: true, left: run[0].seconds, endsAt: Date.now() + run[0].seconds * 1000, finished: false };
      if (p.running) return { ...p, running: false, left: Math.max(0, ((p.endsAt ?? Date.now()) - Date.now()) / 1000), endsAt: undefined };
      return { ...p, running: true, endsAt: Date.now() + p.left * 1000 };
    });
  }, [run]);
  const reset = () => setS({ at: 0, running: false, left: run[0]?.seconds ?? 0, finished: false });
  const skip = () => {
    setNow(Date.now());
    setS((p) => {
      const n = p.at + 1;
      if (n >= run.length) return { at: run.length - 1, running: false, left: 0, finished: true };
      return { at: n, running: p.running, left: run[n].seconds, endsAt: p.running ? Date.now() + run[n].seconds * 1000 : undefined, finished: false };
    });
  };

  const total = run.reduce((a, b) => a + b.seconds, 0);
  const doneBefore = run.slice(0, s.at).reduce((a, b) => a + b.seconds, 0);
  const elapsed = s.finished ? total : doneBefore + (cur ? cur.seconds - left : 0);

  useLiveReport(
    `timer:${timer.key}`,
    !started
      ? null
      : s.finished
        ? `${timer.title ?? "Timer"}: finished (${timer.rounds > 1 ? `all ${timer.rounds} rounds, ` : ""}${clock(total)})`
        : `${timer.title ?? "Timer"}: ${s.running ? "running" : "paused"} on "${cur.label}"${timer.rounds > 1 ? `, round ${cur.round} of ${timer.rounds}` : ""}`,
  );

  const size = 176;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div
      className="flex min-w-0 flex-col items-center gap-5"
      onKeyDown={(e) => {
        if (e.key === " " && e.target === e.currentTarget) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      {timer.title ? <p className="self-start text-body font-semibold tracking-[-0.01em]">{timer.title}</p> : null}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--foreground) / 0.07)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--live))"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * Math.min(1, Math.max(0, frac))}
            className={cn("live-timer-ring", s.running && "live-timer-ring-running")}
          />
        </svg>
        <span key={pulse} className={cn("live-timer-pulse pointer-events-none absolute inset-0 rounded-full", pulse === 0 && "hidden")} aria-hidden />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
          <span key={`${s.at}-${s.finished}`} className="live-timer-label max-w-[70%] truncate text-caption font-medium uppercase tracking-[0.06em] text-[hsl(var(--live))]">
            {s.finished ? "Done" : cur.label}
          </span>
          <span className="text-[2.25rem] font-semibold leading-none tabular-nums tracking-[-0.03em]" role="timer" aria-live="off">
            {clock(left)}
          </span>
          <span className="mt-1 text-caption tabular-nums text-muted-foreground">
            {s.finished ? `${clock(total)} total` : timer.rounds > 1 ? `Round ${cur.round} of ${timer.rounds}` : next ? `Next: ${next.label}` : "Last interval"}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" className="live-stepper-btn" onClick={reset} aria-label="Restart" disabled={!started}>
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
        <button type="button" onClick={toggle} className="live-timer-main" aria-label={s.running ? "Pause" : s.finished ? "Run again" : "Start"}>
          {s.running ? <Pause className="size-5" aria-hidden /> : <Play className="size-5 translate-x-px" aria-hidden />}
        </button>
        <button type="button" className="live-stepper-btn" onClick={skip} aria-label="Skip to the next interval" disabled={s.finished}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          className="live-stepper-btn"
          onClick={() => setSound((v) => !v)}
          aria-label={sound ? "Mute the chime" : "Chime between intervals"}
          aria-pressed={sound}
          data-off={sound ? undefined : ""}
        >
          <Bell className={cn("size-3.5", !sound && "opacity-40")} aria-hidden />
        </button>
      </div>

      {run.length > 1 ? (
        <div className="flex w-full min-w-0 flex-col gap-2">
          <div className="flex w-full gap-1" aria-hidden>
            {run.map((iv, i) => {
              const fill = s.finished || i < s.at ? 1 : i === s.at ? Math.min(1, Math.max(0, frac)) : 0;
              return (
                <span
                  key={i}
                  className="relative h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
                  style={{ flexGrow: iv.seconds, flexBasis: 0 }}
                  title={`${iv.label} · ${clock(iv.seconds)}`}
                >
                  <span
                    className={cn("absolute inset-y-0 left-0 rounded-full", iv.index % 2 === 0 ? "bg-[hsl(var(--live))]" : "bg-[hsl(var(--live)/0.45)]")}
                    style={{ width: `${fill * 100}%` }}
                  />
                </span>
              );
            })}
          </div>
          <div className="flex justify-between text-caption tabular-nums text-muted-foreground">
            <span>{clock(elapsed)} done</span>
            <span>{clock(Math.max(0, total - elapsed))} left</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ————————————————————————————— Schedule ————————————————————————————— */

/**
 * A week (or any run of days) as a strip of day tabs, each with a small ring
 * of how much of it is done, over the chosen day's sessions. Ticks live in
 * the view's shared state (like a checklist's), so they persist with the
 * message and travel with the reader's next message.
 */
export function LiveSchedule({
  schedule,
  checked,
  onToggle,
}: {
  schedule: Of<"schedule">;
  checked: readonly number[];
  onToggle: (index: number) => void;
}) {
  const offsets = React.useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const d of schedule.days) {
      out.push(n);
      n += d.items.length;
    }
    return out;
  }, [schedule.days]);
  const total = schedule.days.reduce((a, d) => a + d.items.length, 0);
  const done = checked.filter((i) => i < total).length;
  const dayDone = (d: number) => schedule.days[d].items.filter((_, i) => checked.includes(offsets[d] + i)).length;
  const [day, setDay] = React.useState(() => {
    const open = schedule.days.findIndex((d, di) => d.items.length > 0 && d.items.some((_, i) => !checked.includes(offsets[di] + i)));
    return open < 0 ? 0 : open;
  });
  const tabs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const current = schedule.days[Math.min(day, schedule.days.length - 1)];
  const panelId = React.useId();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        {schedule.title ? <p className="text-body font-semibold tracking-[-0.01em]">{schedule.title}</p> : null}
        <p className="text-ui tabular-nums text-muted-foreground" aria-live="polite">
          {done} of {total} {total === 1 ? "session" : "sessions"} done
        </p>
      </div>
      <div
        role="tablist"
        aria-label={schedule.title ?? "Days"}
        className="live-days -mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const n = (day + (e.key === "ArrowRight" ? 1 : -1) + schedule.days.length) % schedule.days.length;
          setDay(n);
          tabs.current[n]?.focus();
        }}
      >
        {schedule.days.map((d, di) => {
          const count = d.items.length;
          const got = dayDone(di);
          const ratio = count ? got / count : 0;
          const rest = count === 0;
          return (
            <button
              key={di}
              ref={(el) => {
                tabs.current[di] = el;
              }}
              type="button"
              role="tab"
              aria-selected={di === day}
              aria-controls={panelId}
              tabIndex={di === day ? 0 : -1}
              onClick={() => setDay(di)}
              data-active={di === day ? "" : undefined}
              className="live-day snap-start"
            >
              <span className="text-caption font-medium">{d.label}</span>
              <span className="relative flex size-6 items-center justify-center" aria-hidden>
                {rest ? (
                  <span className="size-1.5 rounded-full bg-foreground/20" />
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90">
                      <circle cx="12" cy="12" r="10" fill="none" stroke="hsl(var(--foreground) / 0.1)" strokeWidth="2.5" />
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        fill="none"
                        stroke="hsl(var(--live))"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 10}
                        strokeDashoffset={2 * Math.PI * 10 * (1 - ratio)}
                        className="transition-[stroke-dashoffset] duration-slow ease-out-soft motion-reduce:transition-none"
                      />
                    </svg>
                    {ratio === 1 ? (
                      <Check className="size-3 text-[hsl(var(--live))] motion-safe:animate-pop-in" />
                    ) : (
                      <span className="text-[0.625rem] font-semibold tabular-nums">{count}</span>
                    )}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" key={day} className="flex min-w-0 flex-col motion-safe:animate-fade-in">
        {current.items.length === 0 ? (
          <p className="rounded-card bg-foreground/[0.03] px-4 py-5 text-center text-ui text-muted-foreground">Rest day.</p>
        ) : (
          <ul className="flex flex-col">
            {current.items.map((item, i) => {
              const index = offsets[day] + i;
              const on = checked.includes(index);
              return (
                <li key={i}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => onToggle(index)}
                    className="flex w-full min-w-0 items-start gap-3 rounded-card px-2 py-2.5 text-left transition-colors duration-fast hover:bg-accent coarse:py-3"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border-2 transition-[background-color,border-color,transform] duration-base ease-spring motion-reduce:transition-[background-color,border-color]",
                        on ? "scale-105 border-[hsl(var(--live))] bg-[hsl(var(--live))] text-white" : "border-foreground/30",
                      )}
                    >
                      {on ? <Check className="size-3 motion-safe:animate-pop-in" /> : null}
                    </span>
                    {item.time ? <span className="mt-px w-12 shrink-0 text-ui tabular-nums text-muted-foreground">{item.time}</span> : null}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn("text-ui transition-colors duration-fast", on ? "text-muted-foreground line-through decoration-foreground/30" : "text-foreground")}>
                        {item.label}
                      </span>
                      {item.detail ? <span className="text-caption text-muted-foreground">{item.detail}</span> : null}
                    </span>
                    {item.tag ? <span className="live-tag shrink-0">{item.tag}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
