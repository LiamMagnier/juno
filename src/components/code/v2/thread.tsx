"use client";

/**
 * The thread (TARGET §5, §6): the conversation is the interface.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (the settled-turn fold "Worked for 3m 43s", WorkLog row geometry with a
 * shine on the live row, the changed-files summary after the answer).
 *
 * - A user message is a right-aligned bubble; hovering it shows its time and
 *   "Revert to here" (checkpoints live here and in the header menu, never as
 *   dividers in the thread).
 * - A settled turn folds all of its work behind one line, "Worked for 4m 13s",
 *   with the final answer and the changed-files card below it. Live turns and
 *   failures never fold.
 * - The work log is one muted line per step: a verb, its object, file names
 *   you can click, counts. No icons, no boxes, no per-step timers; the live
 *   row carries the only clock. Commands are the only monospace.
 * - A team run is one line ("3 workers and an explorer"); open, one line per
 *   agent. "Waiting for you" is the only coral in the thread.
 */
import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type {
  ComputerActionItem,
  PlanItem,
  ProviderInstance,
  SessionState,
  SubagentItem,
  TodoListItem,
  TurnItem,
} from "@/lib/code-v2/contracts";
import type { DockTab } from "@/lib/code-v2/dock";
import { splitPath } from "@/lib/code-v2/diff";
import { TEAM_PHASE_VALUES } from "@/lib/code-v2/contracts";
import { TEAM_PHASE_LABELS } from "@/lib/code-v2/team";
import { formatTokens } from "@/lib/code-v2/tier-view";
import { describeItem, formatDuration, groupTurns, stepItems, turnHeader, turnMarks, turnVisibility, type DetailLevel, type Turn } from "@/lib/code-v2/turns";
import { Glyph, useNow } from "./primitives";
import { cn } from "@/lib/utils";
import { CrossMessageRow } from "@/components/chat/cross-message-row";
import { peerHrefForRef as peerHref } from "@/lib/cross-conversation/links";

export interface DockRequest {
  tab: DockTab;
  /** Changes: file path to scroll to. Terminal: command id. Agents: agent id. Screen: item id. */
  target?: string;
  scope?: "turn" | "thread";
  turnId?: string;
}

export interface ThreadProps {
  items: readonly TurnItem[];
  state: SessionState;
  instances: readonly ProviderInstance[];
  detailLevel: DetailLevel;
  budgetUsd?: number;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  onOpenDock?: (req: DockRequest) => void;
  onRollback?: (checkpointId: string) => void;
  onApprovePlan?: (itemId: string, approve: boolean) => void;
  onUndoTurn?: (turn: Turn) => void;
  onRetry?: () => void;
  /** Shown before the first event of a starting session. */
  starting?: string | null;
  offline?: boolean;
  /** This browser cannot drive the Mac until it is paired (docs/code-v2/REMOTE-CONTROL.md). */
  pairingRequired?: { deviceName: string } | null;
  resolveScreenshot?: (ref: string) => string | null;
}

const base = (p: string) => splitPath(p).name;
const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

function Counts({ adds, dels }: { adds?: number; dels?: number }) {
  if (!adds && !dels) return null;
  return (
    <span className="n">
      <span className="cv2-add">+{adds ?? 0}</span> <span className="cv2-del">−{dels ?? 0}</span>
    </span>
  );
}

// ── Work-log rows ────────────────────────────────────────────────────────────

type Expand = { kind: "prose" | "mono"; text: string } | { kind: "list"; node: React.ReactNode } | null;

interface LogLine {
  key: string;
  verb: string;
  body?: React.ReactNode;
  counts?: { adds?: number; dels?: number };
  time?: string;
  live: boolean;
  tone?: "error" | "needs";
  expand: Expand;
  open?: DockRequest;
}

function FileLink({ path, onOpen }: { path: string; onOpen?: () => void }) {
  return (
    <span
      role="link"
      tabIndex={0}
      className="file"
      title={path}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          onOpen?.();
        }
      }}
    >
      {base(path)}
    </span>
  );
}

