"use client";

import * as React from "react";
import { BookOpen, Compass, Hammer, PenLine } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
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
  icon: typeof PenLine;
}[] = [
  { id: "write", label: "Write", icon: PenLine },
  { id: "learn", label: "Learn", icon: BookOpen },
  { id: "build", label: "Build", icon: Hammer },
  { id: "decide", label: "Decide", icon: Compass },
];

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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** The serif greeting + signature mark — sits above the centered composer. */
export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];

  return (
    <div className="flex flex-col items-center text-center">
      <h1
        className="text-3xl font-serif font-normal tracking-tight motion-safe:animate-rise-in [animation-delay:80ms] [animation-fill-mode:backwards] sm:text-display"
        suppressHydrationWarning
      >
        {greeting()}
        {firstName ? (
          <>
            , <span className="italic text-primary">{firstName}</span>
          </>
        ) : null}
      </h1>
    </div>
  );
}

export function SuggestionPills({ onPick }: { onPick: (text: string) => void }) {
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

  const prompts = React.useMemo(() => (active ? buildPrompts(active, context) : []), [active, context]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 px-3 sm:px-0">
      <div className="flex w-full flex-wrap justify-center gap-2 pb-1">
        {STARTERS.map((starter, i) => {
          const Icon = starter.icon;
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
                "inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border px-3 font-sans text-sm font-medium shadow-soft backdrop-blur transition-all duration-base ease-out-soft [animation-fill-mode:backwards] hover:-translate-y-0.5 hover:shadow-float motion-safe:animate-fade-in sm:h-11 sm:px-4 sm:text-base",
                selected ? "border-primary/40 bg-primary/10 text-foreground" : "border-border/70 bg-card/70 text-foreground/80 hover:bg-accent"
              )}
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              {starter.label}
            </button>
          );
        })}
      </div>

      {active && (
        <div className="grid w-full gap-2 sm:grid-cols-3">
          {prompts.map((prompt, i) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              style={{ animationDelay: `${80 + i * 45}ms` }}
              className="min-h-20 rounded-xl border border-border/70 bg-card/70 px-3.5 py-3 text-left font-sans text-sm leading-5 text-foreground/80 shadow-soft backdrop-blur transition-all duration-base ease-out-soft [animation-fill-mode:backwards] hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent hover:text-foreground hover:shadow-float motion-safe:animate-rise-in"
            >
              <span className="line-clamp-3">{prompt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
