"use client";

import * as React from "react";
import { MessageList } from "@/components/chat/message-list";
import { ConversationFind } from "@/components/chat/conversation-find";
import { TooltipProvider } from "@/components/ui/tooltip";
import { focusTranscriptMessage } from "@/lib/chat/transcript-window";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientArtifact } from "@/types/chat";

const artifacts: ClientArtifact[] = [];
const noop = () => {};
const initialMessages: ChatMessage[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `benchmark-${i}`, role: i % 2 ? "ASSISTANT" : "USER",
  createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString(),
  attachments: [], activity: [],
  content: i % 2 ? `Response ${i}. **A measured transcript** preserves the reader's place while work continues.\n\n${"This paragraph includes ordinary detail, [a source](https://example.com), and a clear explanation. ".repeat(i % 5 + 1)}${i % 5 === 0 ? "\n\n```typescript\nconst result = await research.readSources();\nconsole.log(result);\n```" : ""}` : `Question ${i}: ${i === 42 ? "performance-anchor-42" : "How does the conversation keep its place?"}`,
}));

export function TranscriptBenchmark() {
  const [messages, setMessages] = React.useState(initialMessages);
  const [running, setRunning] = React.useState(false);
  const [showFind, setShowFind] = React.useState(false);
  const [report, setReport] = React.useState<object | null>(null);
  // A research/artifact-sized card placed after turn 900 that grows late, like
  // a run expanding or media finishing loading while the reader sits below it.
  const [cardTall, setCardTall] = React.useState(false);
  const inlineRuns = React.useMemo(() => [{
    id: "benchmark-card",
    createdAt: initialMessages[900].createdAt,
    node: <div data-benchmark-card className="mt-5 rounded-card border p-4 text-ui" style={{ height: cardTall ? 640 : 120 }}>Research run fixture{cardTall ? " — expanded" : ""}</div>,
  }], [cardTall]);
  const host = React.useRef<HTMLDivElement>(null);
  const timings = React.useRef<number[]>([]);
  const mount = React.useRef(0);
  const frame = React.useRef(0);
  React.useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const record: React.ProfilerOnRenderCallback = (_id, phase, duration) => {
    if (phase === "mount") mount.current = duration;
    else timings.current.push(duration);
  };
  const measure = () => {
    const sorted = [...timings.current].sort((a, b) => a - b);
    const round = (n: number) => Math.round(n * 100) / 100;
    // Row renders since the stream began (React StrictMode renders twice in
    // development; compare rows with each other, not with the token count).
    const renders = window.__alevrTranscriptRenders ?? {};
    const lastKey = initialMessages[initialMessages.length - 1].id;
    const settled = Object.entries(renders).filter(([key]) => key !== lastKey).map(([, n]) => n);
    setReport({ streamingRowRenders: renders[lastKey] ?? 0, settledRowsRendered: settled.length, maxSettledRowRenders: Math.max(0, ...settled), mountedMessages: host.current?.querySelectorAll("[data-message-id]").length, domElements: host.current?.querySelectorAll("*").length, mountMs: round(mount.current), commits: sorted.length, totalRenderMs: round(sorted.reduce((a, b) => a + b, 0)), p95RenderMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0) });
  };
  const stream = () => {
    timings.current = [];
    window.__alevrTranscriptRenders = {};
    setRunning(true);
    let count = 0;
    const tick = () => {
      count++;
      setMessages((prev) => prev.map((m, i) => i === prev.length - 1 ? { ...m, streaming: count < 120, content: `${initialMessages[i].content}\n\n${"New evidence arrived. ".repeat(count)}` } : m));
      if (count < 120) frame.current = requestAnimationFrame(tick);
      else { setRunning(false); requestAnimationFrame(measure); }
    };
    frame.current = requestAnimationFrame(tick);
  };
  return <TooltipProvider><div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-4 border-b p-4 text-ui">
      <h1>Transcript benchmark · 1,000 messages</h1>
      <button onClick={stream} disabled={running}>{running ? "Streaming…" : "Stream 120 updates"}</button>
      <button onClick={() => setShowFind(!showFind)}>Find in conversation</button>
      <button onClick={() => focusTranscriptMessage("benchmark-42")}>Jump to message 42</button>
      <button onClick={() => focusTranscriptMessage("benchmark-906")}>Jump to message 906</button>
      <button onClick={() => setCardTall((t) => !t)}>Grow card above reader</button>
      <button onClick={measure}>Record measurement</button>
      <button onClick={() => { timings.current = []; setReport(null); }}>Reset measurements</button>
      <span className="text-muted-foreground">Tab to “Read full conversation” for the full-render comparison.</span>
    </header>
    <pre className="h-8 shrink-0 overflow-x-auto border-b p-2 text-caption" aria-label="Performance measurement">{report ? JSON.stringify(report) : "No measurement recorded"}</pre>
    {showFind && <ConversationFind messages={messages} onClose={() => setShowFind(false)} />}
    <div ref={host} className="flex min-h-0 flex-1 flex-col">
      <React.Profiler id="transcript" onRender={record}>
        <MessageList messages={messages} inlineRuns={inlineRuns} artifacts={artifacts} busy={running} onOpenArtifact={noop} onFeedback={noop} conversationTitle="Performance fixture" />
      </React.Profiler>
    </div>
  </div></TooltipProvider>;
}
