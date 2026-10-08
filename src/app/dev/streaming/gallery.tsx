"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientActivityEvent, ClientArtifact } from "@/types/chat";
import { BOOTSTRAP, msg } from "../transcript/gallery";

const NO_ARTIFACTS: ClientArtifact[] = [];
const noop = () => {};

const REPLY = `Here is how I would set up the rollout, in the order I would actually do it.

## 1. Measure before you change anything

Pull a week of traffic and split it by route. You want three numbers per route: the **median latency**, the **p95**, and how many requests carry an identical prefix longer than 1,024 tokens. That last one is the number that tells you whether caching will pay for itself.

- Routes with long shared system prompts are the obvious first candidates.
- Retrieval routes are worth a look, but only if the retrieved block is stable across calls.
- Anything that rewrites its prompt per user will see almost no hits, so leave it alone for now.

## 2. Mark the stable prefix

Put everything that does not change at the top of the request and mark the end of it. The cache keys on the exact bytes up to the marker, so a timestamp or a request id above it silently turns every call into a miss.

\`\`\`ts
const response = await client.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: [
    { type: "text", text: STYLE_GUIDE },
    { type: "text", text: PRODUCT_DOCS, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: question }],
});

const { cache_read_input_tokens, cache_creation_input_tokens } = response.usage;
metrics.record({ route, read: cache_read_input_tokens, wrote: cache_creation_input_tokens });
\`\`\`

## 3. Read the numbers back

| Route | Prefix tokens | Hit rate | Cost per 1k calls |
| --- | ---: | ---: | ---: |
| Support answers | 6,240 | 91% | $1.84 |
| Docs search | 3,180 | 64% | $2.71 |
| Onboarding tips | 1,410 | 22% | $3.95 |

> A hit rate under about 30% usually means something above the marker is changing. Diff two raw requests from the same route before tuning anything else.

Once the support route holds above 85% for a few days, move the same pattern to docs search, and only then decide whether onboarding is worth restructuring at all.`;

/** ~6,000 words: the reply's sections, varied and repeated. */
const LONG_REPLY = (() => {
  const parts: string[] = [];
  let words = 0;
  for (let n = 1; words < 6000; n++) {
    const body = REPLY.replace(/^## (\d)\./gm, (_m, d) => `## ${n}.${d}`);
    parts.push(n === 1 ? body : `## Pass ${n}\n\n${body.split("\n").slice(2).join("\n")}`);
    words += body.split(/\s+/).length;
  }
  return parts.join("\n\n");
})();

const ACTIVITY: ClientActivityEvent[] = [
  { id: "a1", kind: "reasoning", title: "Thinking", createdAt: new Date().toISOString() },
  { id: "a2", kind: "search", title: "Searching the web", detail: "prompt caching hit rate", createdAt: new Date().toISOString() },
] as ClientActivityEvent[];

type Speed = "fast" | "slow";

/** A network that delivers text in irregular bursts: sizes 1-90 chars, gaps 15-260 ms. */
function burstPlan(text: string, speed: Speed): { at: number; to: number }[] {
  const plan: { at: number; to: number }[] = [];
  let t = 1600;
  let i = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (i < text.length) {
    const burst = rand() < 0.18 ? 40 + rand() * 50 : 1 + rand() * 14;
    i = Math.min(text.length, i + Math.ceil(burst * (speed === "fast" ? 1.6 : 0.7)));
    t += rand() < 0.12 ? 120 + rand() * 140 : 15 + rand() * 45;
    plan.push({ at: t, to: i });
  }
  return plan;
}

export function StreamingGallery({ autoplay }: { autoplay?: "short" | "long" }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([
    msg({ id: "u1", role: "USER", content: "We are adding prompt caching to the API gateway next week. How should we roll it out?" }),
  ]);
  const [busy, setBusy] = React.useState(false);
  const [speed, setSpeed] = React.useState<Speed>("fast");
  const [stats, setStats] = React.useState<{ frames: number; slow: number; worst: number } | null>(null);
  const timers = React.useRef<number[]>([]);
  const frameLoop = React.useRef(0);

  const stop = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    cancelAnimationFrame(frameLoop.current);
  };
  React.useEffect(() => stop, []);

  const play = React.useCallback((kind: "short" | "long", sp: Speed = speed) => {
    stop();
    const text = kind === "long" ? LONG_REPLY : REPLY;
    const id = `a-${Date.now()}`;
    setBusy(true);
    setMessages((prev) => [prev[0], msg({ id, role: "ASSISTANT", content: "", streaming: true, model: "claude-sonnet-4-5", activity: [] })]);
    const update = (patch: Partial<ChatMessage>) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    timers.current.push(window.setTimeout(() => update({ activity: ACTIVITY.slice(0, 1) }), 300));
    timers.current.push(window.setTimeout(() => update({ activity: ACTIVITY }), 900));
    const plan = burstPlan(text, sp);
    for (const step of plan) {
      timers.current.push(window.setTimeout(() => update({ content: text.slice(0, step.to) }), step.at));
    }
    const end = plan[plan.length - 1].at + 60;
    timers.current.push(
      window.setTimeout(() => {
        update({ streaming: false, content: text, promptTokens: 1840, completionTokens: 702, costUsd: 0.0112 });
        setBusy(false);
      }, end),
    );
    // Frame-time readout for the run.
    let last = performance.now();
    const acc = { frames: 0, slow: 0, worst: 0 };
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      acc.frames++;
      if (dt > 24) acc.slow++;
      acc.worst = Math.max(acc.worst, dt);
      if (acc.frames % 30 === 0) setStats({ ...acc });
      frameLoop.current = requestAnimationFrame(tick);
    };
    frameLoop.current = requestAnimationFrame(tick);
    timers.current.push(window.setTimeout(() => { cancelAnimationFrame(frameLoop.current); setStats({ ...acc }); }, end + 400));
  }, [speed]);

  React.useEffect(() => {
    if (autoplay) play(autoplay);
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h1 className="mr-3 text-ui font-medium">Streamed writing</h1>
          <Button size="sm" onClick={() => play("short")} data-testid="play-short">Play reply</Button>
          <Button size="sm" variant="outline" onClick={() => play("long")} data-testid="play-long">Play 6,000 words</Button>
          <Button size="sm" variant="outline" aria-pressed={speed === "slow"} onClick={() => setSpeed((s) => (s === "fast" ? "slow" : "fast"))}>
            {speed === "fast" ? "Fast model" : "Slow model"}
          </Button>
          <p className="ml-auto font-mono text-label tabular-nums text-muted-foreground" data-testid="frame-stats">
            {stats ? `${stats.frames} frames, ${stats.slow} over 24 ms, worst ${stats.worst.toFixed(0)} ms` : "Scroll up mid-stream to leave the follow."}
          </p>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            busy={busy}
            status={busy ? "writing" : "idle"}
            artifacts={NO_ARTIFACTS}
            onOpenArtifact={noop}
            onRegenerate={noop}
            onFeedback={noop}
            onSpeak={noop}
            conversationTitle="Streaming bench"
          />
        </div>
      </main>
    </AppProvider>
  );
}
