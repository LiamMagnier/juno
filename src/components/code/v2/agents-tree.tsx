"use client";

/**
 * The Agents tree (REA backlog 10, docs/rea/designs/subagents-and-harness.md
 * §3.3 "Web"): a run's agents as a live tree — the lead at the root, each
 * agent under the one that started it — with its state, current step, clock
 * and spend against its budget. Selecting a node shows its live activity and
 * a person's controls: Steer, Pause / Resume, Stop, and a bounded Top-up.
 *
 * Everything shown is derived from the thread's items (agent-tree.ts), so it
 * is exactly as live as the session stream. The controls go through
 * `actions.controlAgent`, which the route wires to the audited agent-control
 * endpoint; none of them can answer an approval or widen an agent's access.
 *
 * Accessibility: a WAI-ARIA tree (roving focus, arrows / Home / End,
 * Left-Right to fold, Enter or Space to select), every state in words as well
 * as the agent's face (run-agent-face.tsx), results announced in a polite status line, no motion beyond the
 * global tiers (the meter's fill is a Tier A change).
 */
import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { AgentControlResult, TurnItem } from "@/lib/code-v2/contracts";
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
  type AgentTreeNode,
} from "@/lib/code-v2/agent-tree";
import { formatDuration } from "@/lib/code-v2/turns";
import { Glyph } from "./primitives";
import { RunAgentFace, useRunAvatars } from "./run-agent-face";
import { runAgentAvatar, runFaceState } from "@/lib/agents/run-avatar";
import type { AgentAvatar } from "@/lib/agents/avatar";
import { LogRow, lineFor } from "./thread";
import type { AgentControlRequestInput, WorkspaceModel } from "./types";
import type { ModelSelection } from "@/lib/code-v2/contracts";

/** How the dock names a model (dock.tsx `modelLabelFor`), passed in to keep the two files acyclic. */
export type ModelLabeler = (selection: ModelSelection) => string;
import { cn } from "@/lib/utils";

/** Token top-ups a person can pick for one agent (inside agent-core's bounds). */
export const AGENT_TOP_UP_TOKENS = [50_000, 100_000, 200_000] as const;
/** Dollar top-ups for the run's own budget. */
export const RUN_TOP_UP_USD = [1, 5, 10] as const;

/**
 * The agent's face (the Orbit character, in 2D) in place of a status dot: its
 * eyes say the state, and the row says it in words beside it.
 */
function StateFace({ node, avatars, size = "xs" }: { node: AgentTreeNode; avatars: ReadonlyMap<string, AgentAvatar>; size?: "xs" | "sm" }) {
  const avatar = avatars.get(node.id) ?? runAgentAvatar({ id: node.id, role: node.agent?.role, phase: node.agent?.phase });
  return <RunAgentFace avatar={avatar} state={runFaceState(node.state)} size={size} />;
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
    <span className="cv2-ameter" {...a11y} data-warn={fraction >= 0.8 || undefined}>
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
  avatars: ReadonlyMap<string, AgentAvatar>;
}

function TreeRow({ node, now, expanded, focusedId, selectedId, onSelect, onToggle, onFocusRow, rowRefs, avatars }: RowProps) {
  const open = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;
  const elapsed = elapsedOf(node, now);
  const spend = spendLine(node);
  const word = AGENT_NODE_STATE_LABEL[node.state];
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
      className="cv2-aitem"
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(node.id);
      }}
    >
      <div
        className="cv2-anode"
        data-selected={selected || undefined}
        style={{ paddingInlineStart: 6 + node.depth * 16 }}
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
        <StateFace node={node} avatars={avatars} />
        <span className="cv2-acol">
          <span className="nm cv2-trunc">{node.label}</span>
          <span className={cn("st cv2-trunc", node.state === "waiting" && "cv2-sig")}>{node.step}</span>
        </span>
        <span className="cv2-aside" aria-hidden="true">
          <span className="t">{elapsed !== undefined ? formatDuration(elapsed) : ""}</span>
          <Meter fraction={nodeFraction(node)} />
        </span>
      </div>
      {hasChildren && open && (
        <ul role="group" className="cv2-agroup">
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} now={now} expanded={expanded} focusedId={focusedId} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onFocusRow={onFocusRow} rowRefs={rowRefs} avatars={avatars} />
          ))}
        </ul>
      )}
    </li>
  );
}