function Checklist({ steps }: { steps: { text: string; status: string }[] }) {
  return (
    <div className="cv2-checks">
      {steps.map((s, i) => (
        <div key={i} className={cn("cv2-checkrow", s.status === "completed" && "done")}>
          <Glyph name={s.status === "completed" ? "check-circle" : s.status === "in_progress" ? "circle-dashed" : "circle"} size={14} />
          <span>{s.text}</span>
        </div>
      ))}
    </div>
  );
}

function lineFor(item: TurnItem, now: number, openDock?: (r: DockRequest) => void): LogLine | null {
  const row = describeItem(item, now);
  if (!row) return null;
  const live = row.tone === "running";
  const common = { key: item.id, live, tone: row.tone === "error" ? ("error" as const) : row.tone === "needs" ? ("needs" as const) : undefined };
  switch (item.kind) {
    case "reasoning":
      return { ...common, verb: live ? "Thinking" : "Thought", expand: item.text?.trim() ? { kind: "prose", text: item.text } : null };
    case "file_change": {
      const first = item.changes[0];
      const req: DockRequest = { tab: "changes", target: first?.path, scope: "turn", turnId: item.turnId };
      return {
        ...common,
        verb: row.verb,
        body: first ? (
          <>
            <FileLink path={first.path} onOpen={() => openDock?.(req)} />
            {item.changes.length > 1 ? ` and ${item.changes.length - 1} more` : ""}
          </>
        ) : undefined,
        counts: live ? undefined : { adds: row.additions, dels: row.deletions },
        expand: null,
        open: req,
      };
    }
    case "command_execution": {
      const failed = row.tone === "error";
      return {
        ...common,
        verb: live ? "Running" : failed ? "Failed" : item.background ? "Started" : "Ran",
        body: <span className="cmd">{item.command}</span>,
        time: live ? row.meta : undefined,
        expand: item.output?.trim() ? { kind: "mono", text: `${item.output.trim()}${item.exitCode !== undefined && item.exitCode !== 0 ? `\nexit ${item.exitCode}` : ""}` } : null,
      };
    }
    case "search":
      if (item.scope === "files" && item.matches === undefined) return { ...common, verb: live ? "Reading" : "Read", body: <FileLink path={item.query} onOpen={() => openDock?.({ tab: "files", target: item.query })} />, expand: null };
      return { ...common, verb: live ? "Searching for" : "Searched for", body: item.query, time: undefined, expand: null, counts: undefined };
    case "web_search":
      return { ...common, verb: live ? "Searching the web for" : "Searched the web for", body: <span className="cv2-fg">{item.query}</span>, expand: null };
    case "plan":
      return { ...common, verb: "Planned", body: row.object, expand: item.steps?.length ? { kind: "list", node: <Checklist steps={item.steps} /> } : item.text ? { kind: "prose", text: item.text } : null };
    case "todo_list":
      return { ...common, verb: "Tasks", body: row.object, expand: { kind: "list", node: <Checklist steps={item.todos} /> } };
    case "error":
      return { ...common, verb: item.message, tone: "error", expand: null };
    default:
      return { ...common, verb: row.verb, body: row.object, expand: row.detail ? { kind: "prose", text: row.detail } : null };
  }
}

function LogRow({ line, forceOpen, onOpenDock }: { line: LogLine; forceOpen: boolean; onOpenDock?: (r: DockRequest) => void }) {
  const [open, setOpen] = React.useState(false);
  const shown = (open || forceOpen) && line.expand;
  const clickable = !!line.expand || !!line.open;
  const content = (
    <>
      <span className={cn("verb", line.live && "cv2-shine")}>{line.verb}</span>
      {line.body !== undefined && <span className="obj">{line.body}</span>}
      {line.counts && <Counts adds={line.counts.adds} dels={line.counts.dels} />}
      {line.expand && <Glyph name="chevron-right" size={12} className="chev" />}
      {line.time && <span className="t">{line.time}</span>}
    </>
  );
  const cls = cn("cv2-wl", line.tone);
  return (
    <>
      {clickable ? (
        <button type="button" className={cls} aria-expanded={line.expand ? !!shown : undefined} onClick={() => (line.expand ? setOpen((v) => !v) : line.open && onOpenDock?.(line.open))}>
          {content}
        </button>
      ) : (
        <div className={cls}>{content}</div>
      )}
      {shown && line.expand && (line.expand.kind === "list" ? <div style={{ marginLeft: 22, marginBottom: 6 }}>{line.expand.node}</div> : <div className={cn("cv2-wl-detail", line.expand.kind === "prose" && "prose")}>{line.expand.text}</div>)}
    </>
  );
}

