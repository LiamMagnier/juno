"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

type StarterCategory = "write" | "learn" | "build" | "decide";

type StarterContext = {
  firstName?: string;
  memoryHint?: string;
  recentTopic?: string;
  memoryEnabled: boolean;
};

type MemoryResponse = {
  memories?: { content?: string }[];
};

const STARTERS: {
  id: StarterCategory;
  label: string;
}[] = [
  { id: "write", label: "Write" },
  { id: "learn", label: "Learn" },
  { id: "build", label: "Build" },
  { id: "decide", label: "Decide" },
];

function StarterMotionIcon({ kind }: { kind: StarterCategory | "compare" }) {
  const common = {
    "aria-hidden": true,
    className: cn("starter-motion-icon h-4 w-4", `starter-motion-icon--${kind}`),
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "write") {
    return <svg {...common}><path className="starter-icon__pen" d="m12.8 3.2 4 4L7.2 16.8 3 17l.2-4.2zM11.5 4.5l4 4" /><path className="starter-icon__ink" d="M3.5 18h10" opacity=".45" /></svg>;
  }
  if (kind === "learn") {
    return <svg {...common}><path className="starter-icon__page-left" d="M10 16.5c-1.6-1.4-3.7-1.9-6.5-1.6V4.5C6.3 4.2 8.4 4.8 10 6z" /><path className="starter-icon__page-right" d="M10 16.5c1.6-1.4 3.7-1.9 6.5-1.6V4.5C13.7 4.2 11.6 4.8 10 6z" /><path className="starter-icon__learn-line" d="M6 8h2M12 8h2" opacity=".45" /></svg>;
  }
  if (kind === "build") {
    return <svg {...common}><path className="starter-icon__hammer" d="m10.5 3.5 3-2 3 3-2 3-2-2-7.5 9.5-2-2 9.5-7.5z" /><path className="starter-icon__build-spark" d="M14.8 11.5v2M13.8 12.5h2" opacity="0" /></svg>;
  }
  if (kind === "decide") {
    return <svg {...common}><circle cx="10" cy="10" r="7" /><path className="starter-icon__needle" d="m12.7 7.3-1.4 4-4 1.4 1.4-4z" /><circle cx="10" cy="10" r=".7" fill="currentColor" stroke="none" /></svg>;
  }
  return <svg {...common}><rect className="starter-icon__compare-left" x="2.5" y="4" width="6" height="12" rx="1.5" /><rect className="starter-icon__compare-right" x="11.5" y="4" width="6" height="12" rx="1.5" /><path className="starter-icon__compare-scan" d="M5.5 7v6M14.5 7v6" opacity=".35" /></svg>;
}

const FALLBACK_TOPICS: Record<StarterCategory, string> = {
  write: "a message I need to send",
  learn: "something useful for my current work",
  build: "my current project",
  decide: "my next step",
};

