"use client";

/**
 * The composer (DESIGN §5.5, §5.6, §5.10, §5.14, §6; INTERACTION I-1, I-2,
 * I-9, I-13, I-17): the one elevated object, and the one that carries state.
 * Idle it floats; working it wears the travelling coral edge; when the agent
 * needs the reader the approval takes the composer over in place. Limited,
 * offline, starting, no-provider and child-thread states live here too, as
 * words, never pills.
 *
 * Enter sends (queues while a turn runs), ⌘↵ steers, Shift+Enter is a
 * newline, Esc Esc stops, ⌥↑ edits the last queued message. `/` and `@` open
 * the command and mention menus at the caret.
 */
import * as React from "react";
import type { ApprovalDecision, ApprovalRequestItem, ProviderInstance, TurnItem, UserInputRequestItem } from "@/lib/code-v2/contracts";
import {
  SLASH_COMMANDS,
  applyTrigger,
  composerKeyIntent,
  detectTrigger,
  escPress,
  filterByQuery,
  placeholderFor,
  rankFiles,
  sendButtonMode,
  visibleQueue,
  type QueueRow,
  type Trigger,
} from "@/lib/code-v2/composer";
import { orchestrateLabel } from "@/lib/code-v2/orchestrate";
import { displayName, planName } from "@/lib/code-v2/providers-view";
import { formatReset, tightestWindow } from "@/lib/code-v2/tier-view";
import { findInstance, runtimeModeInfo, shortLabel } from "./model-info";
import { ContextGauge, ModeMenu, ModelPicker, OrchestratePopover, TierPopover, TraitsMenu, traitsLabel } from "./pickers";
import { Glyph, InstanceMark, Kbd, ModelMark, Roll, useIsMac } from "./primitives";
import type { WorkspaceModel } from "./types";
import { cn } from "@/lib/utils";

export type PopoverName = "model" | "traits" | "tier" | "orchestrate" | "mode" | "attach" | null;

type Pending = ApprovalRequestItem | UserInputRequestItem;

export function pendingRequests(items: readonly TurnItem[]): Pending[] {
  return items.filter(
    (i): i is Pending => (i.kind === "approval_request" || i.kind === "user_input_request") && i.status === "pending",
  );
}

const ACTION_PHRASE: Record<ApprovalRequestItem["action"], string> = {
  command: "wants to run a command",
  file_change: "wants to edit files",
  permissions: "wants to write outside the workspace",
  tool: "wants to use a tool",
  computer: "wants to use the computer",
};

// ── Approval takeover ───────────────────────────────────────────────────────

