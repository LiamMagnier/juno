"use client";

/**
 * The composer (TARGET §7): the same object as Chat's, quiet at rest.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (ComposerSurface's context strip hanging under the field, and
 * ComposerPendingApprovalPanel: approvals replace the composer body in place).
 *
 * At rest: "+" (attach, mention, commands), the model trigger (model and
 * effort, one control), "…" (effort, context, mode, permissions, plan), the
 * mic and send. A control for mode, plan or permissions appears only while
 * that setting is not its default. Working is shown by the live work-log row
 * and the sidebar spinner, never by the composer: no glow, no ring. When the
 * agent needs you, the body becomes the request and the edge turns coral.
 *
 * Enter sends (queues while a turn runs), ⌘↵ steers, Shift+Enter is a
 * newline, Esc Esc stops, ⌥↑ edits the last queued message. `/` and `@` open
 * the command and mention menus at the caret.
 */
import * as React from "react";
import type { ApprovalDecision, ApprovalRequestItem, PlanItem, ProviderInstance, TurnItem, UserInputRequestItem } from "@/lib/code-v2/contracts";
import { SLASH_COMMANDS, applyTrigger, composerKeyIntent, detectTrigger, escPress, filterByQuery, rankFiles, sendButtonMode, type Trigger } from "@/lib/code-v2/composer";
import { orchestrateLabel, withPreset } from "@/lib/code-v2/orchestrate";
import { displayName } from "@/lib/code-v2/providers-view";
import { formatReset, formatTokens, tightestWindow } from "@/lib/code-v2/tier-view";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { EFFORT_LABELS, RUNTIME_MODES, currentTier, effectiveEffort, effortLevelsOf, findInstance, runtimeModeInfo } from "./model-info";
import { ContextRing, ModelPicker, TeamPopover, triggerWords, type RoleTab } from "./pickers";
import { ComposerPopover, Glyph, MenuList, ModelMark, useIsMac, type MenuEntry } from "./primitives";
import type { WorkspaceModel } from "./types";
import { cn } from "@/lib/utils";

export type PopoverName = "model" | "context" | "team" | "overflow" | "attach" | "queue" | "device" | null;

type Pending = ApprovalRequestItem | UserInputRequestItem;

/** The permission a new session starts with; any other shows in the composer. */
export const DEFAULT_RUNTIME_MODE = "auto-edit";

export function pendingRequests(items: readonly TurnItem[]): Pending[] {
  return items.filter((i): i is Pending => (i.kind === "approval_request" || i.kind === "user_input_request") && i.status === "pending");
}

const ACTION_PHRASE: Record<ApprovalRequestItem["action"], string> = {
  command: "wants to run a command",
  file_change: "wants to edit files",
  permissions: "wants to write outside the workspace",
  tool: "wants to use a tool",
  computer: "wants to use the computer",
};

export function placeholder(running: boolean): string {
  return running ? "Queue a follow-up. ⌘↵ to steer now" : "Ask for a change. @ for files, / for commands";
}

// ── Needs you: the body is the request ──────────────────────────────────────

