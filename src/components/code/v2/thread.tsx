"use client";

/**
 * The thread (DESIGN §5.1–§5.4, §5.12, §5.15; INTERACTION I-6, I-7, I-8, I-12):
 * turns grouped from normalized `TurnItem`s, each settled turn folding to
 * "Worked for 4m 12s" at the reader's work-log detail level, the answer and
 * the changed-files receipt always visible below the fold, step rows that link
 * into the dock, the agent tree, the computer-use timeline, checkpoints with
 * "Edit from here", and the turn navigator rail on the right edge.
 */
import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import { ComputerTimeline } from "@/components/code/computer-timeline";
import type {
  CheckpointItem,
  PlanItem,
  ProviderInstance,
  SessionState,
  SubagentItem,
  TodoListItem,
  TurnItem,
} from "@/lib/code-v2/contracts";
import type { DockTab } from "@/lib/code-v2/dock";
import { formatTokens } from "@/lib/code-v2/tier-view";
import {
  describeItem,
  groupTurns,
  stepItems,
  turnHeader,
  turnMarks,
  turnVisibility,
  type DetailLevel,
  type Turn,
} from "@/lib/code-v2/turns";
import { AgentTree } from "./agent-tree";
import { Glyph, Spinner, useNow } from "./primitives";
import { cn } from "@/lib/utils";

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
  resolveScreenshot?: (ref: string) => string | null;
}

// ── Step rows ───────────────────────────────────────────────────────────────

function StepRowView({ item, detail, onOpenDock, now, delay }: { item: TurnItem; detail: boolean; onOpenDock?: (r: DockRequest) => void; now: number; delay: number }) {
  const row = describeItem(item, now);
  const [open, setOpen] = React.useState(false);
  if (!row) return null;
  const running = row.tone === "running";
  const target: DockRequest | null =
    item.kind === "file_change"
      ? { tab: "changes", target: item.changes[0]?.path, scope: "turn", turnId: item.turnId }
      : item.kind === "command_execution"
        ? { tab: "terminal", target: item.id }
        : item.kind === "computer_action"
          ? { tab: "screen", target: item.id }
          : null;
  const expandable = !!row.detail && (item.kind === "reasoning" || item.kind === "plan");
  const showDetail = row.detail && (detail || open);
  const body = (
    <>
      {running ? <Spinner /> : <Glyph name={row.glyph} />}
      <span className={cn("verb", running && "cv2-shimmer")}>{row.verb}</span>
      {row.object && <span className={cn("obj", row.mono && "cv2-mono", running && "cv2-shimmer")}>{row.object}</span>}
      {(row.additions !== undefined || row.deletions !== undefined) && !running && (row.additions || row.deletions) ? (
        <span className="cv2-tnum" style={{ whiteSpace: "nowrap" }}>
          <span className="cv2-add">+{row.additions ?? 0}</span> <span className="cv2-del">−{row.deletions ?? 0}</span>
        </span>
      ) : null}
      {row.meta && <span className="t">{row.meta}</span>}
    </>
  );
  const cls = cn("cv2-step", row.tone === "error" && "error", row.tone === "needs" && "needs");
  return (
    <>
      {target || expandable ? (
        <button
          type="button"
          className={cls}
          style={{ animationDelay: `${delay}ms` }}
          aria-expanded={expandable ? open || detail : undefined}
          onClick={() => (expandable ? setOpen((v) => !v) : target && onOpenDock?.(target))}
        >
          {body}
        </button>
      ) : (
        <div className={cls} style={{ animationDelay: `${delay}ms` }}>
          {body}
        </div>
      )}
      {showDetail && <div className="cv2-detail">{row.detail}</div>}
      {row.tail && (running || detail) && (
        <div className="cv2-tail" aria-live={running ? "polite" : undefined}>
          {row.tail.map((l, i) => (
            <div key={`${i}:${l}`}>{l}</div>
          ))}
        </div>
      )}
    </>
  );
}

