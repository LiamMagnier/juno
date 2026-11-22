"use client";

/**
 * The composer (TARGET §7): the same object as Chat's, quiet at rest.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (ComposerSurface's context strip hanging under the field, and
 * ComposerPendingApprovalPanel: approvals replace the composer body in place).
 *
 * Chat renders the editor and controls. Code supplies workspace commands,
 * approvals and the transport that sends, queues or steers a turn.
 *
 * Enter sends (queues while a turn runs), ⌘↵ steers, Shift+Enter is a
 * newline, Esc Esc stops, ⌥↑ edits the last queued message. `/` and `@` open
 * the command and mention menus at the caret.
 */
import * as React from "react";
import type { ApprovalDecision, ApprovalRequestItem, PlanItem, ProviderInstance, TurnItem, UserInputRequestItem } from "@/lib/code-v2/contracts";
import { SLASH_AGENTS_LABEL, SLASH_SKILLS_LABEL, applyTrigger, compactMessage, composerKeyIntent, detectTrigger, escPress, filterByQuery, parseClientCommand, rankFiles, sendButtonMode, slashCommandsFor, type Trigger } from "@/lib/code-v2/composer";
import { ATTACHMENTS_UPLOADING_LABEL, MAC_ATTACHMENT_TOO_LARGE_MESSAGE } from "@/lib/code-v2/composer-attachments";
import { toast } from "sonner";
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from "@/lib/chat/context-draft";
import { insertLineBreak } from "@/lib/composer-keys";
import { touchReturnBreaksLine } from "@/lib/touch-keyboard";
import { ComposerAttachmentRow, composerChipClass, useComposerAutosize } from "@/components/ui/composer-shell";
import { ChatComposerField, ChatComposerSurface } from "@/components/chat/composer-surface";
import { PlusMenuRow, type PlusMenuSection } from "@/components/chat/composer-plus-menu";
import { AtSign, AudioLines, FolderOpen, List, Paperclip, Camera, Slash } from "@/components/ui/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CODE_STARTERS } from "@/components/code/code-landing-actions";
import { ComposerDropOverlay, ComposerFileInputs } from "@/components/code/code-composer-parts";
import { LibraryPicker } from "@/components/chat/library-picker";
import { CloudFilePicker } from "@/components/chat/cloud-file-picker";
import { GoogleDriveMark } from "@/components/projects/google-drive-mark";
import { useOptionalApp } from "@/components/app/app-provider";
import type { CloudFileProvider } from "@/lib/cloud-files/shared";
import type { ClientAttachment } from "@/types/chat";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerArrival } from "./composer-travel";
import { orchestrateLabel } from "@/lib/code-v2/orchestrate";
import { displayName } from "@/lib/code-v2/providers-view";
import { formatReset, formatTokens, tightestWindow } from "@/lib/code-v2/tier-view";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { useDictationSupported } from "@/hooks/use-dictation-support";
import { useCodeVoice, useCodeVoiceCall, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { availableComposerModes, composerModeInfo, composerModeOf, setComposerMode } from "@/lib/code-v2/composer-mode";
import { EFFORT_LABELS, currentTier, effectiveEffort, effortLevelsOf, findInstance } from "./model-info";
import { ContextRing, ModelPicker, triggerWords } from "./pickers";
import { ComposerTeam } from "./team";
import { SkillsChip, SkillsPicker } from "./skills";
import { matchSkills, readCodeSkillInvocation, skillsChipLabel, type CodeSkillChoice } from "@/lib/code-v2/skills";
import { ComposerPopover, Glyph, MenuList, ModelMark, useIsMac, type MenuEntry } from "./primitives";
import type { WorkspaceModel } from "./types";
import { cn } from "@/lib/utils";
import { useHeightSwap } from "@/lib/use-height-swap";

/** `model` opens the model chip on its effort stage; `catalog` on the model list. */
export type PopoverName = "model" | "catalog" | "context" | "team" | "overflow" | "attach" | "queue" | "device" | "mode" | "skills" | null;

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

/** The landing's field, before a session exists. */
export const LANDING_PLACEHOLDER = "Describe a task or ask a question…";
const PASTE_FILE_NOTE = "Your long paste is attached as a text file.";
const KEEP_INLINE_LABEL = "Keep it inline";
const UPLOADS_OFF_NOTE = "Uploads unavailable";
const ignoreTokens = () => {};
const FILES_SECTION_LABEL = "Files";
const NOTHING_TO_COMPACT_MESSAGE = "There’s nothing to compact until the session starts.";
const MODEL_PENDING_LABEL = "Waiting for your Mac to list its models";

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
  // Deny is ⌘⌫ (keymap.ts); a stray Esc never answers a request.
  const mac = useIsMac();
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
    // A labelled group, never an alertdialog: the card is inline above the
    // composer and traps nothing (spec D20; code-run-cards.tsx says the same).
    <div className="cv2-approve" role="group" aria-label={header} key={req.id}>
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
              <button type="button" className="cv2-btn ghost" title={mac ? "Deny (⌘⌫)" : "Deny (Ctrl+Backspace)"} onClick={() => onRespond(req.requestId, "decline")}>
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
            <button type="button" className="cv2-btn ghost" title={mac ? "Skip (⌘⌫)" : "Skip (Ctrl+Backspace)"} onClick={() => onRespond(req.requestId, "decline")}>
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
    <div className="cv2-approve" role="group" aria-label="Plan ready">
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
  setDraft(text: string, options?: { onlyIfEmpty?: boolean }): boolean;
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
    onVoiceOpenChange?: (open: boolean) => void;
    /** Empty state: three lines tall. */
    tall?: boolean;
    /**
     * `landing`: the /code composer before a session exists. The same object
     * as a session's (one composer from landing to session), without what
     * needs a session: the context strip, the queue and the commands that act
     * on a thread. The landing draws its target tray around it.
     */
    variant?: "session" | "landing";
    /** Explains why Send is unavailable before the user chooses where to run. */
    gate?: string | null;
    /** Drawn under the composer in place of the context strip (the landing's one line). */
    under?: React.ReactNode;
    /** The draft to start from (a prefilled link on the landing). */
    initialDraft?: string;
    readOnly?: boolean;
    onStartingPoint?: (prompt: string) => void;
    workspaceControls?: React.ReactNode;
    /** Whether the team chip is offered (a cloud run has no team). */
    team?: boolean;
    /** The outer box, for the landing-to-session travel. */
    stackRef?: React.Ref<HTMLDivElement>;
  }