function ApprovalTakeover({
  requests,
  index,
  onIndex,
  onRespond,
  onShowDiff,
}: {
  requests: Pending[];
  index: number;
  onIndex: (i: number) => void;
  onRespond: (requestId: string, decision: ApprovalDecision, answers?: Record<string, string[]>) => void;
  onShowDiff?: () => void;
}) {
  const req = requests[Math.min(index, requests.length - 1)];
  const primary = React.useRef<HTMLButtonElement>(null);
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [other, setOther] = React.useState("");
  const [more, setMore] = React.useState(false);
  React.useEffect(() => {
    primary.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    setAnswers({});
    setOther("");
    setMore(false);
  }, [req?.id]);
  if (!req) return null;
  const many = requests.length > 1;
  const who = req.kind === "approval_request" ? (req.agentLabel ?? "Alevr") : "Alevr";
  const files = req.kind === "approval_request" && req.action === "file_change" ? (req.summary.match(/\d+/)?.[0] ?? null) : null;
  const header =
    req.kind === "approval_request"
      ? req.action === "file_change" && files
        ? `${who} wants to edit ${files} ${files === "1" ? "file" : "files"}`
        : `${who} ${ACTION_PHRASE[req.action]}`
      : (req.questions[0]?.prompt ?? "A question for you");
  const opts = req.kind === "approval_request" ? (req.options ?? ["accept", "acceptForSession", "decline"]) : [];
  const counter = many && (
    <span className="count">
      <button type="button" className="cv2-iconbtn" style={{ width: 20, height: 20 }} aria-label="Previous request" onClick={() => onIndex((index - 1 + requests.length) % requests.length)}>
        <Glyph name="chevron-left" size={12} />
      </button>
      {index + 1} of {requests.length}
      <button type="button" className="cv2-iconbtn" style={{ width: 20, height: 20 }} aria-label="Next request" onClick={() => onIndex((index + 1) % requests.length)}>
        <Glyph name="chevron-right" size={12} />
      </button>
    </span>
  );

  return (
    <div className="cv2-approve" role="alertdialog" aria-label={header} key={req.id}>
      <div className="ah">
        <span className="title cv2-grow">{header}</span>
        {counter}
      </div>
      {req.kind === "approval_request" ? (
        <>
          <div className={cn("cv2-well", req.action === "file_change" && "plain")}>{req.action === "file_change" ? req.summary : (req.detail ?? req.summary)}</div>
          {req.justification && (
            <div className="why">
              <span className={cn("txt", !more && "clamp")}>{req.justification}</span>
              {!more && req.justification.length > 70 && (
                <button type="button" className="cv2-link" style={{ fontSize: 12, flex: "none" }} onClick={() => setMore(true)}>
                  More
                </button>
              )}
            </div>
          )}
          <div className="cv2-approve-actions">
            <span className="spacer" />
            {opts.includes("decline") && (
              <button type="button" className="cv2-btn ghost" title="Deny (Esc)" onClick={() => onRespond(req.requestId, "decline")}>
                Deny
              </button>
            )}
            {opts.includes("cancel") && (
              <button type="button" className="cv2-btn ghost" onClick={() => onRespond(req.requestId, "cancel")}>
                Deny and stop
              </button>
            )}
            {req.action === "file_change" && onShowDiff && (
              <button type="button" className="cv2-btn" onClick={onShowDiff}>
                Review
              </button>
            )}
            {opts.includes("acceptForSession") && req.action !== "file_change" && (
              <button type="button" className="cv2-btn" title="Allow for this session (⌘⇧↵)" onClick={() => onRespond(req.requestId, "acceptForSession")}>
                Allow for session
              </button>
            )}
            <button ref={primary} type="button" className="cv2-btn ink" title="Allow once (↵)" onClick={() => onRespond(req.requestId, "accept")}>
              {req.action === "file_change" ? "Allow" : "Allow once"}
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
                    <Glyph name={on ? "check-circle" : "circle"} size={16} className={on ? undefined : "cv2-mute"} />
                    <span>{o}</span>
                  </button>
                );
              })}
              {!q.options?.length && <input className="cv2-answer" placeholder="Your answer" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Your answer" />}
            </div>
          ))}
          <div className="cv2-approve-actions">
            <span className="spacer" />
            <button type="button" className="cv2-btn ghost" title="Skip (Esc)" onClick={() => onRespond(req.requestId, "decline")}>
              Skip
            </button>
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
              Answer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PlanApproval({ plan, onApprove, onRevise }: { plan: PlanItem; onApprove: () => void; onRevise: () => void }) {
  const n = plan.steps?.length ?? 0;
  const primary = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => primary.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions), [plan.id]);
  return (
    <div className="cv2-approve" role="alertdialog" aria-label="Plan ready">
      <div className="ah">
        <span className="title cv2-grow">Plan ready{n ? `, ${n} ${n === 1 ? "step" : "steps"}` : ""}</span>
      </div>
      <div className="why">
        <span className="txt">Nothing changes until you approve it. Revise to tell Alevr what to change.</span>
      </div>
      <div className="cv2-approve-actions">
        <span className="spacer" />
        <button type="button" className="cv2-btn ghost" onClick={onRevise}>
          Revise
        </button>
        <button ref={primary} type="button" className="cv2-btn ink" onClick={onApprove}>
          Approve and build
        </button>
      </div>
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
    onOpenDock: (tab: "changes" | "agents" | "terminal") => void;
    onFocusChange?: (focused: boolean) => void;
    /** Empty state: three lines tall. */
    tall?: boolean;
  }