function Checklist({ steps }: { steps: { text: string; status: string }[] }) {
  return (
    <div className="cv2-col" style={{ gap: 4 }}>
      {steps.map((s, i) => (
        <div key={i} className={cn("cv2-plan-step", s.status === "completed" && "done")}>
          {s.status === "completed" ? <Glyph name="check" /> : s.status === "in_progress" ? <Spinner /> : <Glyph name="circle-dashed" />}
          <span>{s.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Plan mode: the plan waits for the reader (coral edge, one of the two needs-you objects). */
function PlanCard({ item, onApprove }: { item: PlanItem; onApprove?: (id: string, approve: boolean) => void }) {
  return (
    <div className={cn("cv2-plan", item.awaitingApproval && "awaiting")} role={item.awaitingApproval ? "group" : undefined} aria-label="Plan">
      <div className="cv2-row" style={{ gap: 10 }}>
        <Glyph name="plan" className={item.awaitingApproval ? "cv2-sig" : "cv2-mute"} />
        <span className="cv2-m">{item.awaitingApproval ? "Plan, waiting for you" : "Plan"}</span>
        {item.steps?.length ? <span className="cv2-mute">{item.steps.length} tasks</span> : null}
      </div>
      {item.text && (
        <div className="cv2-prose" style={{ fontSize: 13.5, lineHeight: "21px" }}>
          <Markdown content={item.text} />
        </div>
      )}
      {item.steps?.length ? <Checklist steps={item.steps} /> : null}
      {item.awaitingApproval && (
        <div className="cv2-row" style={{ gap: 8, marginTop: 4 }}>
          <button type="button" className="cv2-btn ghost" onClick={() => onApprove?.(item.id, false)}>
            Revise
          </button>
          <span className="cv2-grow" />
          <button type="button" className="cv2-btn ink" onClick={() => onApprove?.(item.id, true)}>
            Approve and build
          </button>
        </div>
      )}
    </div>
  );
}

function TodoBlock({ item }: { item: TodoListItem }) {
  const [open, setOpen] = React.useState(false);
  const done = item.todos.filter((t) => t.status === "completed").length;
  return (
    <>
      <button type="button" className="cv2-step" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Glyph name="list" />
        <span className="verb">Tasks</span>
        <span className="obj">
          {done} of {item.todos.length} done
        </span>
      </button>
      {open && (
        <div style={{ paddingLeft: 28, paddingBottom: 6 }}>
          <Checklist steps={item.todos} />
        </div>
      )}
    </>
  );
}

/** The step list of one turn, grouping fan-outs into trees and computer runs into a timeline. */
function Steps({
  turn,
  items,
  detail,
  props,
  now,
}: {
  turn: Turn;
  items: TurnItem[];
  detail: boolean;
  props: ThreadProps;
  now: number;
}) {
  const out: React.ReactNode[] = [];
  let staggered = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "subagent") {
      const group: SubagentItem[] = [];
      while (i < items.length && items[i].kind === "subagent") group.push(items[i++] as SubagentItem);
      i--;
      out.push(
        <AgentTree
          key={`tree-${group[0].id}`}
          items={group}
          instances={props.instances}
          budgetUsd={props.budgetUsd}
          selectedId={props.selectedAgentId}
          onSelect={(id) => {
            props.onSelectAgent?.(id);
            props.onOpenDock?.({ tab: "agents", target: id });
          }}
        />,
      );
      continue;
    }
    if (item.kind === "computer_action") {
      const group: TurnItem[] = [];
      while (i < items.length && items[i].kind === "computer_action") group.push(items[i++]);
      i--;
      out.push(
        <div key={`cu-${group[0].id}`} className="cv2-cu">
          <ComputerTimeline
            items={group}
            resolveScreenshot={props.resolveScreenshot}
            defaultCollapsed={turn.status === "done"}
            onSelectStep={(frame) => props.onOpenDock?.({ tab: "screen", target: frame.id })}
          />
        </div>,
      );
      continue;
    }
    if (item.kind === "plan" && item.awaitingApproval) {
      out.push(<PlanCard key={item.id} item={item} onApprove={props.onApprovePlan} />);
      continue;
    }
    if (item.kind === "plan" && item.steps?.length && detail) {
      out.push(
        <div key={item.id}>
          <StepRowView item={item} detail={false} onOpenDock={props.onOpenDock} now={now} delay={0} />
          <div style={{ paddingLeft: 28, paddingBottom: 6 }}>
            <Checklist steps={item.steps} />
          </div>
        </div>,
      );
      continue;
    }
    if (item.kind === "todo_list") {
      out.push(<TodoBlock key={item.id} item={item} />);
      continue;
    }
    if (item.kind === "assistant_message") {
      if (item.agentId) continue; // a subagent's words live in Dock › Agents
      out.push(
        <div key={item.id} className="cv2-prose" style={{ padding: "4px 0" }}>
          <Markdown content={item.text} streaming={item.streaming} />
        </div>,
      );
      continue;
    }
    if (item.kind === "user_message") {
      out.push(
        <React.Fragment key={item.id}>
          <div className="cv2-you" style={{ margin: "6px 0" }}>
            {item.text}
          </div>
          <div className="cv2-you-cap" style={{ marginTop: -2 }}>
            {item.delivery === "steer" ? "Steered" : "Queued"}
          </div>
        </React.Fragment>,
      );
      continue;
    }
    if (item.kind === "system_notice") {
      out.push(
        <div key={item.id} className="cv2-notice" style={{ padding: "4px 0" }}>
          {item.text}
        </div>,
      );
      continue;
    }
    if (item.kind === "compaction") {
      out.push(<CompactionDivider key={item.id} before={item.beforeTokens} after={item.afterTokens} summary={item.summary} />);
      continue;
    }
    if (item.kind === "error") {
      out.push(
        <div key={item.id} className="cv2-error" role="alert" style={{ minHeight: 28 }}>
          <Glyph name="error-circle" />
          <span className="msg">{item.message}</span>
          {item.retryable && props.onRetry && (
            <button type="button" className="cv2-btn sm" onClick={props.onRetry}>
              Retry
            </button>
          )}
        </div>,
      );
      continue;
    }
    const delay = staggered < 5 ? staggered * 30 : 150;
    staggered++;
    out.push(<StepRowView key={item.id} item={item} detail={detail} onOpenDock={props.onOpenDock} now={now} delay={delay} />);
  }
  return <div className="cv2-steps">{out}</div>;
}

function CompactionDivider({ before, after, summary }: { before: number; after: number; summary?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="cv2-divider" style={{ width: "100%" }} aria-expanded={open} onClick={() => summary && setOpen((v) => !v)}>
        <span>
          Compacted {formatTokens(before)} to {formatTokens(after)}
        </span>
        <span className="rule" />
      </button>
      {open && summary && <div className="cv2-detail">{summary}</div>}
    </>
  );
}

function CheckpointDivider({ item, onRollback, filesAfter, turnsAfter }: { item: CheckpointItem; onRollback?: (id: string) => void; filesAfter: number; turnsAfter: number }) {
  const [confirm, setConfirm] = React.useState(false);
  return (
    <div className="cv2-divider">
      {confirm ? (
        <span className="cv2-roll cv2-row" style={{ gap: 8 }}>
          <span style={{ color: "hsl(var(--foreground))" }}>
            Revert {filesAfter} {filesAfter === 1 ? "file" : "files"} and {turnsAfter} {turnsAfter === 1 ? "turn" : "turns"}?
          </span>
          <button
            type="button"
            className="cv2-btn sm"
            onClick={() => {
              setConfirm(false);
              onRollback?.(item.checkpointId);
            }}
          >
            Revert
          </button>
          <button type="button" className="cv2-btn sm ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <span>Checkpoint {item.turnOrdinal}</span>
      )}
      <span className="rule" />
      {!confirm && onRollback && turnsAfter > 0 && (
        <button type="button" className="edit cv2-btn sm ghost" onClick={() => setConfirm(true)}>
          Edit from here
        </button>
      )}
    </div>
  );
}

/** "Changed 3 files" receipt at the end of a turn (DESIGN §5.2). */
export function Receipt({ turn, onOpenDock, onUndo }: { turn: Turn; onOpenDock?: (r: DockRequest) => void; onUndo?: () => void }) {
  const [more, setMore] = React.useState(false);
  const files = turn.changes;
  if (!files.length) return null;
  const adds = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const dels = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  const shown = more || files.length <= 5 ? files : files.slice(0, 4);
  return (
    <div className="cv2-receipt">
      <div className="rh">
        <Glyph name="diff" />
        <span className="cv2-m">
          Changed {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="cv2-tnum">
          <span className="cv2-add">+{adds}</span> <span className="cv2-del">−{dels}</span>
        </span>
        <span className="cv2-grow" />
        {onUndo && (
          <button type="button" className="cv2-btn ghost" onClick={onUndo}>
            <Glyph name="undo" size={14} /> Undo
          </button>
        )}
        <button type="button" className="cv2-btn" onClick={() => onOpenDock?.({ tab: "changes", scope: "turn", turnId: turn.id })}>
          Review
        </button>
      </div>
      {shown.map((f) => (
        <button key={f.path} type="button" className="rf" onClick={() => onOpenDock?.({ tab: "changes", target: f.path, scope: "turn", turnId: turn.id })}>
          <span className="cv2-mono cv2-trunc cv2-grow">{f.path}</span>
          <span className="cv2-tnum">
            <span className="cv2-add">+{f.additions ?? 0}</span> <span className="cv2-del">−{f.deletions ?? 0}</span>
          </span>
        </button>
      ))}
      {!more && files.length > 5 && (
        <button type="button" className="rf cv2-mute" onClick={() => setMore(true)}>
          Show {files.length - 4} more
        </button>
      )}
    </div>
  );
}

// ── Turns ───────────────────────────────────────────────────────────────────

function TurnView({
  turn,
  props,
  unfolded,
  onToggle,
  now,
  after,
}: {
  turn: Turn;
  props: ThreadProps;
  unfolded: boolean | undefined;
  onToggle: (open: boolean) => void;
  now: number;
  after: { files: number; turns: number };
}) {
  const vis = turnVisibility(turn, props.detailLevel, unfolded);
  const steps = stepItems(turn);
  // Live turns and plan approvals never hide; folding only touches settled work.
  const open = vis.steps;
  const visibleSteps = open ? steps : steps.filter((i) => i.kind === "plan" && i.awaitingApproval);
  return (
    <section data-turn={turn.id} aria-label={`Turn ${turn.ordinal + 1}`} className="cv2-col" style={{ gap: 10 }}>
      {turn.user && (
        <div className="cv2-you" data-turn-start>
          {turn.user.attachments?.length ? (
            <div className="cv2-mute" style={{ fontSize: 12, marginBottom: 4 }}>
              {turn.user.attachments.map((a) => a.name).join(", ")}
            </div>
          ) : null}
          {turn.user.text}
        </div>
      )}
      {vis.header && steps.length > 0 && (
        <button type="button" className="cv2-turnhead" aria-expanded={open} onClick={() => onToggle(!open)}>
          <Glyph name="chevron-right" size={14} className="chev" />
          <span className="cv2-tnum">{turnHeader(turn, now)}</span>
          <span className="rule" />
        </button>
      )}
      {!vis.header && turn.status === "running" && steps.length === 0 && (
        <div className="cv2-step">
          <Spinner />
          <span className="verb cv2-shimmer">Working</span>
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
      {turn.status !== "running" && turn.status !== "waiting" && (
        <Receipt turn={turn} onOpenDock={props.onOpenDock} onUndo={props.onUndoTurn ? () => props.onUndoTurn?.(turn) : undefined} />
      )}
      {turn.checkpoint && <CheckpointDivider item={turn.checkpoint} onRollback={props.onRollback} filesAfter={after.files} turnsAfter={after.turns} />}
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
        <button
          key={m.id}
          type="button"
          className={cn("cv2-nav-tick", m.status === "waiting" && "needs")}
          aria-current={current === m.id ? "true" : undefined}
          aria-label={`Turn ${m.ordinal + 1}: ${m.label}`}
          onClick={() => onJump(m.id)}
        >
          <span className="cv2-nav-tip">
            {m.label}
            {m.changed ? ` · ${m.changed} ${m.changed === 1 ? "file" : "files"}` : ""}
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

  // Pinned to the end while the reader is at the end (DESIGN §4.2).
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

  // What reverting a checkpoint would undo: the turns after it and their files.
  const afterCounts = React.useMemo(
    () =>
      turns.map((_, i) => {
        const later = turns.slice(i + 1);
        return { turns: later.filter((t) => t.user).length, files: new Set(later.flatMap((t) => t.changes.map((c) => c.path))).size };
      }),
    [turns],
  );

  return (
    <div className="cv2-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="cv2-col" style={{ gap: 22 }}>
        {props.starting && (
          <div className="cv2-notice cv2-row" style={{ gap: 8 }}>
            <Spinner size={14} /> {props.starting}
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnView
            key={turn.id}
            turn={turn}
            props={props}
            now={now}
            unfolded={unfolded[turn.id]}
            onToggle={(open) => setUnfolded((u) => ({ ...u, [turn.id]: open }))}
            after={afterCounts[i]}
          />
        ))}
        {props.offline && live && <div className="cv2-notice">Paused while offline</div>}
      </div>
      <TurnRail turns={turns} onJump={jump} current={current} />
    </div>
  );
}