function cleanMemory(value?: string) {
  return value?.replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

function promptSubject(category: StarterCategory, ctx: StarterContext) {
  return ctx.recentTopic ?? FALLBACK_TOPICS[category];
}

function buildPrompts(category: StarterCategory, ctx: StarterContext): string[] {
  const subject = promptSubject(category, ctx);
  const name = ctx.firstName ? `${ctx.firstName}, ` : "";
  const memoryLine = ctx.memoryHint
    ? `Use what you remember about me: ${ctx.memoryHint}.`
    : ctx.memoryEnabled
      ? `Use any relevant memory you already have about me.`
      : `Ask one quick question first if you need personal context.`;

  switch (category) {
    case "write":
      return [
        `${name}help me write a clear, polished message about ${subject}. ${memoryLine} Give me a warm version and a direct version.`,
        `Turn this rough idea into concise writing in my voice: ${subject}. ${memoryLine}`,
        `Draft a short update I can send today about ${subject}. Keep it natural, specific, and easy to edit.`,
      ];
    case "learn":
      return [
        `Teach me ${subject} from first principles. ${memoryLine} Start simple, then give me one practical exercise.`,
        `Make a 20-minute learning plan around ${subject}. Use examples that fit my current projects and skill level.`,
        `Quiz me on ${subject} with five questions, then explain the gaps in a friendly way.`,
      ];
    case "build":
      return [
        `Help me build a small, useful version of ${subject}. ${memoryLine} Break it into steps I can ship today.`,
        `Review the architecture for ${subject}. Find the simplest implementation path and the risky parts.`,
        `Write a practical checklist for improving ${subject}, including tests, UX details, and production polish.`,
      ];
    case "decide":
      return [
        `Help me decide what to do next with ${subject}. ${memoryLine} Compare tradeoffs and recommend one path.`,
        `Create a decision matrix for ${subject}. Weight speed, quality, risk, and long-term upside.`,
        `Ask me the fewest questions needed to make a confident decision about ${subject}.`,
      ];
  }
}

// Time-of-day greeting buckets. Each hour range has a few phrases so the welcome
// feels fresh — including playful late-night ones (e.g. "Moonlight chat" at 3am).
const TIME_GREETINGS: { from: number; to: number; phrases: string[] }[] = [
  { from: 0, to: 5, phrases: ["Moonlight chat", "Burning the midnight oil", "Late-night thoughts", "The world's asleep", "Night owl mode", "Can't sleep?"] },
  { from: 5, to: 7, phrases: ["Rise and shine", "Early bird", "Up before the sun", "Dawn patrol"] },
  { from: 7, to: 12, phrases: ["Good morning", "Morning", "Bright and early", "Fresh start", "Rise and grind"] },
  { from: 12, to: 14, phrases: ["Good afternoon", "Midday check-in", "Lunch-hour thoughts"] },
  { from: 14, to: 18, phrases: ["Good afternoon", "Afternoon", "Hitting your stride", "Halfway there"] },
  { from: 18, to: 22, phrases: ["Good evening", "Winding down", "Evening", "Golden hour"] },
  { from: 22, to: 24, phrases: ["Good evening", "Late shift", "Still going", "Night owl"] },
];

function pickGreeting(random: boolean): string {
  const h = new Date().getHours();
  const bucket = TIME_GREETINGS.find((b) => h >= b.from && h < b.to) ?? TIME_GREETINGS[2];
  const idx = random ? Math.floor(Math.random() * bucket.phrases.length) : h % bucket.phrases.length;
  return bucket.phrases[idx];
}

/** The serif greeting + signature mark — sits above the centered composer. */
export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];
  // Deterministic during SSR (stable hydration), then pick a random,
  // time-appropriate phrase once mounted on the client so it varies per visit.
  const [phrase, setPhrase] = React.useState(() => pickGreeting(false));
  React.useEffect(() => setPhrase(pickGreeting(true)), []);

  // The mark's press animation: retrigger the spring-pop keyframe per click.
  const [popping, setPopping] = React.useState(false);

  return (
    <div className="flex flex-col items-center text-center">
      <h1
        className="flex items-center justify-center gap-[0.38em] font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]"
        suppressHydrationWarning
      >
        {/* The bare Juno mark, optically centered on the line (flex, not
            baseline hacks). Springy tilt+grow on hover; a keyframed spring pop
            on click — like Claude's mark. Transform-only, motion-safe gated. */}
        <button
          type="button"
          aria-label="Juno"
          onClick={() => setPopping(true)}
          onAnimationEnd={() => setPopping(false)}
          className={cn(
            "shrink-0 outline-none [animation-fill-mode:backwards] [animation-delay:60ms] motion-safe:animate-rise-in",
            popping && "juno-mark-popping"
          )}
        >
          <JunoMark
            className={cn(
              "h-[0.78em] w-[0.78em] translate-y-[0.02em]",
              "transition-transform duration-base ease-spring motion-reduce:transition-none",
              !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110"
            )}
          />
        </button>
        {/* The greeting and the name rise as two beats rather than one block. */}
        <span className="inline-block [animation-fill-mode:backwards] [animation-delay:60ms] motion-safe:animate-rise-in">
          {phrase}
          {firstName ? "," : null}
        </span>
        {firstName ? (
          <span className="inline-block font-medium italic text-primary [animation-fill-mode:backwards] [animation-delay:180ms] motion-safe:animate-rise-in">
            {firstName}
          </span>
        ) : null}
      </h1>
    </div>
  );
}