function ApprovalTakeover({
  requests,
  index,
  onIndex,
  onRespond,
  onShowDiff,
  mac,
}: {
  requests: Pending[];
  index: number;
  onIndex: (i: number) => void;
  onRespond: (requestId: string, decision: ApprovalDecision, answers?: Record<string, string[]>) => void;
  onShowDiff?: () => void;
  mac: boolean;
}) {
  const req = requests[Math.min(index, requests.length - 1)];
  const primary = React.useRef<HTMLButtonElement>(null);
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [other, setOther] = React.useState("");
  React.useEffect(() => {
    primary.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    setAnswers({});
    setOther("");
  }, [req?.id]);
  if (!req) return null;
  const many = requests.length > 1;
  const who = req.kind === "approval_request" ? (req.agentLabel ?? "Alevr") : "Alevr";
  const header = req.kind === "approval_request" ? `${who} ${ACTION_PHRASE[req.action]}` : req.questions[0]?.prompt ?? "A question for you";
  const opts = req.kind === "approval_request" ? (req.options ?? ["accept", "acceptForSession", "decline"]) : [];

  return (
    <div className="cv2-approve" role="alertdialog" aria-label={header} key={req.id}>
      <div className="ah">
        <Glyph name="needs-you" size={18} />
        <span className="cv2-m cv2-grow">{header}</span>
        {many && (
          <span className="cv2-row cv2-mute cv2-tnum" style={{ gap: 2 }}>
            <button type="button" className="cv2-iconbtn" style={{ width: 24, height: 24 }} aria-label="Previous request" onClick={() => onIndex((index - 1 + requests.length) % requests.length)}>
              <Glyph name="chevron-left" size={14} />
            </button>
            <Roll k={index}>
              {index + 1} of {requests.length}
            </Roll>
            <button type="button" className="cv2-iconbtn" style={{ width: 24, height: 24 }} aria-label="Next request" onClick={() => onIndex((index + 1) % requests.length)}>
              <Glyph name="chevron-right" size={14} />
            </button>
          </span>
        )}
      </div>
      {req.kind === "approval_request" ? (
        <>
          {req.action === "file_change" ? (
            <div className="cv2-well cv2-row" style={{ gap: 10, whiteSpace: "normal" }}>
              <span className="cv2-grow cv2-trunc">{req.summary}</span>
              {onShowDiff && (
                <button type="button" className="cv2-btn sm" onClick={onShowDiff}>
                  Show diff
                </button>
              )}
            </div>
          ) : (
            <div className="cv2-well">{req.detail ?? req.summary}</div>
          )}
          {req.justification && <div className="why">{req.justification}</div>}
          <div className="cv2-approve-actions">
            {opts.includes("decline") && (
              <button type="button" className="cv2-btn ghost" onClick={() => onRespond(req.requestId, "decline")}>
                Deny <Kbd k="escape" mac={mac} />
              </button>
            )}
            {opts.includes("cancel") && (
              <button type="button" className="cv2-btn ghost" onClick={() => onRespond(req.requestId, "cancel")}>
                Deny and stop
              </button>
            )}
            <span className="spacer" />
            {opts.includes("acceptForSession") && (
              <button type="button" className="cv2-btn" onClick={() => onRespond(req.requestId, "acceptForSession")}>
                Allow for this session <Kbd k="mod+shift+enter" mac={mac} />
              </button>
            )}
            <button ref={primary} type="button" className="cv2-btn ink" onClick={() => onRespond(req.requestId, "accept")}>
              Allow once <Kbd k="enter" mac={mac} />
            </button>
          </div>
        </>
      ) : (
        <>
          {req.questions.map((q, qi) => (
            <div key={q.id} className="cv2-col" style={{ gap: 6, maxWidth: "none" }}>
              {qi > 0 && <div className="cv2-m">{q.prompt}</div>}
              {(q.options ?? []).map((o) => {
                const on = answers[q.id]?.includes(o) ?? false;
                return (
                  <button
                    key={o}
                    type="button"
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={on}
                    className="cv2-choice"
                    onClick={() =>
                      setAnswers((a) => {
                        const cur = a[q.id] ?? [];
                        return { ...a, [q.id]: q.multiSelect ? (on ? cur.filter((x) => x !== o) : [...cur, o]) : [o] };
                      })
                    }
                  >
                    <Glyph name={on ? "check-circle" : "circle"} className={on ? undefined : "cv2-mute"} />
                    <span>{o}</span>
                  </button>
                );
              })}
              {!(q.options?.length) && (
                <input
                  className="cv2-well"
                  style={{ border: 0, outline: "none", fontFamily: "inherit", fontSize: 14 }}
                  placeholder="Your answer"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                />
              )}
            </div>
          ))}
          <div className="cv2-approve-actions">
            <button type="button" className="cv2-btn ghost" onClick={() => onRespond(req.requestId, "decline")}>
              Skip <Kbd k="escape" mac={mac} />
            </button>
            <span className="spacer" />
            <button
              ref={primary}
              type="button"
              className="cv2-btn ink"
              onClick={() => {
                const merged = { ...answers };
                for (const q of req.questions) if (!q.options?.length && other.trim()) merged[q.id] = [other.trim()];
                onRespond(req.requestId, "accept", merged);
              }}
            >
              Answer <Kbd k="enter" mac={mac} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Queue dock ──────────────────────────────────────────────────────────────

function QueueDock({
  rows,
  mac,
  canSteer,
  onEdit,
  onRemove,
  onMove,
  onSteer,
}: {
  rows: QueueRow[];
  mac: boolean;
  canSteer: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, to: number) => void;
  onSteer: (id: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState<string | null>(null);
  const shown = visibleQueue(rows, expanded);
  if (!rows.length) return null;
  return (
    <div className="cv2-queue" role="list" aria-label="Queued messages">
      {shown.rows.map((r, i) => (
        <div
          key={r.id}
          role="listitem"
          className={cn("cv2-q", drag === r.id && "dragging")}
          draggable={editing !== r.id}
          onDragStart={(e) => {
            setDrag(r.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDrag(null)}
          onDragOver={(e) => {
            e.preventDefault();
            if (drag && drag !== r.id) onMove(drag, i);
          }}
        >
          <Glyph name="corner-down-right" />
          {editing === r.id ? (
            <input
              autoFocus
              defaultValue={r.text}
              aria-label="Edit queued message"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onEdit(r.id, e.currentTarget.value);
                  setEditing(null);
                } else if (e.key === "Escape") setEditing(null);
              }}
              onBlur={(e) => {
                onEdit(r.id, e.currentTarget.value);
                setEditing(null);
              }}
            />
          ) : (
            <span className="txt cv2-trunc cv2-grow">{r.text}</span>
          )}
          <button type="button" className="cv2-iconbtn" style={{ width: 26, height: 26 }} aria-label="Edit" onClick={() => setEditing(r.id)}>
            <Glyph name="edit" size={14} />
          </button>
          <button type="button" className="cv2-iconbtn" style={{ width: 26, height: 26 }} aria-label="Remove from the queue" onClick={() => onRemove(r.id)}>
            <Glyph name="close" size={14} />
          </button>
          {canSteer && (
            <button type="button" className="cv2-btn" onClick={() => onSteer(r.id)}>
              Steer now <Kbd k="mod+enter" mac={mac} />
            </button>
          )}
        </div>
      ))}
      {shown.more > 0 && (
        <button type="button" className="cv2-q cv2-mute" onClick={() => setExpanded(true)}>
          <span style={{ paddingLeft: 26 }}>+{shown.more} more</span>
        </button>
      )}
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

export interface ComposerHandle {
  focus(): void;
  openPopover(name: PopoverName): void;
  editLastQueued(): void;
  setDraft(text: string): void;
}

export const Composer = React.forwardRef<
  ComposerHandle,
  {
    model: WorkspaceModel;
    popover: PopoverName;
    setPopover: (p: PopoverName) => void;
    approvalIndex: number;
    setApprovalIndex: (i: number) => void;
    onOpenDock: (tab: "changes" | "agents") => void;
    onFocusChange?: (focused: boolean) => void;
  }
>(function Composer({ model, popover, setPopover, approvalIndex, setApprovalIndex, onOpenDock, onFocusChange }, ref) {
  const mac = useIsMac();
  const { actions, instances, selection } = model;
  const [draft, setDraft] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [menuIndex, setMenuIndex] = React.useState(0);
  const [escArmed, setEscArmed] = React.useState<number | null>(null);
  const [steered, setSteered] = React.useState(false);
  const [tierDelta, setTierDelta] = React.useState<string | null>(null);
  const [menuDismissed, setMenuDismissed] = React.useState(false);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const footRef = React.useRef<HTMLDivElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  const running = model.state === "running" || model.state === "waiting";
  const instance = findInstance(instances, selection.instanceId);
  const caps = instance?.capabilities;
  const canSteer = caps?.steering ?? true;
  const canQueue = caps?.queue ?? true;
  const pending = pendingRequests(model.items);
  const needs = pending.length > 0;
  const ready = !model.starting && !!instance;
  const hasDraft = draft.trim().length > 0;
  const trigger: Trigger | null = menuDismissed ? null : detectTrigger(draft, caret);
  const menuItems = React.useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "slash") return filterByQuery(SLASH_COMMANDS, trigger.query, (c) => c.name).map((c) => ({ key: c.name, glyph: c.glyph, name: `/${c.name}`, sub: c.description, section: c.section, insert: c.insert ?? `/${c.name} ` }));
    const files = rankFiles(model.files ?? [], trigger.query, 8).map((p) => ({ key: p, glyph: "file-code", name: p, sub: "", section: "Files", insert: `@${p} ` }));
    const agents = filterByQuery(["explorer", "reviewer"], trigger.query, (a) => a).map((a) => ({ key: a, glyph: "agent", name: `@${a}`, sub: a === "explorer" ? "Maps something read-only" : "A second read of the changes", section: "Agents", insert: `@${a} ` }));
    return [...files, ...agents];
  }, [trigger, model.files]);
  const menuOpen = !!trigger && menuItems.length > 0;

  React.useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    openPopover: (p) => setPopover(p),
    editLastQueued: () => {
      const last = model.queue[model.queue.length - 1];
      if (!last) return;
      actions.removeQueued(last.id);
      setDraft(last.text);
      requestAnimationFrame(() => textarea.current?.focus());
    },
    setDraft: (t) => {
      setDraft(t);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(t.length, t.length);
      });
    },
  }));

  // Grow with the content up to 40 vh, then scroll (I-2).
  React.useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft]);

  const submit = (intent: "send" | "queue" | "steer") => {
    const text = draft.trim();
    if (!text) return;
    if (intent === "send") void actions.send(text);
    else if (intent === "queue") actions.queue(text);
    else {
      void actions.steer(text);
      setSteered(true);
      setTimeout(() => setSteered(false), 1200);
    }
    setDraft("");
    setMenuDismissed(false);
  };

  const pick = (i: number) => {
    const item = menuItems[i];
    if (!item || !trigger) return;
    const next = applyTrigger(draft, caret, trigger, item.insert);
    setDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(menuIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && running && !needs) {
      const r = escPress(escArmed, Date.now(), running);
      setEscArmed(r.armedAt);
      if (r.stop) actions.stop();
      else setTimeout(() => setEscArmed((a) => (a !== null && Date.now() - a >= 590 ? null : a)), 620);
      e.preventDefault();
      return;
    }
    const intent = composerKeyIntent(
      { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
      { running, hasDraft, canSteer, canQueue, menuOpen, composing: e.nativeEvent.isComposing },
      mac,
    );
    if (!intent || intent === "newline") return;
    e.preventDefault();
    if (intent === "edit-last-queued") {
      const last = model.queue[model.queue.length - 1];
      if (last) {
        actions.removeQueued(last.id);
        setDraft(last.text);
      }
      return;
    }
    if (intent === "send" && !ready) return;
    submit(intent);
  };

  const mode = sendButtonMode({ running, hasDraft, canQueue, canSteer }, ready);
  const traits = traitsLabel(instances, selection);
  const runtime = runtimeModeInfo(model.runtimeMode);
  const tightest = tightestWindow(instance?.limits);
  const planWaiting = model.items.some((i) => i.kind === "plan" && i.awaitingApproval);
  const glow = needs || planWaiting ? "needs" : running && !model.offline ? "working" : "";
  const todo = [...model.items].reverse().find((i) => i.kind === "todo_list");
  const liveTodo = running && todo && todo.kind === "todo_list" ? todo : null;
  const threadTokens = model.usage?.contextTokens ?? 0;

  // ── Child thread (a subagent in full view) ──
  if (model.child) {
    return (
      <div className="cv2-childbar">
        <Glyph name="subagent" />
        <span className="cv2-grow cv2-trunc">
          <span className="cv2-m">{model.child.label}</span> <span className="cv2-mute">· {model.child.model} · Runs on its own</span>
        </span>
        <button type="button" className="cv2-btn" onClick={() => actions.openThread?.(model.thread.id)}>
          Back to lead
        </button>
      </div>
    );
  }

  let body: React.ReactNode;
  if (needs) {
    body = (
      <ApprovalTakeover
        requests={pending}
        index={approvalIndex}
        onIndex={setApprovalIndex}
        mac={mac}
        onRespond={(id, d, a) => void actions.respond(id, d, a)}
        onShowDiff={() => onOpenDock("changes")}
      />
    );
  } else if (!instances.some((i) => i.status === "ready" || i.status === "limited") || !instance) {
    body = (
      <div className="cv2-limited">
        <span className="cv2-mute">Connect a provider to start.</span>
        <div className="acts">
          <button type="button" className="cv2-btn ink" onClick={actions.openConnections}>
            Open Connections
          </button>
        </div>
      </div>
    );
  } else if (model.state === "limited") {
    const vendor = instance.kind === "claude-agent" ? "Claude" : instance.kind === "codex" ? "ChatGPT" : displayName(instance);
    const at = model.resumeAt ?? tightest?.resetsAt;
    const scheduled = model.scheduledResume;
    body = (
      <div className="cv2-limited">
        <span className="cv2-mute">
          {vendor} plan limit reached.
          {scheduled ? ` Alevr continues at ${formatReset(scheduled.at)}.` : at ? ` Resets at ${formatReset(at)}.` : ""}
        </span>
        <div className="acts">
          {scheduled
            ? actions.cancelResume && (
                <button type="button" className="cv2-btn" onClick={() => actions.cancelResume?.()}>
                  Don&apos;t continue
                </button>
              )
            : actions.resumeAtReset &&
              at && (
                <button type="button" className="cv2-btn ink" onClick={() => void actions.resumeAtReset?.(at)}>
                  Resume at reset
                </button>
              )}
          <button type="button" className="cv2-btn" onClick={() => setPopover("model")}>
            Switch model
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="cv2-draft-wrap">
        <textarea
          ref={textarea}
          className="cv2-draft"
          rows={1}
          value={draft}
          placeholder={placeholderFor(running)}
          aria-label="Message"
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setMenuIndex(0);
            setMenuDismissed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
        />
      </div>
    );
  }

  const planLabel = planName(instance?.account?.plan);
  return (
    <div className="cv2-col" style={{ gap: 8 }}>
      {liveTodo && (
        <div className="cv2-todo-pin" aria-live="polite">
          <Glyph name="list" size={14} />
          <span className="cv2-tnum">
            {liveTodo.todos.filter((t) => t.status === "completed").length} of {liveTodo.todos.length}
          </span>
          <span aria-hidden>·</span>
          <span className="cv2-trunc">{liveTodo.todos.find((t) => t.status === "in_progress")?.text ?? liveTodo.todos.find((t) => t.status === "pending")?.text}</span>
        </div>
      )}
      {!needs && (
        <QueueDock
          rows={model.queue}
          mac={mac}
          canSteer={canSteer && running}
          onEdit={actions.editQueued}
          onRemove={actions.removeQueued}
          onMove={actions.moveQueued}
          onSteer={actions.steerQueued}
        />
      )}
      <div ref={shellRef} className={cn("cv2-composer", glow, steered && "steered")} data-state={glow || "idle"}>
        <span className="cv2-glow" aria-hidden />
        {menuOpen && trigger && (
          <div className="cv2-menu-anchor">
            <div className="cv2-pop" style={{ position: "static", width: "100%" }} role="listbox" aria-label={trigger.kind === "slash" ? "Commands" : "Mentions"}>
              <div className="cv2-pop-body" style={{ paddingTop: 4, maxHeight: 320 }}>
                {menuItems.map((m, i) => (
                  <React.Fragment key={m.key}>
                    {(i === 0 || menuItems[i - 1].section !== m.section) && <div className="cv2-pop-sect">{m.section}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === menuIndex}
                      className="cv2-opt"
                      data-active={i === menuIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(i);
                      }}
                      onMouseEnter={() => setMenuIndex(i)}
                    >
                      <Glyph name={m.glyph} className="cv2-mute" />
                      <span className={cn(trigger.kind === "mention" && m.section === "Files" ? "cv2-mono" : undefined, "cv2-trunc")}>{m.name}</span>
                      {m.sub && <span className="sub cv2-trunc">{m.sub}</span>}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
        {body}
        {!needs && (
          <div className="cv2-cfoot" ref={footRef}>
            <button type="button" className="cv2-ctl" aria-label="Add" aria-expanded={popover === "attach"} onClick={() => setPopover(popover === "attach" ? null : "attach")}>
              <Glyph name="plus" />
            </button>
            <button type="button" className="cv2-ctl" aria-expanded={popover === "mode"} aria-haspopup="menu" onClick={() => setPopover(popover === "mode" ? null : "mode")}>
              <Glyph name={model.interactionMode === "plan" ? "plan" : runtime.glyph} />
              <span className="cv2-trunc cv2-ctl-lbl">{model.interactionMode === "plan" ? `Plan · ${runtime.label}` : runtime.label}</span>
              <Glyph name="chevron-down" size={12} className="cv2-ctl-chev" />
            </button>
            <button type="button" className="cv2-ctl" aria-expanded={popover === "orchestrate"} aria-haspopup="dialog" onClick={() => setPopover(popover === "orchestrate" ? null : "orchestrate")}>
              <Glyph name="workflow" />
              <span className="cv2-ctl-lbl">
                <Roll k={orchestrateLabel(model.routing)}>{orchestrateLabel(model.routing)}</Roll>
              </span>
              <Glyph name="chevron-down" size={12} className="cv2-ctl-chev" />
            </button>
            <span className="cv2-grow" />
            <button
              type="button"
              className="cv2-ctl"
              aria-expanded={popover === "model"}
              aria-haspopup="dialog"
              aria-label={`Model: ${shortLabel(instances, selection)}`}
              onClick={() => setPopover(popover === "model" ? null : "model")}
            >
              {instance && <ModelMark modelId={selection.model} instance={instance} />}
              <span className="v cv2-trunc" style={{ maxWidth: 140 }}>
                {shortLabel(instances, selection)}
              </span>
            </button>
            {(traits.effort || traits.tier) && (
              <button type="button" className="cv2-ctl" aria-expanded={popover === "traits" || popover === "tier"} aria-haspopup="menu" onClick={() => setPopover(popover === "traits" ? null : "traits")}>
                {traits.effort && <Roll k={traits.effort}>{traits.effort}</Roll>}
                {traits.effort && traits.tier && <span aria-hidden>·</span>}
                {traits.tier && <Roll k={traits.tier}>{traits.tier}</Roll>}
                {traits.fast && <span>· Fast</span>}
                {tierDelta && (
                  <span className="delta cv2-tnum" key={tierDelta}>
                    {tierDelta}
                  </span>
                )}
                <Glyph name="chevron-down" size={12} className="cv2-ctl-chev" />
              </button>
            )}
            <ContextGauge usage={model.usage} planLabel={planLabel} onCompact={actions.compact} />
            <button
              type="button"
              className="cv2-send"
              data-mode={mode}
              disabled={mode === "disabled"}
              aria-label={mode === "stop" ? "Stop" : mode === "queue" ? "Queue" : "Send"}
              onClick={() => (mode === "stop" ? actions.stop() : submit(running ? (canQueue ? "queue" : "steer") : "send"))}
            >
              <span className="glyph">
                <Glyph name="arrow-up" />
              </span>
              <span className="stop" />
            </button>

            {popover === "attach" && (
              <div className="cv2-pop" style={{ left: 0, width: 260, padding: 4 }} role="menu" aria-label="Add">
                <button type="button" role="menuitem" className="cv2-opt" onClick={() => (setPopover(null), setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@`), textarea.current?.focus())}>
                  <Glyph name="at" className="cv2-mute" /> Mention a file
                </button>
                <button type="button" role="menuitem" className="cv2-opt" onClick={() => (setPopover(null), setDraft("/"), textarea.current?.focus())}>
                  <Glyph name="slash" className="cv2-mute" /> Run a command
                </button>
                <button type="button" role="menuitem" className="cv2-opt" onClick={() => (setPopover(null), onOpenDock("agents"))}>
                  <Glyph name="agents" className="cv2-mute" /> Show agents
                </button>
              </div>
            )}
            <ModeMenu
              open={popover === "mode"}
              onClose={() => setPopover(null)}
              mode={model.runtimeMode}
              allowed={caps?.approvals}
              planMode={model.interactionMode === "plan"}
              canPlan={caps?.planMode ?? true}
              onMode={actions.setRuntimeMode}
              onPlan={(on) => actions.setInteractionMode(on ? "plan" : "default")}
              anchorRef={footRef}
            />
            <OrchestratePopover
              open={popover === "orchestrate"}
              onClose={() => setPopover(null)}
              instances={instances}
              routing={model.routing}
              flags={model.flags}
              onChange={actions.setRouting}
              onConnect={actions.openConnections}
              anchorRef={footRef}
            />
            <ModelPicker
              open={popover === "model"}
              onClose={() => setPopover(null)}
              instances={instances}
              selection={selection}
              flags={model.flags}
              onSelect={actions.setSelection}
              onOpenTier={() => setPopover("tier")}
              onConnect={actions.openConnections}
              anchorRef={footRef}
            />
            <TraitsMenu
              open={popover === "traits"}
              onClose={() => setPopover(null)}
              instances={instances}
              selection={selection}
              onSelect={actions.setSelection}
              onOpenTier={() => setPopover("tier")}
              anchorRef={footRef}
            />
            <TierPopover
              open={popover === "tier"}
              onClose={() => setPopover(null)}
              instances={instances}
              selection={selection}
              threadTokens={threadTokens}
              onSelect={actions.setSelection}
              onCompactAndSwitch={(sel) => {
                actions.compact?.();
                actions.setSelection(sel);
              }}
              onHoverDelta={setTierDelta}
              anchorRef={footRef}
            />
          </div>
        )}
        {escArmed !== null && running && <div className="cv2-esc-hint">Press Esc again to stop</div>}
      </div>
      {model.offline && <div className="cv2-offline">Offline. Sends when {model.device?.name ?? "your Mac"} is back.</div>}
      {instance && !needs && !model.offline && tightest && (instance.status === "ready" || instance.status === "limited") && (instance.kind === "claude-agent" || instance.kind === "codex" || instance.kind === "acp") && model.state !== "limited" && (
        <div className="cv2-offline cv2-row cv2-wide" style={{ gap: 6 }}>
          <InstanceMark instance={instance} size={12} />
          <span className="cv2-tnum">
            {displayName(instance)} · {tightest.label} {tightest.usedPct !== undefined ? `${Math.round(tightest.usedPct)}% used` : ""}
            {tightest.resetsAt ? `, resets ${formatReset(tightest.resetsAt)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
});

export type { ProviderInstance };
