"use client";

/**
 * The Agents panel (REA backlog 10, docs/rea/designs/subagents-and-harness.md
 * §3.3 "Web"): a run's agents, live, and the selected agent's detail.
 *
 * Three views of one run. Grid (a Swarm's default) opens on the
 * constellation: the lead's face in the middle and every agent's face around
 * it, each joined to whoever started it. Work runs along a link while that
 * agent works, the link beats in coral while it needs you and settles when it
 * is done, and a new agent travels out from the lead to its place, so the
 * moment the lead hands out work is the moment you see it. Under it, one card
 * per agent: its face, its name, what it is doing or what it found. Tree is
 * the same run as a WAI-ARIA tree for the keyboard; Activity is what every
 * agent did, newest first.
 *
 * Agents are named for their work (agent-names.ts): "Reset form checker", not
 * "Worker 2". The faces are Orbit's (AgentFace): the face itself says the
 * state (the ring orbits while it works, three dots while it thinks, a notch
 * when it asks for you), and every state is also a word.
 *
 * Everything shown is derived from the thread's items (agent-tree.ts), so it
 * is exactly as live as the session stream. The controls go through
 * `actions.controlAgent`, which the route wires to the audited agent-control
 * endpoint; none of them can answer an approval or widen an agent's access.
 *
 * Reduced motion: the faces show their still frames (agent-face.css), the
 * links stop flowing and beating, and a new agent appears in its place
 * without travelling (code-v2.css).
 */