function allIds(node: AgentTreeNode, out: string[] = []): string[] {
  if (node.children.length) out.push(node.id);
  for (const c of node.children) allIds(c, out);
  return out;
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
  if (node.id === LEAD_NODE_ID) {
    return (
      <div className="cv2-alog">
        <p className="cv2-mute cv2-small">The lead&apos;s own work is in the thread. Pick an agent to see what it is doing.</p>
        {node.children.length > 0 && (
          <ul className="cv2-adigest">
            {node.children.map((c) => (
              <li key={c.id}>
                <span className="nm">{c.label}</span>
                <span className="cv2-mute">{AGENT_NODE_STATE_LABEL[c.state]}</span>
                <span className="cv2-mute cv2-trunc">{c.step}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const agent = node.agent!;
  const trace = items.filter((i) => i.kind !== "subagent" && i.agentId === agent.agentId);
  const now = Date.now();
  return (
    <div className="cv2-alog">
      {agent.task && (
        <details className="cv2-atask">
          <summary className="cv2-mute cv2-small">Task from the lead</summary>
          <div className="cv2-prose" style={{ whiteSpace: "pre-wrap" }}>{agent.task}</div>
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
          <p className="cv2-mute cv2-small">{isLive(node.state) ? "Waiting for activity from the provider…" : "The provider did not share a live trace for this run."}</p>
          {agent.closingText && <Markdown content={agent.closingText} />}
        </>
      )}
    </div>
  );
}

function AgentDetailPanel({ node, model, now, runBudgetUsd, onRunBudget, modelLabel, avatars }: { node: AgentTreeNode; model: WorkspaceModel; now: number; runBudgetUsd?: number; onRunBudget: (usd: number) => void; modelLabel: ModelLabeler; avatars: ReadonlyMap<string, AgentAvatar> }) {
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
  const model_ = agent ? modelLabel(agent.model) : null;
  const spendTokens = node.tokens !== undefined ? formatTokens(node.tokens) : null;
  const steerPlaceholder = live ? "Steer this agent" : "Continue this agent";

  return (
    <section className="cv2-adetail" aria-labelledby={headingId}>
      <header className="cv2-adetail-head">
        <StateFace node={node} avatars={avatars} size="sm" />
        <h3 id={headingId} className="cv2-m cv2-trunc">{node.label}</h3>
        <span className={cn("cv2-achip", node.state === "waiting" && "cv2-sig")} data-state={node.state}>
          <span>{AGENT_NODE_STATE_LABEL[node.state]}</span>
        </span>
      </header>
      <p className={cn("cv2-small cv2-adetail-step", node.state === "waiting" ? "cv2-sig" : "cv2-mute")}>{node.step}</p>

      <dl className="cv2-astats">
        {model_ && (
          <div>
            <dt>Model</dt>
            <dd className="cv2-trunc">{model_}</dd>
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
                  <span className="cv2-mute"> / {formatTokens(node.tokenBudget)}</span>
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
                  <span className="cv2-mute"> / ${runBudgetUsd.toFixed(2)}</span>
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
}: {
  model: WorkspaceModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  modelLabel: ModelLabeler;
}) {
  const [runBudgetUsd, setRunBudgetUsd] = React.useState<number | undefined>(model.routing.budget?.maxUsd);
  React.useEffect(() => setRunBudgetUsd((prev) => (prev === undefined || (model.routing.budget?.maxUsd ?? 0) > prev ? model.routing.budget?.maxUsd : prev)), [model.routing.budget?.maxUsd]);
  const runLive = model.state === "running" || model.state === "waiting";
  const root = React.useMemo(() => buildAgentTree(model.items, { running: runLive, budgetUsd: runBudgetUsd }), [model.items, runLive, runBudgetUsd]);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const expanded = React.useMemo(() => new Set(allIds(root).filter((id) => !collapsed.has(id))), [root, collapsed]);
  const selected = (selectedId && findNode(root, selectedId)) || root;
  const [focusedId, setFocusedId] = React.useState<string>(selected.id);
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const rows = React.useMemo(() => visibleRows(root, expanded), [root, expanded]);
  const avatars = useRunAvatars(model.items);
  const focus = rows.some((r) => r.id === focusedId) ? focusedId : selected.id;

  // One clock for every live row; nothing ticks once the run has settled.
  const counts = countLive(root);
  const ticking = counts.live > 0 || runLive;
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
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const select = (id: string) => onSelect(id === LEAD_NODE_ID ? null : id);

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

  const summary = counts.total === 0 ? "No agents yet" : counts.live > 0 ? `${counts.live} of ${counts.total} working` : `${counts.total} ${counts.total === 1 ? "agent" : "agents"}, all settled`;

  return (
    <div className="cv2-dock-pane cv2-agents">
      <div className="cv2-dockbar">
        <span className="cv2-m">Agents</span>
        <span className="cv2-mute cv2-small cv2-trunc cv2-grow">{summary}</span>
        {counts.waiting > 0 && (
          <span className="cv2-small cv2-sig">
            <span>Needs you</span> <span className="cv2-tnum">{counts.waiting}</span>
          </span>
        )}
      </div>
      <div className="cv2-atree-wrap">
        <ul role="tree" aria-label="Agents in this run" className="cv2-atree" onKeyDown={onKeyDown}>
          <TreeRow node={root} now={now} expanded={expanded} focusedId={focus} selectedId={selected.id} onSelect={select} onToggle={toggle} onFocusRow={setFocusedId} rowRefs={rowRefs} avatars={avatars} />
        </ul>
      </div>
      <div className="cv2-dockscroll cv2-adetail-wrap">
        <AgentDetailPanel key={selected.id} node={selected} model={model} now={now} runBudgetUsd={runBudgetUsd} onRunBudget={setRunBudgetUsd} modelLabel={modelLabel} avatars={avatars} />
      </div>
    </div>
  );
}
