"use client";

/**
 * The Agents panel (REA backlog 10, docs/rea/designs/subagents-and-harness.md
 * §3.3 "Web"): a run's agents as one live roster — the lead on top, each
 * agent under the one that started it — then the selected agent's detail.
 *
 * One view, not three. The roster used to come as a card grid, a tree and an
 * activity feed of the same agents; it is now the tree alone, with the grid's
 * useful parts (the name, what it is doing, how long) on each row. Agents are
 * named for their work (agent-names.ts): "Reset form checker", not "Worker 2".
 * A thin strip under the heading shows the whole run at a glance, one segment
 * per agent, in the same state colours as the rows.
 *
 * Everything shown is derived from the thread's items (agent-tree.ts), so it
 * is exactly as live as the session stream. The controls go through
 * `actions.controlAgent`, which the route wires to the audited agent-control
 * endpoint; none of them can answer an approval or widen an agent's access.
 *
 * Accessibility: a WAI-ARIA tree (roving focus, arrows / Home / End,
 * Left-Right to fold, Enter or Space to select), every state in words as well
 * as a mark, results announced in a polite status line. The one moving mark
 * is the selected live row's (LiveMark); the strip changes colour, never
 * position, so reduced motion has nothing extra to stop.
 */
import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { AgentControlResult, ModelSelection, TurnItem } from "@/lib/code-v2/contracts";
import {
  AGENT_NODE_STATE_LABEL,
  LEAD_NODE_ID,
  budgetFraction,
  buildAgentTree,
  countLive,
  findNode,
  formatTokens,
  isLive,
  treeKey,
  visibleRows,
  type AgentNodeState,
  type AgentTreeNode,
} from "@/lib/code-v2/agent-tree";
import { formatDuration } from "@/lib/code-v2/turns";
import { Glyph, LiveMark } from "./primitives";
import { LogRow, lineFor } from "./thread";
import type { AgentControlRequestInput, WorkspaceModel } from "./types";
import { cn } from "@/lib/utils";
import { useMediaQuery, PHONE_QUERY } from "@/hooks/use-media-query";

/** How the dock names a model (dock.tsx `modelLabelFor`), passed in to keep the two files acyclic. */
export type ModelLabeler = (selection: ModelSelection) => string;

/** Token top-ups a person can pick for one agent (inside agent-core's bounds). */
export const AGENT_TOP_UP_TOKENS = [50_000, 100_000, 200_000] as const;
/** Dollar top-ups for the run's own budget. */
export const RUN_TOP_UP_USD = [1, 5, 10] as const;

/** Spend shown on a row only once it is worth acting on. */
const ROW_METER_FROM = 0.8;

function StateMark({ state, animate }: { state: AgentNodeState; animate?: boolean }) {
  if ((state === "thinking" || state === "tool") && animate) return <LiveMark size={12} />;
  const glyph: Partial<Record<AgentNodeState, string>> = { waiting: "hand", paused: "pause", done: "check", failed: "x-circle", stopped: "stop" };
  const name = glyph[state];
  if (name) return <Glyph name={name} size={12} className="cv2-amark" />;
  return <span className="cv2-adot" data-state={state} aria-hidden="true" />;
}

function elapsedOf(node: AgentTreeNode, now: number): number | undefined {
  if (node.elapsedMs !== undefined) return node.elapsedMs;
  if (!node.startedAt || !isLive(node.state)) return undefined;
  const at = Date.parse(node.startedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined;
}

function Meter({ fraction, label }: { fraction: number | null; label?: string }) {
  if (fraction === null) return null;
  const a11y = label ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(fraction * 100) } : { "aria-hidden": true };
  return (
    <span className="cv2-ameter" {...a11y} data-warn={fraction >= ROW_METER_FROM || undefined}>
      <span style={{ inlineSize: `${Math.round(fraction * 100)}%` }} />
    </span>
  );
}

