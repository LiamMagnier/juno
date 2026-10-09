"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useSearchParams } from "next/navigation";
import { CodeWorkspace } from "@/components/code/v2/workspace";
import { ConnectionsPanel } from "@/components/code/v2/connections";
import type { WorkspaceModel } from "@/components/code/v2/types";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { queueReducer } from "@/lib/code-v2/composer";
import { STATES, makeActions, stateById, INSTANCES, DEVICE } from "./fixtures";
import "@/components/code/v2/code-v2.css";

/**
 * The /dev/code-v2 gallery: every workspace state over fixture data, live
 * enough to click through (sending appends a turn, approvals resolve, pickers
 * change the selection). `?state=` picks one, `?bare=1` hides this chrome for
 * screenshots, `?theme=dark|light`, `?motion=reduced`.
 */
export function CodeV2Gallery() {
  const params = useSearchParams();
  const { setTheme, resolvedTheme } = useTheme();
  const bare = params.get("bare") === "1";
  const stateId = params.get("state") ?? "streaming";
  const reduced = params.get("motion") === "reduced";
  const [log, setLog] = React.useState<string[]>([]);
  React.useEffect(() => {
    const t = params.get("theme");
    if (t === "dark" || t === "light") setTheme(t);
  }, [params, setTheme]);

  if (stateId === "connections-sheet") {
    return (
      <div className="cv2" style={{ height: "100dvh" }}>
        {!bare && <Chrome current={stateId} theme={resolvedTheme} setTheme={setTheme} log={log} />}
        <ConnectionsPanel
          instances={INSTANCES}
          device={DEVICE}
          keys={[{ provider: "anthropic", hint: "…4f2a", addedAt: new Date(Date.now() - 9 * 864e5).toISOString(), lastUsedAt: new Date(Date.now() - 3 * 36e5).toISOString() }]}
          alevrPlan={{ name: "Plus plan", spentUsd: 12.4, capUsd: 40 }}
          onProbe={async () => undefined}
          onSetup={async () => undefined}
          onManaged={async () => ({})}
        />
      </div>
    );
  }
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      {!bare && <Chrome current={stateId} theme={resolvedTheme} setTheme={setTheme} log={log} />}
      <div style={{ flex: 1, minHeight: 0 }}>
        <LiveState key={stateId} id={stateId} reduced={reduced} onLog={(l) => setLog((x) => [l, ...x].slice(0, 6))} />
      </div>
    </div>
  );
}