>(function Composer({ model, popover, setPopover, approvalIndex, setApprovalIndex, onOpenDock, onFocusChange, tall }, ref) {
  const mac = useIsMac();
  const { actions, instances, selection } = model;
  const [draft, setDraft] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [menuIndex, setMenuIndex] = React.useState(0);
  const [escArmed, setEscArmed] = React.useState<number | null>(null);
  const [menuDismissed, setMenuDismissed] = React.useState(false);
  const [revising, setRevising] = React.useState(false);
  const [roleTab, setRoleTab] = React.useState<RoleTab>("lead");
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const footRef = React.useRef<HTMLDivElement>(null);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const running = model.state === "running" || model.state === "waiting";
  const instance = findInstance(instances, selection.instanceId);
  const caps = instance?.capabilities;
  const canSteer = caps?.steering ?? true;
  const canQueue = caps?.queue ?? true;
  const pending = pendingRequests(model.items);
  const plan = [...model.items].reverse().find((i): i is PlanItem => i.kind === "plan" && !!i.awaitingApproval);
  const needs = pending.length > 0 || (!!plan && !revising);
  const connected = instances.some((i) => i.status === "ready" || i.status === "limited") && !!instance;
  const ready = !model.starting && connected && !model.offline;
  const hasDraft = draft.trim().length > 0;
  const trigger: Trigger | null = menuDismissed ? null : detectTrigger(draft, caret);
  const menuItems = React.useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "slash") return filterByQuery(SLASH_COMMANDS, trigger.query, (c) => c.name).map((c) => ({ key: c.name, name: `/${c.name}`, sub: c.description, section: c.section, insert: c.insert ?? `/${c.name} ` }));
    const files = rankFiles(model.files ?? [], trigger.query, 8).map((p) => ({ key: p, name: p.split("/").pop() ?? p, sub: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", section: "Files", insert: `@${p} ` }));
    const agents = filterByQuery(["explorer", "reviewer"], trigger.query, (a) => a).map((a) => ({ key: a, name: `@${a}`, sub: a === "explorer" ? "Maps something, read-only" : "A second read of the changes", section: "Agents", insert: `@${a} ` }));
    return [...files, ...agents];
  }, [trigger, model.files]);
  const menuOpen = !!trigger && menuItems.length > 0;

  const speech = useSpeechRecognition({ onFinal: (t) => setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}${t.trim()}`) });

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

  React.useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft, needs]);

  const submit = (intent: "send" | "queue" | "steer") => {
    const text = draft.trim();
    if (!text) return;
    if (intent === "send") void actions.send(text);
    else if (intent === "queue") actions.queue(text);
    else void actions.steer(text);
    setDraft("");
    setMenuDismissed(false);
    setRevising(false);
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
    const intent = composerKeyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, { running, hasDraft, canSteer, canQueue, menuOpen, composing: e.nativeEvent.isComposing }, mac);
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
  const words = triggerWords(instances, selection);
  const runtime = runtimeModeInfo(model.runtimeMode);
  const routing = model.routing;
  const tightest = tightestWindow(instance?.limits);
  const threadTokens = model.usage?.contextTokens ?? 0;
  const tier = currentTier(instances, selection);
  const levels = effortLevelsOf(instances, selection).filter((l) => l !== "none");
  const effort = effectiveEffort(instances, selection);
  const toggle = (p: PopoverName) => setPopover(popover === p ? null : p);

  // ── Child thread (a subagent in full view) ──
  if (model.child) {
    return (
      <div className="cv2-childbar">
        <span className="cv2-grow cv2-trunc">
          <span className="cv2-m">{model.child.label}</span> <span className="cv2-mute">{model.child.model}</span>
        </span>
        <button type="button" className="cv2-btn" onClick={() => actions.openThread?.(model.thread.id)}>
          Back to the lead
        </button>
      </div>
    );
  }

  const overflow: MenuEntry[] = [
    ...(levels.length
      ? [
          {
            id: "effort",
            label: "Effort",
            icon: <Glyph name="sigma" size={16} />,
            trail: effort ? EFFORT_LABELS[effort] : undefined,
            sub: { title: "Effort", entries: levels.map((l) => ({ id: `e:${l}`, label: EFFORT_LABELS[l], checked: l === effort, onSelect: () => actions.setSelection({ ...selection, effort: l }) })) },
          },
        ]
      : []),
    ...(tier ? [{ id: "context", label: "Context window", icon: <Glyph name="layers" size={16} />, trail: formatTokens(tier.tokens), onSelect: () => setTimeout(() => setPopover("context"), 0) }] : []),
    { kind: "sep", id: "s1" },
    {
      id: "mode",
      label: "Mode",
      icon: <Glyph name="agents" size={16} />,
      trail: orchestrateLabel(routing),
      sub: {
        title: "Mode",
        entries: [
          { id: "m:solo", label: "Solo", l2: "One model does the whole run", checked: routing.preset === "solo", onSelect: () => actions.setRouting(withPreset(routing, "solo")) },
          { id: "m:team", label: "Team", l2: "A lead plans, workers build in parallel", checked: routing.preset === "lead-workers", onSelect: () => actions.setRouting(withPreset(routing, "lead-workers")) },
          { id: "m:best", label: "Best of N", l2: "Several attempts, you keep one", checked: routing.preset === "best-of-n", onSelect: () => actions.setRouting(withPreset(routing, "best-of-n")) },
        ],
      },
    },
    {
      id: "perm",
      label: "Permissions",
      icon: <Glyph name="shield" size={16} />,
      trail: runtime.label,
      sub: {
        title: "Permissions",
        entries: RUNTIME_MODES.map((m) => {
          const disabled = !!caps?.approvals?.length && !caps.approvals.includes(m.mode);
          return { id: `p:${m.mode}`, label: m.label, l2: disabled ? "This runtime cannot enforce it" : m.description, checked: m.mode === model.runtimeMode, disabled, onSelect: () => actions.setRuntimeMode(m.mode) };
        }),
      },
    },
    ...((caps?.planMode ?? true)
      ? [{ id: "plan", label: "Plan first", icon: <Glyph name="plan" size={16} />, checked: model.interactionMode === "plan", keepOpen: true, onSelect: () => actions.setInteractionMode(model.interactionMode === "plan" ? "default" : "plan") }]
      : []),
  ];
  const attach: MenuEntry[] = [
    { id: "file", label: "Attach files", icon: <Glyph name="attach" size={16} />, onSelect: () => fileInput.current?.click() },
    { id: "mention", label: "Mention a file", icon: <Glyph name="at" size={16} />, trail: "@", onSelect: () => (setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@`), textarea.current?.focus()) },
    { id: "cmd", label: "Commands", icon: <Glyph name="slash" size={16} />, trail: "/", onSelect: () => (setDraft("/"), textarea.current?.focus()) },
  ];

  // ── Body ──
  let body: React.ReactNode;
  let tone: "needs" | "" = "";
  if (pending.length) {
    tone = "needs";
    body = <ApprovalTakeover requests={pending} index={approvalIndex} onIndex={setApprovalIndex} onRespond={(id, d, a) => void actions.respond(id, d, a)} onShowDiff={() => onOpenDock("changes")} />;
  } else if (plan && !revising) {
    tone = "needs";
    body = (
      <PlanApproval
        plan={plan}
        onApprove={() => actions.approvePlan?.(plan.id, true)}
        onRevise={() => {
          setRevising(true);
          requestAnimationFrame(() => textarea.current?.focus());
        }}
      />
    );
  } else if (model.state === "limited" && instance) {
    const vendor = instance.kind === "claude-agent" ? "Claude" : instance.kind === "codex" ? "ChatGPT" : displayName(instance);
    const at = model.resumeAt ?? tightest?.resetsAt;
    const scheduled = model.scheduledResume;
    body = (
      <div className="cv2-approve neutral" role="status">
        <div className="ah">
          <span className="title">
            {vendor} plan limit reached{scheduled ? `. Alevr continues at ${formatReset(scheduled.at)}` : at ? `, resets ${formatReset(at)}` : ""}
          </span>
        </div>
        <div className="cv2-approve-actions">
          <span className="spacer" />
          {scheduled
            ? actions.cancelResume && (
                <button type="button" className="cv2-btn ghost" onClick={() => actions.cancelResume?.()}>
                  Don&apos;t continue
                </button>
              )
            : actions.resumeAtReset &&
              at && (
                <button type="button" className="cv2-btn ghost" onClick={() => void actions.resumeAtReset?.(at)}>
                  Resume at reset
                </button>
              )}
          <button type="button" className="cv2-btn ink" onClick={() => setPopover("model")}>
            Switch model
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <textarea
        ref={textarea}
        className={cn("cv2-draft", tall && "tall")}
        rows={1}
        value={draft}
        disabled={!connected}
        placeholder={!connected ? "Connect a subscription or add a key to start" : revising ? "What should change in the plan?" : placeholder(running)}
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
    );
  }
  const showFoot = !pending.length && !(plan && !revising) && model.state !== "limited";
  const deviceName = model.device ? "This Mac" : "Cloud";

  return (
    <div className="cv2-cstack">
      <div className={cn("cv2-composer", tone)} data-state={tone || (running ? "running" : "idle")}>
        {menuOpen && trigger && (
          <div className="cv2-menu-anchor">
            <div className="cv2-pop" role="listbox" aria-label={trigger.kind === "slash" ? "Commands" : "Mentions"}>
              <div className="cv2-pop-body" style={{ maxHeight: 300 }}>
                {menuItems.map((m, i) => (
                  <React.Fragment key={m.key}>
                    {(i === 0 || menuItems[i - 1].section !== m.section) && <div className="cv2-msect">{m.section}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === menuIndex}
                      className="cv2-mi"
                      data-active={i === menuIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(i);
                      }}
                      onMouseEnter={() => setMenuIndex(i)}
                    >
                      <span className="cv2-trunc" style={{ flex: "none", maxWidth: "60%" }}>
                        {m.name}
                      </span>
                      {m.sub && <span className="cv2-small cv2-mute cv2-trunc">{m.sub}</span>}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
        {body}
        {showFoot && (
          <div className="cv2-cfoot" ref={footRef}>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files?.length && setDraft((d) => `${d}${d ? " " : ""}${[...e.target.files!].map((f) => `@${f.name}`).join(" ")} `)} />
            {connected ? (
              <>
                <button type="button" className="cv2-ctl icon" aria-label="Add" title="Attach, mention or run a command" aria-haspopup="menu" aria-expanded={popover === "attach"} onClick={() => toggle("attach")}>
                  <Glyph name="plus" size={16} />
                </button>
                <button type="button" className="cv2-ctl" aria-expanded={popover === "model"} aria-haspopup="dialog" aria-label={`Model: ${words.model}${words.effort ? `, ${words.effort}` : ""}`} onClick={() => (setRoleTab("lead"), toggle("model"))}>
                  {instance && <ModelMark modelId={selection.model} instance={instance} />}
                  <span className="v cv2-trunc">{words.model}</span>
                  {words.effort && <span className="eff">{words.effort}</span>}
                  <Glyph name="chevron-down" size={12} className="chev" />
                </button>
                {routing.preset !== "solo" && (
                  <button type="button" className="cv2-ctl cv2-hide-narrow" aria-haspopup="dialog" aria-expanded={popover === "team"} onClick={() => toggle("team")}>
                    {orchestrateLabel(routing)}
                    <Glyph name="chevron-down" size={12} className="chev" />
                  </button>
                )}
                {model.interactionMode === "plan" && (
                  <button type="button" className="cv2-ctl cv2-hide-narrow" aria-haspopup="menu" title="Plan first: nothing changes until you approve" onClick={() => actions.setInteractionMode("default")}>
                    Plan
                    <Glyph name="close" size={12} className="chev" />
                  </button>
                )}
                {model.runtimeMode !== DEFAULT_RUNTIME_MODE && (
                  <button type="button" className="cv2-ctl" aria-haspopup="menu" aria-expanded={popover === "overflow"} title={runtime.description} onClick={() => toggle("overflow")}>
                    <Glyph name="shield" size={14} />
                    <span className="cv2-wide">{runtime.label}</span>
                  </button>
                )}
                <button type="button" className="cv2-ctl icon" aria-label="More options" title="Effort, context, mode and permissions" aria-haspopup="menu" aria-expanded={popover === "overflow"} onClick={() => toggle("overflow")}>
                  <Glyph name="more" size={16} />
                </button>
              </>
            ) : (
              <button type="button" className="cv2-ctl" onClick={actions.openConnections}>
                <span className="v">Connect</span>
                <Glyph name="chevron-down" size={12} className="chev" />
              </button>
            )}
            <span className="cv2-grow" />
            {model.queue.length > 0 && (
              <button type="button" className="cv2-ctl" aria-haspopup="menu" aria-expanded={popover === "queue"} onClick={() => toggle("queue")}>
                Queued ({model.queue.length})
                <Glyph name="chevron-down" size={12} className="chev" />
              </button>
            )}
            {connected && <ContextRing usage={model.usage} onOpen={() => toggle("context")} expanded={popover === "context"} />}
            {connected && speech.supported && (
              <button type="button" className="cv2-ctl icon" aria-label={speech.listening ? "Stop dictation" : "Dictate"} aria-pressed={speech.listening} onClick={() => (speech.listening ? speech.stop() : speech.start())}>
                <Glyph name={speech.listening ? "mic-off" : "mic"} size={16} />
              </button>
            )}
            <button
              type="button"
              className="cv2-send"
              data-mode={mode}
              disabled={mode === "disabled"}
              aria-label={mode === "stop" ? "Stop" : mode === "queue" ? "Queue" : "Send"}
              title={mode === "stop" ? "Stop (Esc Esc)" : undefined}
              onClick={() => (mode === "stop" ? actions.stop() : submit(running ? (canQueue ? "queue" : "steer") : "send"))}
            >
              <span className="glyph">
                <Glyph name="arrow-up" size={16} />
              </span>
              <span className="stop" />
            </button>

            <ComposerPopover open={popover === "attach"} onClose={() => setPopover(null)} width={240} align="left" offset={0} label="Add" anchorRef={footRef} role="menu">
              <MenuList entries={attach} onClose={() => setPopover(null)} label="Add" />
            </ComposerPopover>
            <ComposerPopover open={popover === "overflow"} onClose={() => setPopover(null)} width={280} align="left" offset={0} label="Options" anchorRef={footRef} role="menu">
              <div className="cv2-pop-grab" aria-hidden />
              <MenuList entries={overflow} onClose={() => setPopover(null)} label="Options" />
            </ComposerPopover>
            <ComposerPopover open={popover === "queue"} onClose={() => setPopover(null)} width={360} align="right" offset={0} label="Queued messages" anchorRef={footRef}>
              <QueueMenu model={model} canSteer={canSteer && running} mac={mac} onEdit={(text, id) => (actions.removeQueued(id), setDraft(text), setPopover(null), requestAnimationFrame(() => textarea.current?.focus()))} />
            </ComposerPopover>
            <ModelPicker
              open={popover === "model" || popover === "context"}
              onClose={() => setPopover(null)}
              instances={instances}
              selection={selection}
              flags={model.flags}
              onSelect={actions.setSelection}
              onConnect={actions.openConnections}
              anchorRef={footRef}
              routing={routing}
              onRouting={actions.setRouting}
              initialTab={roleTab}
              initialView={popover === "context" ? "context" : "models"}
              threadTokens={threadTokens}
              onCompactAndSwitch={(sel) => {
                actions.compact?.();
                actions.setSelection(sel);
              }}
            />
            <TeamPopover
              open={popover === "team"}
              onClose={() => setPopover(null)}
              instances={instances}
              routing={routing}
              lead={selection}
              onChange={actions.setRouting}
              onPickRole={(t) => {
                setRoleTab(t);
                setPopover("model");
              }}
              anchorRef={footRef}
            />
          </div>
        )}
        {escArmed !== null && running && <div className="cv2-esc-hint">Press Esc again to stop</div>}
      </div>
      <div className="cv2-strip" ref={stripRef}>
        <span className="s" title={model.thread.cwd ?? model.thread.repo}>
          <Glyph name="folder" size={12} />
          {model.thread.repo}
        </span>
        {model.thread.branch && (
          <span className="s cv2-trunc" title={model.thread.branch}>
            <Glyph name="branch" size={12} />
            <span className="cv2-trunc">{model.thread.branch}</span>
          </span>
        )}
        <span className="cv2-grow" />
        <button type="button" className="s" aria-haspopup="menu" aria-expanded={popover === "device"} onClick={() => toggle("device")}>
          <Glyph name={model.device ? "laptop" : "cloud"} size={12} />
          {deviceName}
          {model.offline ? <span className="lbl-long">, offline</span> : null}
          <Glyph name="chevron-down" size={12} />
        </button>
        <ComposerPopover open={popover === "device"} onClose={() => setPopover(null)} width={280} align="right" offset={0} label="Where it runs" anchorRef={stripRef} role="menu">
          <MenuList
            label="Where it runs"
            onClose={() => setPopover(null)}
            entries={[
              {
                id: "mac",
                label: model.device?.name ?? "This Mac",
                l2: model.device ? (model.device.online && !model.offline ? "Connected" : "Offline. Open Alevr on it to reconnect") : "Open Alevr for Mac to run here",
                icon: <Glyph name="laptop" size={16} />,
                checked: !!model.device,
              },
              { kind: "sep", id: "s" },
              { id: "conn", label: "Connections", icon: <Glyph name="plug" size={16} />, onSelect: () => actions.openConnections?.() },
            ]}
          />
        </ComposerPopover>
      </div>
      {model.offline && (
        <div className="cv2-under">
          <span>Reconnect to run on {model.device?.name ?? "your Mac"}. Messages send when it is back.</span>
        </div>
      )}
      {!connected && !model.offline && (
        <div className="cv2-under">
          <button type="button" className="cv2-link" onClick={actions.openConnections}>
            Open Connections
          </button>
        </div>
      )}
    </div>
  );
});

function QueueMenu({ model, canSteer, mac, onEdit }: { model: WorkspaceModel; canSteer: boolean; mac: boolean; onEdit: (text: string, id: string) => void }) {
  const { actions } = model;
  return (
    <div className="cv2-pop-body" role="list" aria-label="Queued messages">
      {model.queue.map((q) => (
        <div key={q.id} role="listitem" className="cv2-mi two" style={{ cursor: "default" }}>
          <span className="cv2-grow">
            <span className="block cv2-trunc">{q.text}</span>
            <span className="l2" style={{ display: "flex", gap: 12, marginTop: 2 }}>
              <button type="button" className="cv2-link" style={{ fontSize: 12 }} onClick={() => onEdit(q.text, q.id)}>
                Edit
              </button>
              {canSteer && (
                <button type="button" className="cv2-link" style={{ fontSize: 12 }} title={mac ? "⌘↵" : "Ctrl ↵"} onClick={() => actions.steerQueued(q.id)}>
                  Steer now
                </button>
              )}
              <button type="button" className="cv2-link" style={{ fontSize: 12 }} onClick={() => actions.removeQueued(q.id)}>
                Remove
              </button>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export type { ProviderInstance };
