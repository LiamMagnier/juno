"use client";

import * as React from "react";
import { AgentComputerOverlay } from "@/components/agents/agent-computer";
import { MIRA, miraDetail } from "@/app/dev/agents/fixtures";

const SESSION_ID = "ws_dev_primes";
const RUN_ID = "run_dev_primes";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

type Row = { seq: number; callId: string; stream: "command" | "stdout" | "stderr" | "exit"; text: string; createdAt: string };

/** What the Work runner would have stored for this task's shell calls, by how long the page has been open. */
function shellRows(state: "running" | "empty" | "done", elapsedMs: number): Row[] {
  if (state === "empty") return [];
  const at = new Date().toISOString();
  const rows: Array<Omit<Row, "seq" | "createdAt">> = [
    { callId: "c1", stream: "command", text: `python3 -c "print(','.join(map(str,[2,3,5])))" > primes.csv && cat primes.csv` },
    { callId: "c1", stream: "stdout", text: "2,3,5\n" },
    { callId: "c1", stream: "exit", text: JSON.stringify({ exitCode: 0, timedOut: false, capped: false }) },
    { callId: "c2", stream: "command", text: "python3 -m venv .venv && .venv/bin/pip install --progress-bar off requests" },
    { callId: "c2", stream: "stdout", text: "Collecting requests\n  Downloading requests-2.32.3-py3-none-any.whl (64 kB)\n" },
    { callId: "c2", stream: "stderr", text: "\u001b[33mWARNING: The directory '/home/agent/.cache/pip' is not writable.\u001b[0m\n" },
  ];
  if (state === "done") {
    rows.push(
      { callId: "c2", stream: "stdout", text: "Successfully installed certifi-2024.8.30 charset-normalizer-3.4.0 idna-3.10 requests-2.32.3 urllib3-2.2.3\n" },
      { callId: "c2", stream: "exit", text: JSON.stringify({ exitCode: 0, timedOut: false, capped: false }) },
      { callId: "c3", stream: "command", text: "ls missing-folder" },
      { callId: "c3", stream: "stderr", text: "ls: cannot access 'missing-folder': No such file or directory\n" },
      { callId: "c3", stream: "exit", text: JSON.stringify({ exitCode: 2, timedOut: false, capped: false }) },
      { callId: "c4", stream: "command", text: "yes | head -c 2000000" },
      { callId: "c4", stream: "stdout", text: "y\n".repeat(40) },
      { callId: "c4", stream: "stdout", text: "\n[output continues; the rest is in the result]\n" },
      { callId: "c4", stream: "exit", text: JSON.stringify({ exitCode: 0, timedOut: false, capped: true }) }
    );
  } else {
    const steps = Math.min(8, Math.floor(elapsedMs / 1000));
    for (let i = 1; i <= steps; i += 1) {
      rows.push({ callId: "c2", stream: "stdout", text: `Collecting dependency ${i} of 8\n` });
    }
  }
  return rows.map((row, index) => ({ ...row, seq: index + 1, createdAt: at }));
}

function installFetch(state: "running" | "empty" | "done"): () => void {
  const real = window.fetch;
  const opened = Date.now();
  const inbox: Array<{ name: string; path: string; type: "file"; sizeBytes: number; modifiedAt: string }> = [
    { name: "brief.pdf", path: "/home/agent/work/inbox/brief.pdf", type: "file", sizeBytes: 482_113, modifiedAt: new Date().toISOString() },
  ];
  const session = { id: SESSION_ID, status: state === "done" ? "completed" : "running", title: "Primes", conversationId: MIRA.conversationId, agentId: MIRA.id };
  const run = { id: RUN_ID, sessionId: SESSION_ID, attempt: 1, status: state === "done" ? "completed" : "running", lastSeq: 0 };
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return real(input, init);
    const path = url.pathname;
    const base = `/api/agents/${MIRA.id}`;
    if (path === base) {
      const detail = miraDetail({ computerPolicy: "ask" } as Partial<typeof MIRA>);
      return json({
        ...detail,
        computerConfigured: true,
        computer: { enabled: true, status: "awake", streamOn: true, lastActiveAt: new Date().toISOString(), activeSeconds: 840, hasPoster: false, usingNow: null, error: null },
      });
    }
    if (path === `${base}/computer/shell`) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const rows = shellRows(state, Date.now() - opened).filter((row) => row.seq > after);
      const next = rows.length ? rows[rows.length - 1].seq : after;
      return json({ rows, next, running: false, more: false, runLive: state !== "done" });
    }
    if (path === `${base}/computer/files` && (init?.method ?? "GET") === "POST") {
      const name = decodeURIComponent(new Headers(init?.headers).get("x-file-name") ?? "file");
      const taken = new Set(inbox.map((entry) => entry.name));
      let final = name;
      for (let n = 2; taken.has(final); n += 1) final = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
      inbox.push({ name: final, path: `/home/agent/work/inbox/${final}`, type: "file", sizeBytes: 1024, modifiedAt: new Date().toISOString() });
      return json({ name: final, path: `/home/agent/work/inbox/${final}`, sizeBytes: 1024 });
    }
    if (path === `${base}/computer/files`) {
      const at = url.searchParams.get("path") ?? "/home/agent/work";
      if (at === "/home/agent/work/inbox") return json({ path: at, entries: inbox });
      return json({
        path: "/home/agent/work",
        entries: [
          { name: "inbox", path: "/home/agent/work/inbox", type: "directory", sizeBytes: 0, modifiedAt: new Date().toISOString() },
          { name: "primes.csv", path: "/home/agent/work/primes.csv", type: "file", sizeBytes: 6, modifiedAt: new Date().toISOString() },
        ],
      });
    }
    // The live view never connects on this page: it stays "Connecting…".
    if (path === `${base}/computer/view`) return new Promise<Response>(() => undefined);
    if (path === `${base}/computer/heartbeat`) return json({ computer: null });
    if (path === "/api/work/sessions") return json({ sessions: [session] });
    if (path === `/api/work/sessions/${SESSION_ID}/events`) {
      const frame = `data: ${JSON.stringify({ type: "snapshot", session, run, events: [] })}\n\n`;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame));
          // Left open, as a live run's stream is.
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    }
    if (path.startsWith(`/api/work/sessions/${SESSION_ID}/artifacts`)) return json({ artifacts: [] });
    return json({}, 404);
  };
  return () => {
    window.fetch = real;
  };
}

export function ComputerTerminalStage({ state }: { state: "running" | "empty" | "done" }) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const restore = installFetch(state);
    setReady(true);
    return restore;
  }, [state]);
  if (!ready) return null;
  const agent = { ...MIRA, computer: { enabled: true, status: "awake" as const } } as typeof MIRA;
  return <AgentComputerOverlay agent={agent} open initialMode="watch" onClose={() => {}} />;
}