function LiveState({ id, reduced, onLog }: { id: string; reduced: boolean; onLog: (l: string) => void }) {
  const fixture = stateById(id);
  const [model, setModel] = React.useState(fixture.model);
  const patch = (f: (m: typeof model) => typeof model) => setModel((m) => f(m));
  const log = (name: string, ...args: unknown[]) => onLog(`${name}(${args.map((a) => JSON.stringify(a)).join(", ").slice(0, 80)})`);
  const base = makeActions(log);
  const now = () => new Date().toISOString();
  const actions: WorkspaceModel["actions"] = {
    ...base,
    send: (text) => {
      log("send", text);
      const turnId = `turn-${Date.now()}`;
      patch((m) => ({
        ...m,
        state: "running",
        items: [
          ...m.items,
          { id: `u-${turnId}`, turnId, kind: "user_message", text, createdAt: now(), delivery: "send" },
          { id: `r-${turnId}`, turnId, kind: "reasoning", text: "", streaming: true, createdAt: now() },
        ] as TurnItem[],
      }));
    },
    queue: (text) => {
      log("queue", text);
      patch((m) => ({ ...m, queue: queueReducer(m.queue, { type: "add", row: { id: `q${Date.now()}`, text } }) }));
    },
    steer: (text) => {
      log("steer", text);
      patch((m) => ({ ...m, items: [...m.items, { id: `s${Date.now()}`, kind: "user_message", text, delivery: "steer", createdAt: now() } as TurnItem] }));
    },
    stop: () => {
      log("stop");
      patch((m) => ({
        ...m,
        state: "idle",
        items: [
          ...m.items.map((i) => (i.kind === "command_execution" && i.status === "running" ? { ...i, status: "interrupted" as const } : i.kind === "reasoning" && i.streaming ? { ...i, streaming: false } : i)),
          { id: `i${Date.now()}`, kind: "interrupt", reason: "user", createdAt: now() } as TurnItem,
        ],
      }));
    },
    respond: (requestId, decision) => {
      log("respond", requestId, decision);
      patch((m) => {
        const items = m.items.map((i) =>
          (i.kind === "approval_request" || i.kind === "user_input_request") && i.requestId === requestId
            ? i.kind === "approval_request"
              ? { ...i, status: "resolved" as const, decision }
              : { ...i, status: "answered" as const }
            : i,
        );
        return { ...m, items, state: items.some((i) => (i.kind === "approval_request" || i.kind === "user_input_request") && i.status === "pending") ? "waiting" : "running" };
      });
    },
    setSelection: (selection) => {
      log("setSelection", selection);
      patch((m) => ({ ...m, selection, routing: { ...m.routing, orchestrator: selection } }));
    },
    setRouting: (routing) => {
      log("setRouting", routing.preset);
      patch((m) => ({ ...m, routing }));
    },
    setRuntimeMode: (runtimeMode) => patch((m) => ({ ...m, runtimeMode })),
    setInteractionMode: (interactionMode) => patch((m) => ({ ...m, interactionMode })),
    editQueued: (qid, text) => patch((m) => ({ ...m, queue: queueReducer(m.queue, { type: "edit", id: qid, text }) })),
    removeQueued: (qid) => patch((m) => ({ ...m, queue: queueReducer(m.queue, { type: "remove", id: qid }) })),
    moveQueued: (qid, to) => patch((m) => ({ ...m, queue: queueReducer(m.queue, { type: "move", id: qid, to }) })),
    steerQueued: (qid) =>
      patch((m) => {
        const row = m.queue.find((q) => q.id === qid);
        if (!row) return m;
        return { ...m, queue: queueReducer(m.queue, { type: "take", id: qid }), items: [...m.items, { id: `s${Date.now()}`, kind: "user_message", text: row.text, delivery: "steer", createdAt: now() } as TurnItem] };
      }),
    keepCandidate: (agentId) =>
      patch((m) => ({ ...m, items: m.items.map((i) => (i.kind === "subagent" && i.agentId === agentId ? { ...i, candidate: { ...i.candidate, kept: true } } : i)) })),
    approvePlan: (itemId, approve) =>
      patch((m) => ({ ...m, state: approve ? "running" : "idle", items: m.items.map((i) => (i.kind === "plan" && i.id === itemId ? { ...i, awaitingApproval: false } : i)) })),
  };
  return (
    <CodeWorkspace
      model={{ ...model, actions }}
      ui={{ ...fixture.ui, ...(typeof window !== "undefined" && window.innerWidth <= 760 ? { dockOpen: false } : {}), reducedMotion: reduced }}
      firstRun={false}
      onProbe={async () => undefined}
      onSetup={async () => undefined}
    />
  );
}

function Chrome({ current, theme, setTheme, log }: { current: string; theme?: string; setTheme: (t: string) => void; log: string[] }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid hsl(var(--border))", fontSize: 12, overflowX: "auto", flex: "none", background: "hsl(var(--muted))" }}>
      {[...STATES.map((s) => ({ id: s.id, label: s.label })), { id: "connections-sheet", label: "Connections (standalone)" }].map((s) => (
        <a
          key={s.id}
          href={`?state=${s.id}`}
          style={{ padding: "2px 8px", borderRadius: 6, whiteSpace: "nowrap", background: s.id === current ? "hsl(var(--selected))" : undefined, color: "hsl(var(--foreground))" }}
        >
          {s.label}
        </a>
      ))}
      <span style={{ flex: 1 }} />
      <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} style={{ whiteSpace: "nowrap" }}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <span style={{ color: "hsl(var(--muted-foreground))", whiteSpace: "nowrap", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }} title={log.join("\n")}>
        {log[0] ?? ""}
      </span>
    </div>
  );
}