/** Consecutive file reads read as one line: "Read 3 files". */
function ReadsRow({ items, forceOpen, onOpenDock }: { items: Extract<TurnItem, { kind: "search" }>[]; forceOpen: boolean; onOpenDock?: (r: DockRequest) => void }) {
  const [open, setOpen] = React.useState(false);
  const shown = open || forceOpen;
  const live = items.some((i) => i.status === "running" || i.status === "pending");
  return (
    <>
      <button type="button" className="cv2-wl" aria-expanded={shown} onClick={() => setOpen((v) => !v)}>
        <span className={cn("verb", live && "cv2-shine")}>{live ? "Reading" : "Read"}</span>
        <span className="obj">{items.length} files</span>
        <Glyph name="chevron-right" size={12} className="chev" />
      </button>
      {shown && (
        <div className="cv2-log" style={{ marginLeft: 22, marginBottom: 4 }}>
          {items.map((i) => (
            <div key={i.id} className="cv2-wl" style={{ minHeight: 24, padding: 0 }}>
              <span className="obj">
                <FileLink path={i.query} onOpen={() => onOpenDock?.({ tab: "files", target: i.query })} />
                <span className="cv2-small"> {splitPath(i.query).dir}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Team runs ───────────────────────────────────────────────────────────────

/** A Best of N candidate (the orchestrator names them "Candidate A", "Candidate B"). */
export const isCandidate = (a: SubagentItem) => /^Candidate\b/.test(a.label ?? "") || !!a.candidate?.kept || !!a.candidate?.testsLine;

export function teamHead(items: readonly SubagentItem[]): string {
  // Team lane: a Plan → Build → Verify run says which phases it reached.
  const phases = TEAM_PHASE_VALUES.filter((p) => items.some((i) => i.phase === p));
  if (phases.length) return phases.map((p) => TEAM_PHASE_LABELS[p]).join(" → ");
  const candidates = items.filter(isCandidate).length;
  const workers = items.filter((i) => i.role === "worker" && !isCandidate(i)).length;
  const others = items.filter((i) => i.role !== "worker");
  if (candidates) return `${candidates} candidates`;
  const w = workers ? `${workers} ${workers === 1 ? "worker" : "workers"}` : "";
  const o = others.map((x) => (x.role === "explorer" ? "an explorer" : x.role === "reviewer" ? "a reviewer" : `a ${x.role}`));
  const parts = [w, ...o].filter(Boolean);
  if (!parts.length) return `${items.length} agents`;
  const all = parts.length <= 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return all.charAt(0).toUpperCase() + all.slice(1);
}

export function agentStep(a: SubagentItem): { text: string; needs: boolean } {
  if (a.status === "waiting") return { text: "Waiting for you", needs: true };
  if (a.status === "running") return { text: a.liveLine ?? a.title ?? "Working", needs: false };
  if (a.status === "failed") return { text: a.liveLine ? `Failed: ${a.liveLine}` : "Failed", needs: false };
  if (a.status === "interrupted") return { text: "Stopped", needs: false };
  return { text: a.closingText ?? a.title ?? "Done", needs: false };
}

/** Plan, then Build, then Verify; agents with no phase keep their order after. */
function phaseOrdered(items: SubagentItem[]): SubagentItem[] {
  if (!items.some((i) => i.phase)) return items;
  const rank = (i: SubagentItem) => (i.phase ? TEAM_PHASE_VALUES.indexOf(i.phase) : TEAM_PHASE_VALUES.length);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function TeamGroup({ items, props, forceOpen }: { items: SubagentItem[]; props: ThreadProps; forceOpen: boolean }) {
  const live = items.some((i) => i.status === "running" || i.status === "waiting");
  const [open, setOpen] = React.useState<boolean | null>(null);
  const shown = open ?? (live || forceOpen);
  const elapsed = Math.max(0, ...items.map((i) => i.elapsedMs ?? 0));
  return (
    <div role="group" aria-label={teamHead(items)}>
      <button type="button" className="cv2-wl" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className={cn("verb", live && "cv2-shine")}>{teamHead(items)}</span>
        <Glyph name="chevron-right" size={12} className="chev" />
        {elapsed > 0 && <span className="t">{formatDuration(elapsed)}</span>}
      </button>
      {shown &&
        phaseOrdered(items).map((a, index, list) => {
          const step = agentStep(a);
          const phaseHead = a.phase && a.phase !== list[index - 1]?.phase ? TEAM_PHASE_LABELS[a.phase] : null;
          return (
            <React.Fragment key={a.id}>
            {phaseHead && <div className="cv2-phase-head" role="heading" aria-level={4}>{phaseHead}</div>}
            <button
              key={a.id}
              type="button"
              className="cv2-agentline"
              aria-pressed={props.selectedAgentId === a.agentId}
              onClick={() => {
                props.onSelectAgent?.(a.agentId);
                props.onOpenDock?.({ tab: "agents", target: a.agentId });
              }}
            >
              <span className="who">{a.label ?? (a.role === "explorer" ? "Explorer" : a.role === "reviewer" ? "Reviewer" : a.role === "architect" ? "Architect" : "Worker")}</span>
              <span className={cn("what", step.needs && "cv2-sig", a.status === "running" && "cv2-shine")}>{step.text}</span>
              <span className="t">{a.elapsedMs !== undefined ? formatDuration(a.elapsedMs) : ""}</span>
            </button>
            </React.Fragment>
          );
        })}
    </div>
  );
}

// ── Computer use ────────────────────────────────────────────────────────────

function ComputerLine({ items, props }: { items: ComputerActionItem[]; props: ThreadProps }) {
  const last = items[items.length - 1];
  const live = items.some((i) => i.status === "running" || i.status === "pending");
  const app = [...items].reverse().find((i) => i.app)?.app;
  const shot = [...items].reverse().find((i) => i.screenshotRef)?.screenshotRef;
  const src = shot ? props.resolveScreenshot?.(shot) : null;
  return (
    <>
      <button type="button" className="cv2-wl" onClick={() => props.onOpenDock?.({ tab: "screen", target: last.id })}>
        <span className={cn("verb", live && "cv2-shine")}>{live ? `Using ${app ?? "the computer"}` : `Used ${app ?? "the computer"}`}</span>
        <span className="obj">{last.summary ?? last.target ?? `${items.length} steps`}</span>
      </button>
      {src && (
        <button type="button" className="cv2-thumb" aria-label="Open the screen" onClick={() => props.onOpenDock?.({ tab: "screen", target: last.id })}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" />
        </button>
      )}
    </>
  );
}

// ── Steps of one turn ───────────────────────────────────────────────────────

function Steps({ turn, items, detail, props, now }: { turn: Turn; items: TurnItem[]; detail: boolean; props: ThreadProps; now: number }) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "subagent") {
      const by = new Map<string, SubagentItem>();
      while (i < items.length && items[i].kind === "subagent") {
        const s = items[i++] as SubagentItem;
        by.set(s.agentId, s);
      }
      i--;
      out.push(<TeamGroup key={`team-${item.id}`} items={[...by.values()]} props={props} forceOpen={detail} />);
      continue;
    }
    if (item.kind === "computer_action") {
      const group: ComputerActionItem[] = [];
      while (i < items.length && items[i].kind === "computer_action") group.push(items[i++] as ComputerActionItem);
      i--;
      out.push(<ComputerLine key={`cu-${item.id}`} items={group} props={props} />);
      continue;
    }
    if (item.kind === "search" && item.scope === "files" && item.matches === undefined) {
      const group: Extract<TurnItem, { kind: "search" }>[] = [];
      while (i < items.length && items[i].kind === "search" && (items[i] as Extract<TurnItem, { kind: "search" }>).scope === "files" && (items[i] as Extract<TurnItem, { kind: "search" }>).matches === undefined)
        group.push(items[i++] as Extract<TurnItem, { kind: "search" }>);
      i--;
      if (group.length > 1) {
        out.push(<ReadsRow key={`reads-${item.id}`} items={group} forceOpen={detail} onOpenDock={props.onOpenDock} />);
        continue;
      }
    }
    if (item.kind === "plan" && item.awaitingApproval) {
      out.push(<PlanBlock key={item.id} item={item} />);
      continue;
    }
    if (item.kind === "assistant_message") {
      if (item.agentId) continue; // a subagent's words live in the Agents panel
      out.push(
        <div key={item.id} className="cv2-prose" style={{ padding: "6px 0" }}>
          <Markdown content={item.text} streaming={item.streaming} />
        </div>,
      );
      continue;
    }
    if (item.kind === "user_message") {
      out.push(
        <div key={item.id} className="cv2-you-wrap" style={{ margin: "8px 0" }}>
          <div className="cv2-you">{item.text}</div>
          <div className="cv2-you-cap">{item.delivery === "steer" ? "Steered" : "Queued"}</div>
        </div>,
      );
      continue;
    }
    if (item.kind === "conversation_message") {
      out.push(
        <CrossMessageRow
          key={item.id}
          className="my-2"
          row={{ id: item.id, direction: item.direction, peerTitle: item.peerTitle, peerHref: peerHref(item.peerRef), text: item.text, ...(item.status ? { status: item.status } : {}) }}
        />,
      );
      continue;
    }
    if (item.kind === "system_notice") {
      out.push(
        <div key={item.id} className="cv2-wl">
          <span className="obj">{item.text}</span>
        </div>,
      );
      continue;
    }
    if (item.kind === "compaction") {
      out.push(<CompactionRow key={item.id} before={item.beforeTokens} after={item.afterTokens} summary={item.summary} forceOpen={detail} />);
      continue;
    }
    if (item.kind === "error") {
      out.push(
        <div key={item.id} className="cv2-err" role="alert">
          <span>{item.message}</span>
          {item.retryable && props.onRetry && (
            <button type="button" className="cv2-link" onClick={props.onRetry}>
              Retry
            </button>
          )}
        </div>,
      );
      continue;
    }
    const line = lineFor(item, now, props.onOpenDock);
    if (line) out.push(<LogRow key={line.key} line={line} forceOpen={detail && line.expand?.kind === "prose"} onOpenDock={props.onOpenDock} />);
  }
  void turn;
  return <div className="cv2-log">{out}</div>;
}

function CompactionRow({ before, after, summary, forceOpen }: { before: number; after: number; summary?: string; forceOpen: boolean }) {
  const line: LogLine = { key: "c", verb: "Compacted", body: `${formatTokens(before)} to ${formatTokens(after)}`, live: false, expand: summary ? { kind: "prose", text: summary } : null };
  return <LogRow line={line} forceOpen={forceOpen} />;
}

/** Plan mode: the plan is prose and a checklist; Approve and Revise live in the composer. */
function PlanBlock({ item }: { item: PlanItem }) {
  return (
    <div className="cv2-col" style={{ gap: 4, margin: "4px 0" }} aria-label="Plan">
      {item.text && (
        <div className="cv2-prose">
          <Markdown content={item.text} />
        </div>
      )}
      {item.steps?.length ? <Checklist steps={item.steps} /> : null}
    </div>
  );
}

/** "Changed 3 files +16 −4" after the answer: the only box in a turn. */
export function Receipt({ turn, onOpenDock, onUndo }: { turn: Turn; onOpenDock?: (r: DockRequest) => void; onUndo?: () => void }) {
  const [more, setMore] = React.useState(false);
  const files = turn.changes;
  if (!files.length) return null;
  const adds = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const dels = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  const shown = more || files.length <= 4 ? files : files.slice(0, 4);
  return (
    <div className="cv2-card">
      <div className="ch">
        <span className="cv2-m">
          Changed {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="cv2-small cv2-tnum">
          <span className="cv2-add">+{adds}</span> <span className="cv2-del">−{dels}</span>
        </span>
        <span className="cv2-grow" />
        {onUndo && (
          <button type="button" className="cv2-btn ghost" onClick={onUndo}>
            Undo
          </button>
        )}
        <button type="button" className="cv2-btn" onClick={() => onOpenDock?.({ tab: "changes", scope: "turn", turnId: turn.id })}>
          Review
        </button>
      </div>
      {shown.map((f) => {
        const { name, dir } = splitPath(f.path);
        return (
          <button key={f.path} type="button" className="cf" title={f.path} onClick={() => onOpenDock?.({ tab: "changes", target: f.path, scope: "turn", turnId: turn.id })}>
            <span className="cv2-fg">{name}</span>
            <span className="dir cv2-trunc">{dir.replace(/\/$/, "")}</span>
            <span className="n">
              <span className="cv2-add">+{f.additions ?? 0}</span> <span className="cv2-del">−{f.deletions ?? 0}</span>
            </span>
          </button>
        );
      })}
      {!more && files.length > 4 && (
        <button type="button" className="cf more" onClick={() => setMore(true)}>
          Show all {files.length}
        </button>
      )}
    </div>
  );
}

// ── Turns ───────────────────────────────────────────────────────────────────

function UserBubble({ turn, revert }: { turn: Turn; revert?: { onConfirm: () => void; files: number; turns: number } }) {
  const [confirm, setConfirm] = React.useState(false);
  const u = turn.user!;
  return (
    <div className="cv2-you-wrap" data-turn-start>
      <div className="cv2-you">
        {u.attachments?.length ? (
          <div className="files">
            {u.attachments.map((a, i) => (
              <span key={i} className="file">
                <Glyph name="document" size={12} />
                {a.name}
              </span>
            ))}
          </div>
        ) : null}
        {u.text}
      </div>
      <div className="cv2-you-meta" data-on={confirm ? "true" : undefined}>
        {confirm && revert ? (
          <>
            <span className="cv2-fg">
              Revert {revert.files} {revert.files === 1 ? "file" : "files"} and {revert.turns} {revert.turns === 1 ? "turn" : "turns"}?
            </span>
            <button type="button" onClick={() => (setConfirm(false), revert.onConfirm())}>
              Revert
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="cv2-tnum">{clock(u.createdAt)}</span>
            {revert && (
              <button type="button" onClick={() => setConfirm(true)}>
                Revert to here
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TurnView({
  turn,
  props,
  unfolded,
  onToggle,
  now,
  revert,
}: {
  turn: Turn;
  props: ThreadProps;
  unfolded: boolean | undefined;
  onToggle: (open: boolean) => void;
  now: number;
  revert?: { onConfirm: () => void; files: number; turns: number };
}) {
  const vis = turnVisibility(turn, props.detailLevel, unfolded);
  const steps = stepItems(turn);
  const open = vis.steps;
  const visibleSteps = open ? steps : steps.filter((i) => i.kind === "plan" && i.awaitingApproval);
  const live = turn.status === "running" || turn.status === "waiting";
  return (
    <section data-turn={turn.id} aria-label={`Turn ${turn.ordinal + 1}`} className="cv2-turn">
      {turn.user && <UserBubble turn={turn} revert={revert} />}
      {vis.header && steps.length > 0 && (
        <button type="button" className="cv2-foldh" aria-expanded={open} onClick={() => onToggle(!open)}>
          <span className="cv2-tnum">{turnHeader(turn, now)}</span>
          <Glyph name="chevron-right" size={14} className="chev" />
          <span className="rule" aria-hidden />
          <span className="when cv2-tnum">{clock(turn.endedAt ?? turn.startedAt)}</span>
        </button>
      )}
      {live && steps.length === 0 && (
        <div className="cv2-wl">
          <span className="verb cv2-shine">Working</span>
        </div>
      )}
      {vis.header ? (
        <div className={cn("cv2-fold", open && "open")}>
          <div className="cv2-fold-inner">{open && <Steps turn={turn} items={steps} detail={vis.detail} props={props} now={now} />}</div>
        </div>
      ) : (
        visibleSteps.length > 0 && <Steps turn={turn} items={visibleSteps} detail={vis.detail} props={props} now={now} />
      )}
      {turn.answer && (
        <div className="cv2-prose">
          <Markdown content={turn.answer.text} streaming={turn.answer.streaming} />
        </div>
      )}
      {!live && <Receipt turn={turn} onOpenDock={props.onOpenDock} onUndo={props.onUndoTurn ? () => props.onUndoTurn?.(turn) : undefined} />}
    </section>
  );
}

/** The navigator rail: one tick per turn; hover names it, click scrolls to it. */
function TurnRail({ turns, onJump, current }: { turns: Turn[]; onJump: (id: string) => void; current: string | null }) {
  const marks = turnMarks(turns);
  if (marks.length < 3) return null;
  return (
    <nav className="cv2-nav-rail" aria-label="Turns">
      {marks.map((m) => (
        <button key={m.id} type="button" className="cv2-nav-tick" aria-current={current === m.id ? "true" : undefined} aria-label={`Turn ${m.ordinal + 1}: ${m.label}`} onClick={() => onJump(m.id)}>
          <span className="cv2-nav-tip">
            {m.label}
            {m.changed ? `, ${m.changed} ${m.changed === 1 ? "file" : "files"}` : ""}
          </span>
        </button>
      ))}
    </nav>
  );
}

export function Thread(props: ThreadProps) {
  const { items, state } = props;
  const turns = React.useMemo(() => groupTurns(items, { state }), [items, state]);
  const live = state === "running" || state === "waiting";
  const now = useNow(live && !props.offline);
  const [unfolded, setUnfolded] = React.useState<Record<string, boolean>>({});
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  const [current, setCurrent] = React.useState<string | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const sections = el.querySelectorAll<HTMLElement>("[data-turn]");
    let cur: string | null = null;
    for (const s of sections) if (s.offsetTop - el.scrollTop < el.clientHeight * 0.4) cur = s.dataset.turn ?? null;
    setCurrent(cur);
  };
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const jump = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // Reverting to the start of turn i rolls back to the checkpoint the turn before it left.
  const reverts = React.useMemo(
    () =>
      turns.map((t, i) => {
        const cp = i > 0 ? turns[i - 1].checkpoint : undefined;
        if (!cp || !props.onRollback) return undefined;
        const later = turns.slice(i);
        return {
          onConfirm: () => props.onRollback?.(cp.checkpointId),
          turns: later.filter((x) => x.user).length,
          files: new Set(later.flatMap((x) => x.changes.map((c) => c.path))).size,
        };
      }),
    [turns, props],
  );

  return (
    <div className="cv2-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="cv2-col">
        {props.starting && (
          <div className="cv2-wl">
            <span className="verb cv2-shine">{props.starting}</span>
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnView key={turn.id} turn={turn} props={props} now={now} unfolded={unfolded[turn.id]} onToggle={(open) => setUnfolded((u) => ({ ...u, [turn.id]: open }))} revert={reverts[i]} />
        ))}
        {props.offline && live && <div className="cv2-notice" style={{ marginTop: 16 }}>Paused while offline</div>}
        {props.pairingRequired && (
          <div className="cv2-notice" role="status" style={{ marginTop: 16 }}>
            This browser cannot control {props.pairingRequired.deviceName} yet.{" "}
            <a href="/pair" className="underline underline-offset-4">
              Pair this browser
            </a>
          </div>
        )}
      </div>
      <TurnRail turns={turns} onJump={jump} current={current} />
    </div>
  );
}

/** Loading a session: three skeleton lines where the thread will be. */
export function ThreadSkeleton() {
  return (
    <div className="cv2-scroll">
      <div className="cv2-col cv2-skel" aria-busy="true" aria-label="Loading">
        <i style={{ width: "46%", alignSelf: "flex-end", height: 36, borderRadius: 18 }} />
        <i style={{ width: "88%" }} />
        <i style={{ width: "72%" }} />
      </div>
    </div>
  );
}

export type { TodoListItem };