function spendLine(node: AgentTreeNode): string | null {
  if (node.tokens !== undefined && node.tokenBudget !== undefined) return `${formatTokens(node.tokens)} / ${formatTokens(node.tokenBudget)}`;
  if (node.tokens !== undefined) return formatTokens(node.tokens);
  if (node.costUsd !== undefined && node.budgetUsd !== undefined) return `$${node.costUsd.toFixed(2)} / $${node.budgetUsd.toFixed(2)}`;
  if (node.costUsd !== undefined) return `$${node.costUsd.toFixed(2)}`;
  return null;
}

function nodeFraction(node: AgentTreeNode): number | null {
  return node.tokenBudget !== undefined ? budgetFraction(node.tokens ?? 0, node.tokenBudget) : budgetFraction(node.costUsd ?? 0, node.budgetUsd);
}

interface RowProps {
  node: AgentTreeNode;
  now: number;
  expanded: ReadonlySet<string>;
  focusedId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onFocusRow: (id: string) => void;
  rowRefs: React.MutableRefObject<Map<string, HTMLLIElement>>;
  /** The lead's model, which its row has no item to read from. */
  leadModel: ModelSelection;
  modelLabel: ModelLabeler;
}

function TreeRow({ node, now, expanded, focusedId, selectedId, onSelect, onToggle, onFocusRow, rowRefs, leadModel, modelLabel }: RowProps) {
  const open = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;
  const elapsed = elapsedOf(node, now);
  const spend = spendLine(node);
  const word = AGENT_NODE_STATE_LABEL[node.state];
  const fraction = nodeFraction(node);
  // A Swarm can run each agent on its own model: the row says which, under its clock.
  const selection = node.agent?.model ?? leadModel;
  const model = selection.model ? modelLabel(selection) : "";
  return (
    <li
      ref={(el) => {
        if (el) rowRefs.current.set(node.id, el);
        else rowRefs.current.delete(node.id);
      }}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      aria-label={[node.label, word, node.step === word ? null : node.step, spend ? `${spend}${node.tokens !== undefined ? " tokens" : ""}` : null].filter(Boolean).join(", ")}
      tabIndex={focusedId === node.id ? 0 : -1}
      data-state={node.state}
      data-lead={node.id === LEAD_NODE_ID || undefined}
      className="cv2-aitem"
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(node.id);
      }}
    >
      <div
        className="cv2-anode"
        data-selected={selected || undefined}
        onClick={() => {
          onFocusRow(node.id);
          onSelect(node.id);
        }}
      >
        <span
          className="cv2-atwisty"
          data-open={open || undefined}
          aria-hidden="true"
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            onToggle(node.id);
          }}
        >
          {hasChildren && <Glyph name="chevron-right" size={12} />}
        </span>
        <span className="cv2-amark-slot">
          <StateMark state={node.state} animate={selected} />
        </span>
        <span className="cv2-acol">
          <span className="nm cv2-trunc">{node.label}</span>
          <span className="st cv2-trunc">{node.step}</span>
        </span>
        <span className="cv2-aside" aria-hidden="true">
          <span className="t">{elapsed !== undefined ? formatDuration(elapsed) : ""}</span>
          {fraction !== null && fraction >= ROW_METER_FROM ? <Meter fraction={fraction} /> : model && <span className="m cv2-trunc" title={model}>{model}</span>}
        </span>
      </div>
      {hasChildren && open && (
        <ul role="group" className="cv2-agroup">
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} now={now} expanded={expanded} focusedId={focusedId} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onFocusRow={onFocusRow} rowRefs={rowRefs} leadModel={leadModel} modelLabel={modelLabel} />
          ))}
        </ul>
      )}
    </li>
  );
}

function allNodes(node: AgentTreeNode, out: AgentTreeNode[] = []): AgentTreeNode[] {
  out.push(node);
  for (const c of node.children) allNodes(c, out);
  return out;
}

/** The run at a glance: one segment per agent, in the roster's order and state colours. */
function RunStrip({ agents }: { agents: readonly AgentTreeNode[] }) {
  if (!agents.length) return null;
  return (
    <div className="cv2-runstrip" aria-hidden="true">
      {agents.map((node) => (
        <span key={node.id} data-state={node.state} title={`${node.label}: ${AGENT_NODE_STATE_LABEL[node.state]}`} />
      ))}
    </div>
  );
}

