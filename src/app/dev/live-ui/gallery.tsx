"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import { LiveUIHostProvider } from "@/components/chat/live-ui/host";
import { splitMessageContent } from "@/lib/message-content";
import { LEGACY_REPLY, LIVE_UI_SAMPLES, MERMAID_REPLY, type LiveUISample } from "./samples";

function Reply({ sample }: { sample: LiveUISample }) {
  return (
    <section className="flex flex-col gap-4" id={sample.id} data-sample={sample.id}>
      <h2 className="font-mono text-caption font-semibold text-muted-foreground">{sample.label}</h2>
      <p className="ml-auto max-w-[80%] rounded-card bg-muted/60 px-4 py-2.5 text-body">{sample.prompt}</p>
      <LiveUIHostProvider value={{ messageId: `dev-${sample.id}` }}>
        <Markdown content={sample.reply} />
      </LiveUIHostProvider>
    </section>
  );
}

/** A reply saved with the retired `:::` blocks, through the same parts → Markdown path the transcript uses. */
function LegacyReply() {
  const text = splitMessageContent(LEGACY_REPLY.reply)
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
  return (
    <section className="flex flex-col gap-4" id="legacy" data-sample="legacy">
      <h2 className="font-mono text-caption font-semibold text-muted-foreground">Saved before Live UI · old learning blocks, converted</h2>
      <p className="ml-auto max-w-[80%] rounded-card bg-muted/60 px-4 py-2.5 text-body">{LEGACY_REPLY.prompt}</p>
      <LiveUIHostProvider value={{ messageId: "dev-legacy" }}>
        <Markdown content={text} />
      </LiveUIHostProvider>
    </section>
  );
}

function MermaidReply() {
  return (
    <section className="flex flex-col gap-4" id="mermaid" data-sample="mermaid">
      <h2 className="font-mono text-caption font-semibold text-muted-foreground">Mermaid, fitted and themed</h2>
      <Markdown content={MERMAID_REPLY} />
    </section>
  );
}

/** Replays a reply at roughly model speed, through the streaming path. */
function StreamingReplay({ sample }: { sample: LiveUISample }) {
  const [length, setLength] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setLength((n) => {
        const next = Math.min(sample.reply.length, n + 18);
        if (next >= sample.reply.length) setRunning(false);
        return next;
      });
    }, 45);
    return () => window.clearInterval(timer);
  }, [running, sample.reply.length]);
  const streaming = running || (length > 0 && length < sample.reply.length);
  return (
    <section className="flex flex-col gap-4" id="streaming" data-sample="streaming">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-mono text-caption font-semibold text-muted-foreground">Simulated streaming · {sample.label}</h2>
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Stream position"
            min={0}
            max={sample.reply.length}
            value={length}
            onChange={(e) => {
              setRunning(false);
              setLength(Number(e.target.value));
            }}
            className="w-40"
            data-stream-scrub=""
          />
          <button
            type="button"
            className="h-8 rounded-control border border-border px-3 text-ui hover:bg-accent"
            onClick={() => {
              setLength(0);
              setRunning(true);
            }}
          >
            Replay
          </button>
        </div>
      </div>
      <LiveUIHostProvider value={{ messageId: "dev-streaming" }}>
        <Markdown content={sample.reply.slice(0, length)} streaming={streaming} />
      </LiveUIHostProvider>
    </section>
  );
}

export function LiveUIGallery() {
  const [sent, setSent] = React.useState<string | null>(null);
  const onPrompt = React.useCallback((text: string) => setSent(text), []);
  return (
    <LiveUIHostProvider value={{ onPrompt }}>
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-14 px-4 py-10">
        <header>
          <p className="font-mono text-caption font-semibold text-primary">Dev gallery</p>
          <h1 className="pt-1 font-sans text-page-title font-semibold tracking-tight">Live UI</h1>
          <p className="pt-1 text-ui text-muted-foreground">
            Interactive views inside answers, through the chat&apos;s real Markdown path at transcript width.
          </p>
          {sent ? (
            <p className="mt-3 text-ui" role="status">
              <span className="text-muted-foreground">Would send: </span>
              {sent}
            </p>
          ) : null}
        </header>
        {LIVE_UI_SAMPLES.map((sample) => (
          <Reply key={sample.id} sample={sample} />
        ))}
        <LegacyReply />
        <MermaidReply />
        <StreamingReplay sample={LIVE_UI_SAMPLES[0]} />
      </main>
    </LiveUIHostProvider>
  );
}