>(function Composer({ model, popover, setPopover, approvalIndex, setApprovalIndex, onOpenDock, onFocusChange, onVoiceOpenChange, tall, variant = "session", gate = null, under, initialDraft, readOnly = false, onStartingPoint, workspaceControls, team = true, stackRef }, ref) {
  const mac = useIsMac();
  const landing = variant === "landing";
  const { actions, instances, selection } = model;
  const [draft, setDraftState] = React.useState(initialDraft ?? "");
  const [caret, setCaret] = React.useState(0);
  const [menuIndex, setMenuIndex] = React.useState(0);
  const [escArmed, setEscArmed] = React.useState<number | null>(null);
  const [menuDismissed, setMenuDismissed] = React.useState(false);
  const [revising, setRevising] = React.useState(false);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const toolsRef = React.useRef<HTMLDivElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [cloudPicker, setCloudPicker] = React.useState<CloudFileProvider | null>(null);
  const app = useOptionalApp();
  const features = app?.features;

  const running = model.state === "running" || model.state === "waiting";
  const instance = findInstance(instances, selection.instanceId);
  const caps = instance?.capabilities;
  const canSteer = caps?.steering ?? true;
  const canQueue = caps?.queue ?? true;
  const pending = pendingRequests(model.items);
  const plan = [...model.items].reverse().find((i): i is PlanItem => i.kind === "plan" && !!i.awaitingApproval);
  const needs = pending.length > 0 || (!!plan && !revising);
  // A Mac subscription chosen before the Mac listed its runtimes: writable, shown, and held at Send.
  const modelPending = !instance && !!model.selectionPending;
  // Web Speech or the server's transcription, whichever can work here (G36).
  const speechSupported = useDictationSupported();
  const connected = instances.some((i) => i.status === "ready" || i.status === "limited") && (!!instance || modelPending);
  const waitingOn = gate ?? (modelPending ? MODEL_PENDING_LABEL : null);
  const ready = !model.starting && connected && !model.offline && !waitingOn;

  // ── The draft: kept in this tab and synced to the reader's other devices ──
  const channel = model.draft;
  const draftKey = channel?.key ?? null;
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const focused = React.useRef(false);
  /** The text the channel already knows about (a remote apply, a send), so it is not echoed back. */
  const known = React.useRef(draft);
  const setDraft = setDraftState;
  // A draft left in this tab comes back: a reload, or a trip to another thread.
  React.useEffect(() => {
    if (!draftKey) return;
    const stored = readComposerDraft(draftKey)?.text;
    if (stored && !draftRef.current) {
      known.current = stored;
      setDraftState(stored);
    }
  }, [draftKey]);
  React.useEffect(() => {
    if (!draftKey) return;
    const t = window.setTimeout(() => (draft.trim() ? writeComposerDraft(draftKey, { text: draft, tokens: [] }) : clearComposerDraft(draftKey)), 300);
    return () => window.clearTimeout(t);
  }, [draft, draftKey]);
  React.useEffect(() => {
    if (draft === known.current) return;
    known.current = draft;
    channel?.changed(draft);
  }, [draft, channel]);
  /** A send: the field is empty here and on every device. */
  const forgetDraft = () => {
    known.current = "";
    if (draftKey) clearComposerDraft(draftKey);
    channel?.cleared();
    setDraftState("");
  };

  // ── Attachments: paste, drop, "+", the library, a capture ──
  const attachments = useComposerAttachments({ conversationId: model.uploadConversationId ?? null, enabled: !!model.canAttach && connected && !model.child });
  const restoreFiles = attachments.addAttachments;
  // The landing's box travels to the dock on the session's first paint (composer-travel.ts).
  useComposerArrival(shellRef, !landing);
  React.useEffect(
    () =>
      channel?.attach({
        read: () => ({ text: draftRef.current, editing: focused.current }),
        apply: (text) => {
          known.current = text;
          setDraftState(text);
        },
        // A send that could not go gives its words and files back.
        restore: (text, files) => {
          if (!draftRef.current.trim()) setDraftState(text);
          if (files.length) restoreFiles(files);
        },
      }),
    [channel, restoreFiles],
  );
  const files = attachments.ready;
  const hasDraft = draft.trim().length > 0 || files.length > 0;
  /** A file this thread cannot carry (a Mac over the web: 4 MB) is said before the send, and the draft stays. */
  const filesTooLarge = (list: readonly ClientAttachment[]): boolean => {
    const max = model.attachmentMaxBytes;
    if (!max || !list.some((f) => f.size > max)) return false;
    toast.error(MAC_ATTACHMENT_TOO_LARGE_MESSAGE);
    return true;
  };
  const trigger: Trigger | null = menuDismissed ? null : detectTrigger(draft, caret);
  const skills = model.skills;
  const skillChoices = skills?.choices;
  const slashing = trigger?.kind === "slash";
  // The skills list is read the first time `/` is typed (it is lazy).
  React.useEffect(() => {
    if (slashing) skills?.load();
  }, [slashing, skills]);
  const menuItems = React.useMemo((): { key: string; name: string; sub: string; section: string; insert: string; skill?: CodeSkillChoice; trail?: string }[] => {
    if (!trigger) return [];
    if (trigger.kind === "slash") {
      // Grouped by who answers: "Actions" run here and never spend a turn, the rest are sent to the agent.
      const commands = filterByQuery(slashCommandsFor(variant), trigger.query, (c) => c.name).map((c) => ({ key: c.name, name: `/${c.name}`, sub: c.description, section: c.section, insert: c.insert ?? `/${c.name} ` }));
      // Skills lane: the thread's skills after the commands, a /name runs one for the next message.
      const skillRows = matchSkills(skillChoices ?? [], trigger.query)
        .slice(0, 24)
        .map((c) => ({ key: `skill:${c.id}`, name: `/${c.name}`, sub: c.description, section: SLASH_SKILLS_LABEL, insert: "", skill: c, trail: c.originLabel }));
      const agents = commands.filter((c) => c.section === SLASH_AGENTS_LABEL);
      return [...commands.filter((c) => c.section !== SLASH_AGENTS_LABEL), ...skillRows, ...agents];
    }
    const files = rankFiles(model.files ?? [], trigger.query, 8).map((p) => ({ key: p, name: p.split("/").pop() ?? p, sub: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", section: FILES_SECTION_LABEL, insert: `@${p} ` }));
    const agents = filterByQuery(["explorer", "reviewer"], trigger.query, (a) => a).map((a) => ({ key: a, name: `@${a}`, sub: a === "explorer" ? "Maps something, read-only" : "A second read of the changes", section: SLASH_AGENTS_LABEL, insert: `@${a} ` }));
    return [...files, ...agents];
  }, [trigger, model.files, skillChoices, variant]);
  const menuOpen = !!trigger && menuItems.length > 0;

  const [dictating, setDictating] = React.useState(false);
  const voice = useCodeVoice({ disabled: dictating || !connected });
  React.useEffect(() => {
    onVoiceOpenChange?.(voice.open);
    if (voice.open) return () => onVoiceOpenChange?.(false);
  }, [onVoiceOpenChange, voice.open]);

  /**
   * A finished line, as the send button would send it: send, or queue / steer
   * while a turn runs. The row's finished uploads go with it; a send waits
   * while one is still uploading rather than leaving it behind.
   */
  const dispatch = (text: string, withFiles: ClientAttachment[] = files): boolean => {
    const t = text.trim();
    if (!t && !withFiles.length) return false;
    if (attachments.uploading || filesTooLarge(withFiles)) return false;
    if (!running) {
      if (!ready) return false;
      void actions.send(t, withFiles);
    } else if (canQueue) actions.queue(t, withFiles);
    else void actions.steer(t, withFiles);
    if (withFiles.length) attachments.clear();
    return true;
  };

  /** Dictation's close: the words join the draft, and "send" sends the whole draft. */
  const closeDictation = (transcript: string, sendNow: boolean) => {
    setDictating(false);
    const merged = [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
    if (sendNow && dispatch(merged)) {
      forgetDraft();
      return;
    }
    setDraft(merged);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const voiceBriefing: CodeVoiceBriefingInput = {
    stage: model.items.length ? "session" : "new",
    target: model.device ? "device" : "cloud",
    place: model.thread.repo || null,
    baseRef: model.thread.branch ?? null,
    turns: voice.open
      ? model.items.flatMap((i): { role: "user" | "assistant"; text: string }[] => (i.kind === "user_message" ? [{ role: "user", text: i.text }] : i.kind === "assistant_message" ? [{ role: "assistant", text: i.text }] : []))
      : [],
    blocked: !connected ? "Connect a subscription or add a key to start" : model.offline ? "The Mac this runs on is offline" : waitingOn,
  };
  /** A spoken line becomes this thread's next turn: sent, or a steer while it runs (a queued follow-up where steering is not offered). */
  const voiceSend: CodeVoiceSend = {
    intent: model.items.length ? "send" : "start",
    blockedReason: voiceBriefing.blocked,
    sending: !!model.starting,
    // The landing's send opens the new session, so the call ends first.
    ...(landing ? { endsCall: true } : {}),
    onSend: async (text) => {
      // The landing's first line starts the task with whatever was typed beside it.
      if (landing) {
        const sent = dispatch([draft.trim(), text.trim()].filter(Boolean).join(" "));
        if (sent) forgetDraft();
        return sent;
      }
      if (!running) return dispatch(text);
      if (canSteer) void actions.steer(text);
      else actions.queue(text);
      return true;
    },
  };

  /** The thread's side of the call: a finished run's newest reply is read back. */
  const voiceReply = {
    running,
    latest: voice.open ? ([...model.items].reverse().find((i) => i.kind === "assistant_message") as { text?: string } | undefined)?.text ?? null : null,
  };

  /** The call, drawn in this composer as Chat draws its own. */
  const call = useCodeVoiceCall({ open: voice.open, onClose: voice.close, briefing: voiceBriefing, send: voiceSend, reply: voiceReply });

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
    setDraft: (t, options) => {
      const field = textarea.current;
      const current = field?.value ?? draftRef.current;
      if (options?.onlyIfEmpty && current.trim()) {
        // A browser can update the field before React's change event is reflected in state.
        if (current !== draftRef.current) setDraft(current);
        field?.focus();
        return false;
      }
      setDraft(t);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(t.length, t.length);
      });
      return true;
    },
  }));

  useComposerAutosize(textarea, draft, { maxLines: landing ? 8 : 6 });

  /**
   * The app's own commands (G38): /model, /clear, /plan and /compact never go
   * to the agent as a prompt. Returns true when the draft was one.
   */
  const runClientCommand = (text: string, intent: "send" | "queue" | "steer"): boolean => {
    const command = parseClientCommand(text);
    if (!command) return false;
    switch (command.kind) {
      case "model":
        forgetDraft();
        setPopover("catalog");
        return true;
      case "clear":
        forgetDraft();
        if (landing) {
          // Nothing exists yet to start afresh from: the landing's fresh start is an empty composer.
          attachments.clear();
          if (command.rest) setDraftState(command.rest);
          return true;
        }
        if (actions.clearThread) actions.clearThread(command.rest);
        else if (actions.newThread) actions.newThread();
        else return false;
        return true;
      case "plan": {
        setComposerMode(actions, "plan", model.runtimeMode);
        forgetDraft();
        // The rest is the task, sent under Plan (the thread's setter applies before the send reads it).
        if (command.rest || files.length) send(command.rest, intent);
        return true;
      }
      case "compact":
        if (landing) {
          // Nothing to summarise before a session exists: said, and the words stay as typed.
          toast.message(NOTHING_TO_COMPACT_MESSAGE);
          return true;
        }
        // While a turn runs it queues as text, which the engine reads as the command when its turn comes.
        if (running) return false;
        forgetDraft();
        if (actions.compact) actions.compact(command.rest);
        else void actions.send(compactMessage(command.rest));
        return true;
    }
  };

  const send = (text: string, intent: "send" | "queue" | "steer") => {
    if (intent === "send") void actions.send(text, files);
    else if (intent === "queue") actions.queue(text, files);
    else void actions.steer(text, files);
    if (files.length) attachments.clear();
  };

  const submit = (intent: "send" | "queue" | "steer") => {
    let text = draft.trim();
    if (!text && !files.length) return;
    // A send never leaves a file behind that is still uploading (/model and /clear send nothing).
    const command = parseClientCommand(text);
    if (command?.kind !== "model" && command?.kind !== "clear" && (attachments.uploading || filesTooLarge(files))) return;
    if (runClientCommand(text, intent)) {
      setMenuDismissed(false);
      return;
    }
    // `/design-taste-frontend make the hero calmer`: that skill for this message, the rest as the message.
    const invoked = skills && text ? readCodeSkillInvocation(text, skills.choices ?? []) : null;
    if (invoked && skills) {
      skills.arm(invoked.skill);
      text = invoked.remainder;
      if (!text && !files.length) {
        forgetDraft();
        return;
      }
    }
    send(text, intent);
    forgetDraft();
    setMenuDismissed(false);
    setRevising(false);
  };

  const pick = (i: number) => {
    const item = menuItems[i];
    if (!item || !trigger) return;
    // /model takes no words: choosing it opens the picker, and only the `/mo`
    // typed to find it leaves the draft (the menu opens on any line, so the
    // rest of the draft is the reader's words, never thrown away).
    if (trigger.kind === "slash" && item.key === "model") {
      const next = applyTrigger(draft, caret, trigger, "");
      setDraft(next.text);
      setCaret(next.caret);
      setMenuDismissed(false);
      setPopover("catalog");
      return;
    }
    // /clear runs at once only when it is all there is: with other words or
    // files in the composer it goes in as text, so a stray Enter cannot carry
    // the reader away from a draft.
    if (trigger.kind === "slash" && item.key === "clear" && !applyTrigger(draft, caret, trigger, "").text.trim() && !attachments.uploads.length && runClientCommand("/clear", "send")) {
      setMenuDismissed(false);
      return;
    }
    if (item.skill && skills) {
      // A skill from the menu: armed for the next message, its `/name` taken out of the draft.
      skills.arm(item.skill);
      const next = applyTrigger(draft, caret, trigger, "");
      setDraft(next.text.replace(/^\s+/, ""));
      setCaret(0);
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
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
    // Safari sends the Enter that confirms an input method's text after
    // compositionend, isComposing false but keyCode 229: still not a send.
    const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
    // Return on an on-screen keyboard breaks the line; the send disc sends (G35).
    if (!composing && touchReturnBreaksLine(e)) return;
    const intent = composerKeyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, { running, hasDraft, canSteer, canQueue, menuOpen, composing }, mac);
    if (intent === "newline" && e.altKey) {
      // The textarea breaks the line on Shift+Enter by itself, not on Option+Enter.
      e.preventDefault();
      if (!insertLineBreak()) {
        const el = e.currentTarget;
        const start = el.selectionStart ?? draft.length;
        const end = el.selectionEnd ?? start;
        setDraft(draft.slice(0, start) + "\n" + draft.slice(end));
        requestAnimationFrame(() => textarea.current?.setSelectionRange(start + 1, start + 1));
      }
      return;
    }
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
    // /model, /clear and a bare /plan work whether or not a turn could start (an offline Mac, a project not picked yet).
    const appOnly = parseClientCommand(draft);
    const runsHere = !!appOnly && (appOnly.kind === "model" || appOnly.kind === "clear" || (appOnly.kind === "plan" && !appOnly.rest && !files.length));
    if (intent === "send" && !ready && !runsHere) return;
    submit(intent);
  };

  const mode = attachments.uploading && hasDraft && !running ? "disabled" : sendButtonMode({ running, hasDraft, canQueue, canSteer }, ready);
  const words = triggerWords(instances, selection);
  const routing = model.routing;
  const tightest = tightestWindow(instance?.limits);
  const threadTokens = model.usage?.contextTokens ?? 0;
  const tier = currentTier(instances, selection);
  const levels = effortLevelsOf(instances, selection).filter((l) => l !== "none");
  const effort = effectiveEffort(instances, selection);
  const toggle = (p: PopoverName) => setPopover(popover === p ? null : p);

  // An approval, a plan or a limit takes the textarea's place: the box eases
  // to its new height instead of jumping (and moving the thread above it).
  const bodyKind = pending.length ? "approval" : plan && !revising ? "plan" : model.state === "limited" && instance ? "limited" : "draft";
  useHeightSwap(shellRef, bodyKind);

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
    ...(team || skills ? ([{ kind: "sep", id: "s1" }] satisfies MenuEntry[]) : []),
    ...(team ? ([{ id: "team", label: "Orchestrator…", icon: <Glyph name="agents" size={16} />, trail: orchestrateLabel(routing), onSelect: () => setTimeout(() => setPopover("team"), 0) }] satisfies MenuEntry[]) : []),
    ...(skills
      ? ([
          {
            id: "skills",
            label: "Skills…",
            icon: <Glyph name="skills" size={16} />,
            trail: skills.selected.length > 0 || skills.once ? skillsChipLabel(skills.selected, skills.once) : undefined,
            onSelect: () => (skills.load(), setTimeout(() => setPopover("skills"), 0)),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(speechSupported && !call ? [{ id: "dictation", label: "Dictate", icon: <Glyph name="mic" size={16} />, onSelect: () => setDictating(true) }] : []),
  ];
  const composerMode = composerModeOf(model.runtimeMode, model.interactionMode);
  const modeInfo = composerModeInfo(composerMode);
  const modeEntries: MenuEntry[] = availableComposerModes(caps?.approvals, caps?.planMode ?? true).map((m) => ({
    id: `mode:${m.mode}`,
    label: m.label,
    l2: m.description,
    icon: <Glyph name={m.glyph} size={16} />,
    checked: m.mode === composerMode,
    onSelect: () => setComposerMode(actions, m.mode, model.runtimeMode),
  }));
  const insertPalette = (marker: "@" | "/") => {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart ?? draft.length;
    const end = field.selectionEnd ?? start;
    // Opening a menu can move focus. If selection left the editor, append to the draft.
    const hasCaret = field.contains(window.getSelection()?.anchorNode ?? null);
    const from = hasCaret ? Math.min(start, end) : draft.length;
    const to = hasCaret ? Math.max(start, end) : from;
    const left = draft.slice(0, from);
    const lineHasText = left.slice(left.lastIndexOf("\n") + 1).trim().length > 0;
    const separator = marker === "/" ? (lineHasText ? "\n" : "") : (left && !/\s$/.test(left) ? " " : "");
    const insert = separator + marker;
    const next = left + insert + draft.slice(to);
    const offset = from + insert.length;
    setDraft(next);
    setCaret(offset);
    setMenuIndex(0);
    setMenuDismissed(false);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(offset, offset);
    });
  };

  const addSections: PlusMenuSection[] = [
    [
      { kind: "action", id: "file", label: "Photos & files", icon: Paperclip, disabled: !attachments.enabled, note: attachments.enabled ? undefined : UPLOADS_OFF_NOTE, onSelect: () => fileInput.current?.click() },
      ...(attachments.enabled ? [
        { kind: "action", id: "library", label: "Browse Library", icon: FolderOpen, onSelect: () => setLibraryOpen(true) },
        ...((features?.googleDriveFiles ?? features?.cloudAttach) ? [
          { kind: "action", id: "google-drive", label: "Google Drive", icon: GoogleDriveMark, onSelect: () => setCloudPicker("google-drive") },
        ] as const : []),
        ...(attachments.canScreenshot ? [
          { kind: "action", id: "capture", label: "Take a screenshot", icon: Camera, onSelect: () => void attachments.captureScreenshot() },
        ] as const : []),
      ] as const : []),
    ],
    [
      { kind: "action", id: "mention", label: "Mention a workspace file", icon: AtSign, detail: "@", keyHint: true, onSelect: () => insertPalette("@") },
      { kind: "action", id: "cmd", label: "Use a command", icon: Slash, detail: "/", keyHint: true, onSelect: () => insertPalette("/") },
      ...(onStartingPoint ? [{
        kind: "sub" as const,
        id: "starting-points",
        label: "Starting points",
        icon: List,
        render: () => CODE_STARTERS.map(({ label, prompt }) => (
          <PlusMenuRow key={label} onSelect={() => onStartingPoint(prompt)}>{label}</PlusMenuRow>
        )),
      }] : []),
      ...(hasDraft && voice.onOpenVoiceMode ? [
        { kind: "action", id: "voice", label: "Start voice conversation", icon: AudioLines, onSelect: voice.onOpenVoiceMode },
      ] as const : []),
    ],
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
          <button type="button" className="cv2-btn ink" onClick={() => setPopover("catalog")}>
            Switch model
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <ChatComposerField
        ref={textarea}
        home={tall}
        conversationId={model.uploadConversationId ?? null}
        mentionsDisabled
        onTokensChange={ignoreTokens}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? "code-composer-suggestions" : undefined}
        aria-activedescendant={menuOpen ? `code-composer-option-${Math.min(menuIndex, menuItems.length - 1)}` : undefined}
        value={draft}
        disabled={!connected || readOnly}
        placeholder={!connected ? "Connect a subscription or add a key to start" : call ? "Type while you talk\u2026" : revising ? "What should change in the plan?" : landing ? LANDING_PLACEHOLDER : placeholder(running)}
        aria-label="Message"
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart);
          setMenuIndex(0);
          setMenuDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          attachments.onKeyDown(e);
          onKeyDown(e);
        }}
        onPaste={attachments.onPaste}
        onFocus={() => {
          focused.current = true;
          onFocusChange?.(true);
        }}
        onBlur={() => {
          focused.current = false;
          onFocusChange?.(false);
        }}
      />
    );
  }
  const showFoot = !pending.length && !(plan && !revising) && model.state !== "limited";
  const showRow = showFoot && attachments.uploads.length > 0;
  const deviceName = model.device ? "This Mac" : "Set up your Mac";
  const keepInline = () => {
    const text = attachments.keepInline();
    if (text === null) return;
    const el = textarea.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const canStartVoice = !call && !hasDraft && !running && !!voice.onOpenVoiceMode;
  const stopsRun = !call && mode === "stop";
  const sendLabel = mode === "queue" ? "Queue" : "Send";
  const lockedLabel = attachments.uploading && hasDraft ? ATTACHMENTS_UPLOADING_LABEL : waitingOn;
  let primary: React.ComponentProps<typeof ChatComposerSurface>["primary"];
  if (canStartVoice) {
    primary = {
      face: "voice",
      "aria-label": "Start voice conversation",
      tooltip: "Voice conversation",
      onClick: voice.onOpenVoiceMode,
    };
  } else if (!call || hasDraft) {
    primary = {
      face: stopsRun ? "stop" : "send",
      disabled: mode === "disabled",
      "aria-label": stopsRun ? "Stop" : lockedLabel ?? sendLabel,
      tooltip: stopsRun ? "Stop (Esc Esc)" : lockedLabel ?? sendLabel,
      onClick: () => stopsRun ? actions.stop() : submit(running ? (canQueue ? "queue" : "steer") : "send"),
    };
  }

  const layout = (
    <div className="cv2-cstack" ref={stackRef} data-variant={variant}>
      {call?.notices}
      <DictationSwap active={dictating} draft={draft} onCancel={() => setDictating(false)} onClose={closeDictation}>
      <ChatComposerSurface
        ref={shellRef}
        frame={tall ? "home" : "dock"}
        className={cn("cv2-composer", tone)}
        voice={call}
        data-state={tone || (running ? "running" : "idle")}
        hideControls={!showFoot}
        {...(showFoot ? attachments.dropHandlers : {})}
        above={showRow ? <ComposerAttachmentRow uploads={attachments.uploads} onRemove={attachments.remove} /> : undefined}
        field={
          <>
            {attachments.dragging && <ComposerDropOverlay className="rounded-composer" />}
        {menuOpen && trigger && (
          <div className="cv2-menu-anchor">
            <div id="code-composer-suggestions" className="cv2-pop" role="listbox" aria-label={trigger.kind === "slash" ? "Commands" : "Mentions"}>
              <div className="cv2-pop-body" style={{ maxHeight: 300 }}>
                {menuItems.map((m, i) => (
                  <React.Fragment key={m.key}>
                    {(i === 0 || menuItems[i - 1].section !== m.section) && <div className="cv2-msect">{m.section}</div>}
                    <button
                      type="button"
                      role="option"
                      id={`code-composer-option-${i}`}
                      aria-selected={i === menuIndex}
                      className="cv2-mi"
                      data-active={i === menuIndex}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => pick(i)}
                      onMouseEnter={() => setMenuIndex(i)}
                    >
                      <span className="cv2-trunc" style={{ flex: "none", maxWidth: "60%" }}>
                        {m.name}
                      </span>
                      {m.sub && <span className="cv2-small cv2-mute cv2-trunc">{m.sub}</span>}
                      {m.trail && <span className="trail">{m.trail}</span>}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
            {body}
          </>
        }
        add={connected ? {
          open: popover === "attach",
          onOpenChange: (open) => setPopover(open ? "attach" : null),
          label: "Add files and more",
          tooltip: "Add files and more",
          sections: addSections,
          sectionLabels: ["Attach", "Compose"],
        } : undefined}
        model={connected ? (
          <button type="button" className={cn(composerChipClass, "cv2-model-chip")} aria-expanded={popover === "model" || popover === "catalog"} aria-haspopup="dialog" aria-label={`Model: ${words.model}${words.effortName ? `, ${words.effortName}` : ""}`} onClick={() => setPopover(popover === "catalog" || popover === "model" ? null : "catalog")}>
            {instance && <ModelMark modelId={selection.model} instance={instance} className="mark" />}
            <span className="v cv2-trunc">{words.model}</span>
            {words.effort && <span className="eff">{words.effort}</span>}
            <Glyph name="chevron-down" size={12} className="chev" />
          </button>
        ) : (
          <button type="button" className={composerChipClass} onClick={actions.openConnections}>Connect <Glyph name="chevron-down" size={12} /></button>
        )}
        context={connected && <ContextRing usage={model.usage} onOpen={() => toggle("context")} expanded={popover === "context"} />}
        dictate={connected && speechSupported ? {
          active: dictating,
          onOpen: () => setDictating(true),
        } : undefined}
        primary={primary}
      />
      <ComposerFileInputs fileInputRef={fileInput} onFiles={attachments.addFiles} />
      {showFoot && escArmed !== null && running && <div className="cv2-under" role="status">Press Esc again to stop</div>}
      </DictationSwap>
      {showFoot && !call && (
        <div className="composer-tray composer-tray--dock">
          <div ref={toolsRef} className="composer-tray__row cv2-tools-row">
            {workspaceControls}
            {connected && <div className="composer-tray__capsule cv2-tools" role="group" aria-label="Code tools">
              {team && (
                <ComposerTeam routing={routing} lead={selection} instances={instances} scope={{ session: model.thread.id, project: model.thread.repo }}
                  fresh={model.items.length === 0} setRouting={actions.setRouting} popover={popover} setPopover={setPopover}
                  flags={model.flags} onLeadChange={actions.setSelection} onConnect={actions.openConnections} />
              )}
              <button type="button" className="composer-tray__item" aria-haspopup="menu" aria-expanded={popover === "mode"}
                aria-label={`Mode: ${modeInfo.label}`} title={modeInfo.description} onClick={() => toggle("mode")}>
                <Glyph name={modeInfo.glyph} size={14} />
                <span className="truncate">{modeInfo.label}</span>
                <Glyph name="chevron-down" size={12} className="chev" />
              </button>
              {skills && <SkillsChip skills={skills} open={popover === "skills"} onToggle={() => toggle("skills")} />}
            </div>}
            {model.queue.length > 0 && (
              <button type="button" className="composer-tray__item ms-auto" aria-haspopup="dialog" aria-expanded={popover === "queue"} onClick={() => toggle("queue")}>Queued ({model.queue.length})</button>
            )}
          </div>
        </div>
      )}
      {showFoot && (
        <>
            <ComposerPopover open={popover === "mode"} onClose={() => setPopover(null)} width={300} align="left" offset={0} label="Mode" anchorRef={toolsRef} role="menu">
              <MenuList entries={modeEntries} onClose={() => setPopover(null)} label="Mode" />
            </ComposerPopover>
            <ComposerPopover open={popover === "overflow"} onClose={() => setPopover(null)} width={280} align="left" offset={0} label="Options" anchorRef={shellRef} role="menu">
              <div className="cv2-pop-grab" aria-hidden />
              <MenuList entries={overflow} onClose={() => setPopover(null)} label="Options" />
            </ComposerPopover>
            {skills && <SkillsPicker skills={skills} open={popover === "skills"} onClose={() => setPopover(null)} anchorRef={toolsRef} />}
            <ComposerPopover open={popover === "queue"} onClose={() => setPopover(null)} width={360} align="right" offset={0} label="Queued messages" anchorRef={shellRef}>
              <QueueMenu model={model} canSteer={canSteer && running} mac={mac} onEdit={(text, id) => (actions.removeQueued(id), setDraft(text), setPopover(null), requestAnimationFrame(() => textarea.current?.focus()))} />
            </ComposerPopover>
            <ModelPicker
              open={popover === "model" || popover === "catalog" || popover === "context"}
              onClose={() => setPopover(null)}
              instances={instances}
              selection={selection}
              flags={model.flags}
              onSelect={actions.setSelection}
              onConnect={actions.openConnections}
              anchorRef={shellRef}
              initialView={popover === "context" ? "context" : popover === "catalog" ? "models" : "effort"}
              threadTokens={threadTokens}
              onCompactAndSwitch={(sel) => {
                actions.compact?.();
                actions.setSelection(sel);
              }}
            />
        </>
      )}
      {attachments.enabled && <LibraryPicker open={libraryOpen} onOpenChange={setLibraryOpen} onAttach={attachments.addAttachments} existingCount={attachments.uploads.length} />}
      {attachments.enabled && cloudPicker && <CloudFilePicker
        provider={cloudPicker}
        open
        onOpenChange={(open) => { if (!open) setCloudPicker(null); }}
        onAttach={attachments.addAttachments}
        conversationId={model.uploadConversationId}
        existingCount={attachments.uploads.length}
      />}
      {attachments.lastPaste && (
        <div className="cv2-under" role="status">
          <span>{PASTE_FILE_NOTE}</span>
          <button type="button" className="cv2-link" onClick={keepInline} title={mac ? "⇧⌘V pastes inline" : "Ctrl+Shift+V pastes inline"}>
            {KEEP_INLINE_LABEL}
          </button>
        </div>
      )}
      {landing ? (
        under
      ) : (
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
          <Glyph name="laptop" size={12} />
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
      )}
      {!landing && model.offline && (
        <div className="cv2-under">
          <span>Reconnect to run on {model.device?.name ?? "your Mac"}. Messages send when it is back.</span>
        </div>
      )}
    </div>
  );
  return app ? layout : <TooltipProvider>{layout}</TooltipProvider>;
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