/** "1 needs you, 2 of 5 done": what to act on first, then how far the run is. */
export function runSummary(agents: readonly AgentTreeNode[]): string {
  if (!agents.length) return "No agents yet";
  const needs = agents.filter((n) => n.state === "waiting").length;
  const paused = agents.filter((n) => n.state === "paused").length;
  const failed = agents.filter((n) => n.state === "failed").length;
  const done = agents.filter((n) => n.state === "done").length;
  const settled = agents.every((n) => !isLive(n.state));
  return [
    needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
    paused ? `${paused} paused` : null,
    failed ? `${failed} failed` : null,
    settled && done === agents.length ? `${done} ${done === 1 ? "agent" : "agents"} finished` : `${done} of ${agents.length} done`,
  ].filter(Boolean).join(", ");
}

/** One press at a time per node; the answer is announced in the detail's status line. */
function useControl(control: WorkspaceModel["actions"]["controlAgent"]) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const run = React.useCallback(
    async (tag: string, input: AgentControlRequestInput): Promise<AgentControlResult | null> => {
      if (!control) return null;
      setPending(tag);
      setNotice(null);
      try {
        const result = await control(input);
        setNotice(result.message ? { text: result.message, error: !result.accepted } : result.accepted ? null : { text: "That was not accepted.", error: true });
        return result;
      } catch (error) {
        setNotice({ text: error instanceof Error && error.message ? error.message : "That did not go through. Try again.", error: true });
        return null;
      } finally {
        setPending(null);
      }
    },
    [control],
  );
  return { pending, notice, setNotice, run };
}