export function SuggestionPills({ onPick }: { onPick: (text: string) => void }) {
  const router = useRouter();
  const { user, conversations, settings } = useApp();
  const [active, setActive] = React.useState<StarterCategory | null>(null);
  const [memoryHints, setMemoryHints] = React.useState<string[]>([]);
  const firstName = user.name?.split(" ")[0];

  React.useEffect(() => {
    if (!settings.memoryEnabled) {
      setMemoryHints([]);
      return;
    }

    const controller = new AbortController();
    fetch("/api/memory", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MemoryResponse | null) => {
        const hints = (data?.memories ?? [])
          .map((m) => cleanMemory(m.content))
          .filter((m): m is string => Boolean(m))
          .slice(0, 4);
        React.startTransition(() => setMemoryHints(hints));
      })
      .catch(() => {});

    return () => controller.abort();
  }, [settings.memoryEnabled]);

  const recentTopic = React.useMemo(() => {
    const title = conversations.find((conversation) => conversation.title && conversation.title !== "New chat")?.title;
    return cleanMemory(title);
  }, [conversations]);

  const context = React.useMemo<StarterContext>(
    () => ({
      firstName: firstName || undefined,
      memoryHint: memoryHints[0],
      recentTopic,
      memoryEnabled: settings.memoryEnabled,
    }),
    [firstName, memoryHints, recentTopic, settings.memoryEnabled]
  );

  // Keep the last category's prompts rendered while the grid sweeps closed, so
  // deselecting animates out instead of unmounting in place.
  const lastActiveRef = React.useRef<StarterCategory | null>(null);
  if (active) lastActiveRef.current = active;
  const displayed = active ?? lastActiveRef.current;

  const prompts = React.useMemo(() => (displayed ? buildPrompts(displayed, context) : []), [displayed, context]);

  /*
   * The grid-rows 0fr→1fr expand REQUIRES overflow-hidden to clip the rows while
   * they animate — but that same clip slices the cards' hover shadow flat, which
   * reads as a hard bar across them. `shadow-float` reaches ~40px below a card
   * (0 14px 36px -10px); the previous mitigation was pt-1/pb-1, i.e. 4px, so it
   * never stood a chance.
   *
   * So: clip only WHILE animating, then release. Collapsing re-clips immediately
   * (settled resets with `active`), which is what the animation needs.
   */
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    // duration-base (220ms) + a frame of margin.
    const t = window.setTimeout(() => setSettled(true), 240);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 px-3 sm:px-0">
      <div className="flex w-full flex-wrap justify-center gap-2 pb-1">
        {STARTERS.map((starter, i) => {
          const selected = starter.id === active;
          return (
            <button
              key={starter.id}
              type="button"
              onClick={() => setActive((current) => (current === starter.id ? null : starter.id))}
              aria-pressed={selected}
              aria-expanded={selected}
              style={{ animationDelay: `${180 + i * 45}ms` }}
              className={cn(
                "group inline-flex h-9 shrink-0 items-center gap-2 rounded-[13px] border px-3.5 font-sans text-sm font-medium backdrop-blur",
                "shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] transition-[background-color,border-color,box-shadow,transform] duration-base ease-out-soft",
                "[animation-fill-mode:backwards] hover:shadow-[0_4px_12px_-9px_hsl(var(--foreground)/0.3)] active:scale-[0.98] motion-safe:animate-fade-in motion-reduce:transition-none",
                "sm:h-10 sm:px-4 sm:text-[15px]",
                // Coral is reserved for the SELECTED pill, so hover only lifts.
                selected
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/70 bg-card/70 text-foreground/80 hover:border-border hover:bg-card hover:text-foreground"
              )}
            >
              <span className={cn("transition-colors duration-base", selected ? "text-primary" : "text-muted-foreground group-hover:text-foreground/75")}>
                <StarterMotionIcon kind={starter.id} />
              </span>
              {starter.label}
            </button>
          );
        })}
        {/* Quiet route to the side-by-side view — same chip anatomy, no toggle state. */}
        <button
          type="button"
          onClick={() => router.push("/compare")}
          aria-label="Compare models side by side"
          style={{ animationDelay: `${180 + STARTERS.length * 45}ms` }}
          className="group inline-flex h-9 shrink-0 items-center gap-2 rounded-[13px] border border-border/70 bg-card/60 px-3.5 font-sans text-sm font-medium text-foreground/80 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur transition-[background-color,border-color,box-shadow,color,transform] duration-base ease-out-soft [animation-fill-mode:backwards] hover:border-border hover:bg-card hover:text-foreground hover:shadow-[0_4px_12px_-9px_hsl(var(--foreground)/0.3)] active:scale-[0.98] motion-safe:animate-fade-in motion-reduce:transition-none sm:h-10 sm:px-4 sm:text-[15px]"
        >
          <span className="text-muted-foreground transition-colors duration-base group-hover:text-foreground/75"><StarterMotionIcon kind="compare" /></span>
          Compare
        </button>
      </div>

      <div
        className={cn(
          "grid w-full transition-[grid-template-rows] duration-base ease-out-soft",
          active ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        {/* Clipped only while the row animates — see `settled` above. */}
        <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")} inert={!active}>
          <div className="grid w-full gap-2 py-1 sm:grid-cols-3">
            {prompts.map((prompt, i) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onPick(prompt)}
                style={{ animationDelay: `${80 + i * 45}ms` }}
                // 16px radius: these are cards, not chips — deliberately a step
                // down from the pills' full round and the composer's 28px shell.
                // Hover is a LIFT, not a colour wash: the card brightens toward
                // the card surface and raises its shadow. It used to tint coral
                // (border-primary/35 + bg-accent), which read as a selected
                // state on a merely-hovered card and muddied the warm palette.
                // `relative` + `hover:z-10`: without a stacking order the next
                // card's opaque background paints over this one's shadow, which
                // clips it into a straight edge exactly like the wrapper did.
                className="relative min-h-20 rounded-[15px] border border-border/65 bg-card/60 px-4 py-3.5 text-left font-sans text-sm leading-5 text-foreground/80 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur transition-[background-color,border-color,box-shadow,color,transform] duration-base ease-out-soft [animation-fill-mode:backwards] hover:z-10 hover:border-border hover:bg-card hover:text-foreground hover:shadow-[0_6px_16px_-12px_hsl(var(--foreground)/0.32)] active:scale-[0.99] motion-safe:animate-rise-in motion-reduce:transition-none"
              >
                <span className="line-clamp-3">{prompt}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