import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { defaultAgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/state-labels";
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
import { describeItem, formatDuration } from "@/lib/code-v2/turns";
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

type AgentView = "grid" | "tree" | "activity";
const AGENT_VIEWS: { id: AgentView; label: string }[] = [
  { id: "grid", label: "Grid" },
  { id: "tree", label: "Tree" },
  { id: "activity", label: "Activity" },
];

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

/** The tree's states in the faces' vocabulary (Orbit, AGENTS.md §4). */
const FACE_STATE: Record<AgentNodeState, AgentState> = {
  // Orbit draws "thinking" as three dots in place of the face; in a run of
  // faces, the working ring keeps each agent recognisable while it moves.
  thinking: "working",
  tool: "working",
  waiting: "waiting",
  queued: "idle",
  paused: "sleeping",
  done: "done",
  failed: "blocked",
  stopped: "sleeping",
};

/** An agent's face: the same drawing for the same agent everywhere in the run. */
function SwarmFace({ node, size, live }: { node: AgentTreeNode; size: number; live: boolean }) {
  return (
    <AgentFace
      avatar={defaultAgentAvatar(node.id === LEAD_NODE_ID ? "alevr-lead" : node.id)}
      state={FACE_STATE[node.state]}
      size={size}
      live={live && node.state !== "paused" && node.state !== "stopped"}
      still={!live}
    />
  );
}

/** Where each agent sits on the stage, in the SVG's own units (the faces use the same numbers as percentages). */
const STAGE_W = 400;
const STAGE_H = 196;
const STAGE_MAX = 10;

interface StageSpot {
  node: AgentTreeNode;
  x: number;
  y: number;
  parent: { x: number; y: number };
}

/**
 * Agents on an ellipse round the lead, first at the top and on round
 * clockwise; an agent started by another agent sits just outside its parent.
 */
export function stageLayout(agents: readonly AgentTreeNode[], max = STAGE_MAX): { spots: StageSpot[]; more: number } {
  const cx = STAGE_W / 2;
  const cy = STAGE_H / 2;
  const clampX = (x: number) => Math.min(STAGE_W - 24, Math.max(24, x));
  const clampY = (y: number) => Math.min(STAGE_H - 24, Math.max(24, y));
  const shown = agents.slice(0, max);
  const parentOf = new Map<string, string>();
  for (const node of agents) for (const child of node.children) parentOf.set(child.id, node.id);
  const at = new Map<string, { x: number; y: number }>();
  const spots: StageSpot[] = [];
  const top = shown.filter((n) => !parentOf.has(n.id));
  const ring = Math.max(top.length, 1);
  top.forEach((node, i) => {
    // First agent at the top; an even count is turned half a step so none sits on the lead's sides alone.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ring + (ring % 2 === 0 ? Math.PI / ring : 0);
    const spot = { x: cx + Math.cos(angle) * 150, y: cy + Math.sin(angle) * 70 };
    at.set(node.id, spot);
    spots.push({ node, ...spot, parent: { x: cx, y: cy } });
  });
  // An agent another agent started sits just outside it, its siblings side by side.
  const siblings = new Map<string, number>();
  for (const node of shown) {
    const parentId = parentOf.get(node.id);
    if (!parentId) continue;
    const parent = at.get(parentId) ?? { x: cx, y: cy };
    const dx = parent.x - cx;
    const dy = parent.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const k = siblings.get(parentId) ?? 0;
    siblings.set(parentId, k + 1);
    const along = 40;
    const across = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 30;
    const spot = {
      x: clampX(parent.x + (dx / len) * along - (dy / len) * across),
      y: clampY(parent.y + (dy / len) * along * 0.6 + (dx / len) * across * 0.6),
    };
    at.set(node.id, spot);
    spots.push({ node, ...spot, parent });
  }
  return { spots, more: Math.max(0, agents.length - shown.length) };
}

/**
 * Each agent arrives once from the lead and then stays where it is: all of
 * them when a live run's panel opens, then each new one as the lead starts it.
 * A past run opens with everyone already in place.
 */
function useArrived(ids: readonly string[], play: boolean): ReadonlySet<string> {
  const [arrived, setArrived] = React.useState<ReadonlySet<string>>(() => new Set(play ? [] : ids));
  const key = ids.join("|");
  React.useEffect(() => {
    if (ids.every((id) => arrived.has(id))) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setArrived(new Set(ids))));
    return () => cancelAnimationFrame(frame);
    // `key` stands for `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return arrived;
}

/**
 * The constellation: the lead in the middle, its agents round it. Pictorial:
 * the cards under it carry the same agents for the keyboard and for screen
 * readers, so the stage is hidden from assistive tech and its faces take no
 * tab stop, but a pointer can pick an agent here too.
 */
function SwarmStage({ root, agents, selected, onSelect, animate }: {
  root: AgentTreeNode;
  agents: readonly AgentTreeNode[];
  selected: string;
  onSelect: (id: string) => void;
  animate: boolean;
}) {
  const { spots, more } = React.useMemo(() => stageLayout(agents), [agents]);
  const arrived = useArrived(spots.map((s) => s.node.id), animate);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div className="cv2-stage" aria-hidden="true" data-animate={animate || undefined}>
      <svg className="cv2-stage-links" viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} preserveAspectRatio="none">
        <ellipse className="orbit" cx={STAGE_W / 2} cy={STAGE_H / 2} rx={150} ry={70} vectorEffect="non-scaling-stroke" />
        {spots.map((s) => (
          <line
            key={s.node.id}
            x1={s.parent.x}
            y1={s.parent.y}
            x2={s.x}
            y2={s.y}
            data-state={s.node.state}
            data-home={arrived.has(s.node.id) || undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <button
        type="button"
        tabIndex={-1}
        className="cv2-stage-face cv2-stage-lead"
        data-selected={selected === LEAD_NODE_ID || undefined}
        style={{ left: "50%", top: "50%" }}
        onClick={() => onSelect(LEAD_NODE_ID)}
        title={`${root.label}: ${root.step}`}
      >
        <SwarmFace node={root} size={52} live={animate} />
        <span className="cv2-stage-name">{root.label}</span>
      </button>
      {spots.map((s, i) => {
        const home = arrived.has(s.node.id);
        return (
          <button
            key={s.node.id}
            type="button"
            tabIndex={-1}
            className="cv2-stage-face"
            data-state={s.node.state}
            data-nested={s.node.depth > 1 || undefined}
            data-selected={selected === s.node.id || undefined}
            data-home={home || undefined}
            // A short stagger, so the lead is seen handing work out rather than everyone appearing at once.
            style={{ left: pct(home ? s.x : s.parent.x, STAGE_W), top: pct(home ? s.y : s.parent.y, STAGE_H), transitionDelay: home ? `${Math.min(i, 8) * 45}ms` : undefined }}
            onClick={() => onSelect(s.node.id)}
            title={`${s.node.label}: ${AGENT_NODE_STATE_LABEL[s.node.state]}`}
          >
            <SwarmFace node={s.node} size={s.node.depth > 1 ? 26 : 36} live={animate} />
            <span className="cv2-stage-name">{s.node.label}</span>
          </button>
        );
      })}
      {more > 0 && <span className="cv2-stage-more cv2-small cv2-mute">+{more} more below</span>}
    </div>
  );
}

/** What a card says under the name: what it is doing now, or what it found; its brief when the state word is all there is. */
function cardLine(node: AgentTreeNode): string {
  const line = node.state === "done" ? (node.agent?.closingText?.split("\n").find((l) => l.trim())?.trim() ?? node.step) : node.step;
  if (line && line !== AGENT_NODE_STATE_LABEL[node.state]) return line;
  return node.agent?.title ?? node.agent?.task?.split("\n")[0] ?? line;
}

function SwarmGrid({ agents, selected, now, modelLabel, onSelect, animate }: {
  agents: readonly AgentTreeNode[];
  selected: string;
  now: number;
  modelLabel: ModelLabeler;
  onSelect: (id: string) => void;
  animate: boolean;
}) {
  if (!agents.length) return null;
  return (
    <ul className="cv2-swarm-grid" aria-label="Swarm agents">
      {agents.map((node) => {
        const model = node.agent ? modelLabel(node.agent.model) : "";
        const elapsed = elapsedOf(node, now);
        const word = AGENT_NODE_STATE_LABEL[node.state];
        return (
          <li key={node.id}>
            <button
              type="button"
              className="cv2-swarm-card"
              data-state={node.state}
              data-agent-id={node.id}
              aria-pressed={selected === node.id}
              aria-label={[node.label, word, cardLine(node), model].filter(Boolean).join(", ")}
              onClick={() => onSelect(node.id)}
            >
              <span className="cv2-swarm-card-head">
                <SwarmFace node={node} size={34} live={animate} />
                <span className="cv2-swarm-identity">
                  <span className="cv2-m cv2-trunc">{node.label}</span>
                  <span className="cv2-small cv2-mute cv2-trunc">{model}</span>
                </span>
                <span className="cv2-small cv2-mute cv2-tnum cv2-swarm-time">{elapsed !== undefined ? formatDuration(elapsed) : ""}</span>
              </span>
              <span className={cn("cv2-swarm-state cv2-small", node.state === "waiting" ? "cv2-sig" : "cv2-mute")}>
                <StateMark state={node.state} />
                {word}
              </span>
              <span className="cv2-swarm-task cv2-small">{cardLine(node)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ago(createdAt: string | undefined, now: number): string {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function SwarmActivity({ items, agents, now, onSelect }: {
  items: readonly TurnItem[];
  agents: readonly AgentTreeNode[];
  now: number;
  onSelect: (id: string) => void;
}) {
  const byId = new Map(agents.map((node) => [node.id, node]));
  const recent: { id: string; agent: AgentTreeNode; text: string; at?: string }[] = [];
  const seen = new Set<string>();
  for (let i = items.length - 1; i >= 0 && recent.length < 40; i--) {
    const item = items[i]!;
    if (item.kind === "reasoning" || item.kind === "user_message" || seen.has(item.id)) continue;
    const agent = byId.get(item.agentId ?? LEAD_NODE_ID);
    if (!agent) continue;
    const step = describeItem(item, now);
    const text = item.kind === "subagent"
      ? `${item.status === "completed" ? "Finished" : item.status === "failed" ? "Failed" : "Started"}: ${item.title || item.task?.split("\n")[0] || agent.label}`
      : item.kind === "assistant_message" && item.agentId && !item.streaming
        ? item.text
        : step && [step.verb, step.object].filter(Boolean).join(" ");
    if (!text) continue;
    seen.add(item.id);
    recent.push({ id: item.id, agent, text: text.length > 180 ? `${text.slice(0, 179)}…` : text, at: item.createdAt });
  }
  if (!recent.length) return <p className="cv2-agents-hint cv2-small cv2-mute">What each agent does shows here as the run goes.</p>;
  return (
    <ol className="cv2-swarm-activity" aria-label="Swarm activity">
      {recent.map(({ id, agent, text, at }) => (
        <li key={id}>
          <button type="button" className="cv2-swarm-event" data-agent-id={agent.id} onClick={() => onSelect(agent.id)}>
            <SwarmFace node={agent} size={24} live={false} />
            <span className="min-w-0 flex-1">
              <span className="cv2-swarm-event-head">
                <span className="cv2-m cv2-trunc">{agent.label}</span>
                <span className="cv2-small cv2-mute cv2-tnum">{ago(at, now)}</span>
              </span>
              <span className="block break-words cv2-small cv2-mute">{text}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
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
        <SwarmFace node={node} size={40} live={live} />
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
  const [view, setView] = React.useState<AgentView>(swarm ? "grid" : "tree");
  const allAgents = React.useMemo(() => allNodes(root), [root]);
  const viewRoot = React.useRef<HTMLDivElement>(null);
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
      if (view === "tree") rowRefs.current.get(focus)?.focus({ preventScroll: true });
      else {
        const buttons = Array.from(viewRoot.current?.querySelectorAll<HTMLButtonElement>("button[data-agent-id]") ?? []);
        (buttons.find((button) => button.dataset.agentId === focus) ?? buttons[0])?.focus({ preventScroll: true });
      }
    }
  }, [phone, detailVisible, focus, view]);

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

  // The run's own model list names a selection the instance lookup missed ("gpt-6.1-sol" → "GPT-6.1 Sol").
  const nameModel: ModelLabeler = (selection) => {
    const label = modelLabel(selection);
    const bare = selection.model.split(":").pop() ?? selection.model;
    if (label !== selection.model && label !== bare) return label;
    const known = model.instances.flatMap((instance) => instance.models ?? []);
    return known.find((m) => m.id === selection.model || (m.id.split(":").pop() ?? m.id) === bare)?.label ?? label;
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
      <div hidden={detailVisible} className="cv2-swarm-view" role="group" aria-label="Agent view">
        {AGENT_VIEWS.map((v) => (
          <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>
        ))}
      </div>
      <div ref={viewRoot} className="cv2-atree-wrap" data-view={view} hidden={detailVisible}>
        {view === "grid" ? (
          <>
            <SwarmStage root={root} agents={agents} selected={selected.id} onSelect={select} animate={!historical} />
            <SwarmGrid agents={agents} selected={selected.id} now={now} modelLabel={nameModel} onSelect={select} animate={!historical} />
          </>
        ) : view === "tree" ? (
          <>
            <RunStrip agents={agents} />
            <ul role="tree" aria-label="Agents in this run" className="cv2-atree" onKeyDown={onKeyDown}>
              <TreeRow node={root} now={now} expanded={expanded} focusedId={focus} selectedId={selected.id} onSelect={select} onToggle={toggle} onFocusRow={moveFocus} rowRefs={rowRefs} leadModel={model.selection} modelLabel={nameModel} />
            </ul>
          </>
        ) : (
          <SwarmActivity items={model.items} agents={allAgents} now={now} onSelect={select} />
        )}
        {agents.length === 0 && view !== "activity" && (
          <p className="cv2-agents-hint cv2-small cv2-mute">
            {runLive ? "Agents appear here as the lead hands out work." : swarm ? "Send a task and the lead splits it across agents." : "This run has no agents."}
          </p>
        )}
      </div>
      <div className="cv2-dockscroll cv2-adetail-wrap" hidden={phone && !detailVisible}>
        <AgentDetailPanel key={selected.id} node={selected} model={model} now={now} runBudgetUsd={historical ? undefined : runBudgetUsd} onRunBudget={setRunBudgetUsd} modelLabel={nameModel} />
      </div>
    </div>
  );
}