function TopUpMenu({ node, disabled, onPick, budgetUsd }: { node: AgentTreeNode; disabled: boolean; onPick: (add: { tokens?: number; usd?: number }, words: string) => void; budgetUsd?: number }) {
  const [open, setOpen] = React.useState(false);
  const isLead = node.id === LEAD_NODE_ID;
  const choices = isLead
    ? budgetUsd !== undefined ? RUN_TOP_UP_USD.map((usd) => ({ add: { usd }, text: `+$${usd}` })) : []
    : node.tokenBudget !== undefined ? AGENT_TOP_UP_TOKENS.map((tokens) => ({ add: { tokens }, text: `+${formatTokens(tokens)}` })) : [];
  if (!choices.length) return null;
  return (
    <span className="cv2-atopup">
      <button type="button" className="cv2-btn" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Glyph name="plus" size={14} />
        <span>Top up</span>
      </button>
      {open && (
        <span className="cv2-atopup-menu" role="group" aria-label="Top-up amount">
          {choices.map((c) => (
            <button
              key={c.text}
              type="button"
              className="cv2-btn ghost"
              onClick={() => {
                setOpen(false);
                onPick(c.add, c.text);
              }}
            >
              {c.text}
              {!isLead && <span className="cv2-mute"> tokens</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function AgentActivity({ node, items }: { node: AgentTreeNode; items: readonly TurnItem[] }) {
  // The lead's own work is the thread itself; its detail is the run's controls and spend.
  if (node.id === LEAD_NODE_ID) return null;
  const agent = node.agent!;
  const trace = items.filter((i) => i.kind !== "subagent" && i.agentId === agent.agentId);
  const now = Date.now();
  return (
    <div className="cv2-alog">
      {agent.task && (
        <details className="cv2-atask" open>
          <summary className="cv2-small cv2-mute">Brief from the lead</summary>
          <div className="cv2-prose cv2-atask-body">{agent.task}</div>
        </details>
      )}
      {trace.map((item) =>
        item.kind === "assistant_message" ? (
          <Markdown key={item.id} content={item.text} streaming={item.streaming} />
        ) : item.kind === "reasoning" ? (
          <details key={item.id}>
            <summary className="cv2-mute cv2-small">Reasoning summary</summary>
            <Markdown content={item.text} />
          </details>
        ) : (
          (() => {
            const line = lineFor(item, now);
            return line ? <LogRow key={item.id} line={line} forceOpen={false} /> : null;
          })()
        ),
      )}
      {trace.length === 0 && (
        <>
          <p className="cv2-mute cv2-small">{isLive(node.state) ? "Its steps show here as it works." : "This provider did not share the steps of this run."}</p>
          {agent.closingText && <Markdown content={agent.closingText} />}
        </>
      )}
    </div>
  );
}

function AgentDetailPanel({ node, model, now, runBudgetUsd, onRunBudget, modelLabel }: { node: AgentTreeNode; model: WorkspaceModel; now: number; runBudgetUsd?: number; onRunBudget: (usd: number) => void; modelLabel: ModelLabeler }) {
  const control = model.actions.controlAgent;
  const { pending, notice, run } = useControl(control);
  const [draft, setDraft] = React.useState("");
  const [armedStop, setArmedStop] = React.useState(false);
  React.useEffect(() => {
    if (!armedStop) return;
    const t = setTimeout(() => setArmedStop(false), 4000);
    return () => clearTimeout(t);
  }, [armedStop]);
  const isLead = node.id === LEAD_NODE_ID;
  const agent = node.agent;
  const live = isLive(node.state);
  const runLive = model.state === "running" || model.state === "waiting";
  const target = isLead ? {} : { agentId: node.id };
  const elapsed = elapsedOf(node, now);
  const counts = countLive(node);
  const anyPaused = isLead ? counts.paused > 0 : node.state === "paused";
  const canPause = isLead ? counts.live - counts.paused > 0 : live && node.state !== "paused";
  const headingId = `cv2-adetail-${node.id}`;
  // The lead is always the composer's own model (team.ts); a worker carries its own.
  const modelName = modelLabel(agent?.model ?? model.selection);
  const spendTokens = node.tokens !== undefined ? formatTokens(node.tokens) : null;
  const steerPlaceholder = live ? `Steer ${node.label}` : `Continue ${node.label}`;
  const word = AGENT_NODE_STATE_LABEL[node.state];

  return (
    <section className="cv2-adetail" aria-labelledby={headingId}>
      <header className="cv2-adetail-head">
        <h3 id={headingId} className="cv2-m cv2-trunc">{node.label}</h3>
        <span className={cn("cv2-achip", node.state === "waiting" && "cv2-sig")} data-state={node.state}>
          <StateMark state={node.state} animate={live} />
          <span>{word}</span>
        </span>
      </header>
      {node.step !== word && <p className={cn("cv2-small cv2-adetail-step", node.state === "waiting" ? "cv2-sig" : "cv2-mute")}>{node.step}</p>}

      <dl className="cv2-astats">
        {modelName && (
          <div>
            <dt>Model</dt>
            <dd className="cv2-trunc" title={modelName}>{modelName}</dd>
          </div>
        )}
        {elapsed !== undefined && (
          <div>
            <dt>Time</dt>
            <dd className="cv2-tnum">{formatDuration(elapsed)}</dd>
          </div>
        )}
        {(spendTokens || node.tokenBudget !== undefined) && (
          <div>
            <dt>Tokens</dt>
            <dd className="cv2-tnum">
              <span>{spendTokens ?? "0"}</span>
              {node.tokenBudget !== undefined && (
                <>
                  <span className="cv2-mute">&nbsp;of {formatTokens(node.tokenBudget)}</span>
                  <Meter fraction={budgetFraction(node.tokens ?? 0, node.tokenBudget)} label="Token budget used" />
                </>
              )}
            </dd>
          </div>
        )}
        {(node.costUsd !== undefined || (isLead && runBudgetUsd !== undefined)) && (
          <div>
            <dt>Cost</dt>
            <dd className="cv2-tnum">
              <span>${(node.costUsd ?? 0).toFixed(2)}</span>
              {isLead && runBudgetUsd !== undefined && (
                <>
                  <span className="cv2-mute">&nbsp;of ${runBudgetUsd.toFixed(2)}</span>
                  <Meter fraction={budgetFraction(node.costUsd ?? 0, runBudgetUsd)} label="Run budget used" />
                </>
              )}
            </dd>
          </div>
        )}
      </dl>

      {control && (isLead ? runLive || counts.live > 0 : true) && (
        <div className="cv2-acontrols" role="toolbar" aria-label={isLead ? "Run controls" : "Agent controls"}>
          {canPause && (
            <button type="button" className="cv2-btn" disabled={pending !== null} onClick={() => void run("pause", { ...target, action: "pause" })}>
              <Glyph name="pause" size={14} />
              <span>{isLead ? "Pause all" : "Pause"}</span>
            </button>
          )}
          {anyPaused && (
            <button type="button" className="cv2-btn" disabled={pending !== null} onClick={() => void run("resume", { ...target, action: "resume" })}>
              <Glyph name="play" size={14} />
              <span>{isLead ? "Resume all" : "Resume"}</span>
            </button>
          )}
          {isLead
            ? runLive && (
                <button
                  type="button"
                  className={cn("cv2-btn", armedStop && "danger")}
                  disabled={pending !== null}
                  onClick={() => {
                    if (!armedStop) return setArmedStop(true);
                    setArmedStop(false);
                    void run("stop", { action: "stop" });
                  }}
                >
                  <Glyph name="stop" size={14} />
                  <span>{armedStop ? "Confirm stop" : "Stop run"}</span>
                </button>
              )
            : live && (
                <button type="button" className="cv2-btn" disabled={pending !== null} onClick={() => void run("stop", { ...target, action: "stop" })}>
                  <Glyph name="stop" size={14} />
                  <span>Stop</span>
                </button>
              )}
          {node.state !== "stopped" || !isLead ? (
            <TopUpMenu
              node={node}
              budgetUsd={runBudgetUsd}
              disabled={pending !== null}
              onPick={(add) =>
                void run("top_up", { ...target, action: "top_up", ...add }).then((r) => {
                  if (r?.accepted && isLead && r.budget?.maxUsd !== undefined) onRunBudget(r.budget.maxUsd);
                })
              }
            />
          ) : null}
        </div>
      )}
      {armedStop && <p className="cv2-small cv2-mute">Every agent stops and keeps its work so far.</p>}
      <p className="cv2-small cv2-anotice" role="status" aria-live="polite" data-error={notice?.error || undefined}>
        {notice?.text ?? ""}
      </p>

      <AgentActivity node={node} items={model.items} />

      {control && !isLead && agent && node.state !== "stopped" && (
        <form
          className="cv2-mini cv2-asteer"
          onSubmit={async (e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text || pending) return;
            const result = await run("steer", { agentId: node.id, action: "steer", text });
            if (result?.accepted) setDraft((d) => (d.trim() === text ? "" : d));
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={steerPlaceholder}
            aria-label={live ? `Steer ${node.label}` : `Continue ${node.label}`}
            aria-describedby={`${headingId}-steer`}
            maxLength={8000}
          />
          <button type="submit" className="cv2-send" aria-label="Send" disabled={pending !== null || !draft.trim()}>
            <span className="glyph">
              <Glyph name="arrow-up" size={16} />
            </span>
          </button>
          <span id={`${headingId}-steer`} className="cv2-sr">
            {live ? "It reads your message at its next step." : "It continues its work with your message."}
          </span>
        </form>
      )}
    </section>
  );
}

export function AgentsTreePane({
  model,
  selectedId,
  onSelect,
  modelLabel,
  historical = false,
}: {
  model: WorkspaceModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  modelLabel: ModelLabeler;
  historical?: boolean;
}) {
  const [runBudgetUsd, setRunBudgetUsd] = React.useState<number | undefined>(model.routing.budget?.maxUsd);
  React.useEffect(() => setRunBudgetUsd((prev) => (prev === undefined || (model.routing.budget?.maxUsd ?? 0) > prev ? model.routing.budget?.maxUsd : prev)), [model.routing.budget?.maxUsd]);
  const runLive = model.state === "running" || model.state === "waiting";
  const root = React.useMemo(() => buildAgentTree(model.items, { running: runLive, budgetUsd: historical ? undefined : runBudgetUsd }), [model.items, runLive, runBudgetUsd, historical]);
  const swarm = model.routing.preset === "lead-workers";
  const allAgents = React.useMemo(() => allNodes(root), [root]);
  const agents = React.useMemo(() => allAgents.filter((node) => node.id !== LEAD_NODE_ID), [allAgents]);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const expanded = React.useMemo(() => new Set(allAgents.filter((node) => node.children.length && !collapsed.has(node.id)).map((node) => node.id)), [allAgents, collapsed]);
  const selected = (selectedId && findNode(root, selectedId)) || root;
  const [focusedId, setFocusedId] = React.useState<string>(selected.id);
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const phone = useMediaQuery(PHONE_QUERY);
  const [mobileDetail, setMobileDetail] = React.useState(false);
  const detailVisible = phone && (mobileDetail || selected.id !== LEAD_NODE_ID);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const restoreRow = React.useRef(false);
  const rows = React.useMemo(() => visibleRows(root, expanded), [root, expanded]);
  const fallbackFocus = rows.some((row) => row.id === selected.id) ? selected.id : root.id;
  const focus = rows.some((row) => row.id === focusedId) ? focusedId : fallbackFocus;
  React.useEffect(() => {
    if (!phone) return;
    if (detailVisible) backRef.current?.focus({ preventScroll: true });
    else if (restoreRow.current) {
      restoreRow.current = false;
      rowRefs.current.get(focus)?.focus({ preventScroll: true });
    }
  }, [phone, detailVisible, focus]);

  // One clock for every live row; nothing ticks once the run has settled.
  const counts = countLive(root);
  const ticking = !historical && (counts.live > 0 || runLive);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const moveFocus = (id: string) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };
  const toggle = (id: string) => {
    moveFocus(id);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const select = (id: string) => {
    onSelect(id === LEAD_NODE_ID ? null : id);
    if (phone) {
      setFocusedId(id);
      setMobileDetail(true);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "treeitem") return;
    const effect = treeKey(e.key, focus, rows, expanded);
    if (effect.kind === "none") return;
    e.preventDefault();
    if (effect.kind === "focus") moveFocus(effect.id);
    else if (effect.kind === "expand" || effect.kind === "collapse") toggle(effect.id);
    else if (effect.kind === "expand-siblings") setCollapsed((prev) => new Set([...prev].filter((id) => !effect.ids.includes(id))));
    else if (effect.kind === "select") select(effect.id);
  };

  const title = historical ? "Previous run" : swarm ? "Swarm" : "Agents";
  const summary = runSummary(agents);

  return (
    <div className="cv2-dock-pane cv2-agents">
      <div className="cv2-run-heading">
        {detailVisible ? (
          <button ref={backRef} type="button" className="cv2-btn ghost" onClick={() => {
            restoreRow.current = true;
            onSelect(null);
            setMobileDetail(false);
          }}><Glyph name="arrow-left" size={16} /> All agents</button>
        ) : <h2>{title}</h2>}
        <span className="cv2-mute cv2-small cv2-trunc cv2-tnum" aria-live="polite">{historical && detailVisible ? "Previous run" : summary}</span>
      </div>
      {!detailVisible && <RunStrip agents={agents} />}
      <div className="cv2-atree-wrap" hidden={detailVisible}>
        <ul role="tree" aria-label="Agents in this run" className="cv2-atree" onKeyDown={onKeyDown}>
          <TreeRow node={root} now={now} expanded={expanded} focusedId={focus} selectedId={selected.id} onSelect={select} onToggle={toggle} onFocusRow={moveFocus} rowRefs={rowRefs} leadModel={model.selection} modelLabel={modelLabel} />
        </ul>
        {agents.length === 0 && (
          <p className="cv2-agents-hint cv2-small cv2-mute">
            {runLive ? "Agents appear here as the lead hands out work." : swarm ? "Send a task and the lead splits it across agents." : "This run has no agents."}
          </p>
        )}
      </div>
      <div className="cv2-dockscroll cv2-adetail-wrap" hidden={phone && !detailVisible}>
        <AgentDetailPanel key={selected.id} node={selected} model={model} now={now} runBudgetUsd={historical ? undefined : runBudgetUsd} onRunBudget={setRunBudgetUsd} modelLabel={modelLabel} />
      </div>
    </div>
  );
}
