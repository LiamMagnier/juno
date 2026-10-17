"use client";

/**
 * The Alevr Code workspace (TARGET §2): the sidebar's list of work, a 48 px
 * header with the breadcrumb and at most three icon buttons, the thread with
 * its composer, and the right panel, closed until asked for. Renders entirely
 * from a `WorkspaceModel` (the live route builds it from the env server or the
 * CodeTask path; the /dev/code-v2 gallery from fixtures), so every state can
 * be shown and tested without a backend.
 */
import * as React from "react";
import type { DockTab } from "@/lib/code-v2/dock";
import { dockReducer, initialDockState } from "@/lib/code-v2/dock";
import { COMMAND_TITLES, DEFAULT_KEYBINDINGS, resolveKeybinding, type KeyContext } from "@/lib/code-v2/keymap";
import { escPress } from "@/lib/code-v2/composer";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, groupTurns, nextDetailLevel, type DetailLevel } from "@/lib/code-v2/turns";
import { Composer, pendingRequests, type ComposerHandle, type PopoverName } from "./composer";
import { ConnectionsPanel, type ConnectionsProps } from "./connections";
import { Dock, type DockFocus } from "./dock";
import { cycleEffort, findInstance } from "./model-info";
import { composerModeInfo, composerModeOf, cycleComposerMode, setComposerMode } from "@/lib/code-v2/composer-mode";
import { ComposerPopover, Glyph, Kbd, MenuList, useIsMac, type MenuEntry } from "./primitives";
import { CodeWorkList } from "@/components/app/code-work-list";
import { SettingsContent, SettingsSidebar, type SettingsPane } from "./settings";
import { codeSettingsBridge } from "./settings-bridge";
import { openSettings as openAppSettings } from "@/components/settings/settings-sections";
import { Thread, ThreadSkeleton, type DockRequest } from "./thread";
import type { WorkspaceModel, WorkspaceUiState } from "./types";
import { cn } from "@/lib/utils";
import { usePresence } from "@/lib/use-presence";
import { prefersReducedMotion } from "@/lib/motion-preference";
import type { ByokClient } from "@/lib/code-v2/byok-client";
import type { ProviderInstance, TurnItem } from "@/lib/code-v2/contracts";
import { toast as notify } from "sonner";
import { InlineTitleInput } from "./session-actions";
import { ConnectionsHint, NewAgentsBadge, newAgentIds } from "./workspace-notices";
import type { MessageMatch } from "@/lib/code-v2/palette-search";
import { usePaletteMessageSearch } from "./use-palette-search";
import { lastPrompt } from "@/lib/code-v2/answer-actions";
import { cachedCodePrefs, useCodePrefs } from "./use-code-prefs";

const WIDTH_KEY = "alevr.code.dockWidth";
const DETAIL_KEY = "alevr.code.detailLevel";
const DENY_HINT_MAC_MESSAGE = "Esc does not deny. To deny, press Deny or ⌘⌫.";
const DENY_HINT_PC_MESSAGE = "Esc does not deny. To deny, press Deny or Ctrl+Backspace.";
const SPEAKER_YOU_LABEL = "You";
const SPEAKER_ALEVR_LABEL = "Alevr";
const IN_THIS_SESSION_LABEL = "In this session";
const IN_OTHER_SESSIONS_LABEL = "In other sessions";

function readStored<T>(key: string, parse: (s: string) => T | undefined): T | undefined {
  try {
    const v = localStorage.getItem(key);
    return v === null ? undefined : parse(v);
  } catch {
    return undefined;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: per-viewer convenience only */
  }
}

/** Gallery and deep-link names for the composer's popovers. */
function popoverFromUi(p: string | null | undefined): PopoverName {
  if (p === "tier") return "context";
  if (p === "orchestrate") return "team";
  if (p === "model" || p === "catalog" || p === "context" || p === "team" || p === "overflow" || p === "attach" || p === "queue" || p === "device" || p === "skills") return p;
  return null;
}

export interface CodeWorkspaceProps {
  model: WorkspaceModel;
  ui?: WorkspaceUiState;
  /** Hide the Code sidebar (the app shell draws its own). */
  sidebar?: boolean;
  byok?: ByokClient;
  onProbe?: (instanceId: string) => Promise<ProviderInstance | void>;
  onRefreshSubscriptions?: () => Promise<void>;
  onSetup?: (instance: ProviderInstance, action: "install" | "login") => Promise<void | string> | void | string;
  onManaged?: ConnectionsProps["onManaged"];
  /** Open the Connections sheet on first run (no connected provider and never dismissed). */
  firstRun?: boolean;
  /** Draw skeleton lines while the session loads. */
  loading?: boolean;
  resolveScreenshot?: (ref: string) => string | null;
  className?: string;
}

/**
 * A surface leaving (usePresence): `data-state="closed"` plays its exit in
 * code-v2.css at about 0.65x the entrance on the accelerate curve, and the
 * animation's end unmounts it.
 */
type ExitProps = { state: "open" | "closed"; onAnimationEnd: (event: React.AnimationEvent<Element>) => void };

const exitOf = (p: ReturnType<typeof usePresence>): ExitProps => ({ state: p.closing ? "closed" : "open", onAnimationEnd: p.onAnimationEnd });

/** Upper bounds for the exits in code-v2.css (0.65 x --dur-mid / --dur-wide); the animation's end normally unmounts first. */
const EXIT_MID_MS = 160;
const EXIT_WIDE_MS = 220;

function Palette({
  onClose,
  onRun,
  threads,
  onOpenThread,
  items,
  openId,
  onJumpTurn,
  exit,
}: {
  onClose: () => void;
  onRun: (command: string) => void;
  threads: { id: string; title: string }[];
  onOpenThread: (id: string) => void;
  /** The open thread's items: its messages are searched too. */
  items: readonly TurnItem[];
  openId: string;
  onJumpTurn: (turnId: string) => void;
  exit: ExitProps;
}) {
  const mac = useIsMac();
  const [q, setQ] = React.useState("");
  const [hi, setHi] = React.useState(0);
  const commands = DEFAULT_KEYBINDINGS;
  const found = usePaletteMessageSearch({ query: q, items, threads, openId });
  const messageRow = (m: MessageMatch, section: string) => ({
    id: m.id,
    section,
    label: m.snippet,
    key: "",
    meta: m.threadTitle ?? (m.who === "you" ? SPEAKER_YOU_LABEL : m.who === "alevr" ? SPEAKER_ALEVR_LABEL : undefined),
    run: () => (m.threadId ? onOpenThread(m.threadId) : m.turnId ? onJumpTurn(m.turnId) : undefined),
  });
  const rows: { id: string; section: string; label: string; key: string; meta?: string; run: () => void }[] = [
    ...threads.map((t) => ({ id: `t:${t.id}`, section: "Sessions", label: t.title, key: "", run: () => onOpenThread(t.id) })),
    { id: "pulls", section: "Go to", label: "Pull requests", key: "", run: () => window.location.assign("/code/pulls") },
    { id: "connections", section: "Go to", label: "Connections", key: "", run: () => onRun("connections.open") },
    ...commands.filter((b) => !b.command.startsWith("approval.") && !b.command.startsWith("hunk.") && b.command !== "palette.toggle" && b.command !== "composer.steer").map((b) => ({ id: b.command, section: "Commands", label: COMMAND_TITLES[b.command] ?? b.command, key: b.key, run: () => onRun(b.command) })),
  ].filter((r) => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase()));
  // What was said comes right after the session titles: in this session, then in the others.
  const titled = rows.filter((r) => r.section === "Sessions").length;
  rows.splice(titled, 0, ...found.here.map((m) => messageRow(m, IN_THIS_SESSION_LABEL)), ...found.elsewhere.map((m) => messageRow(m, IN_OTHER_SESSIONS_LABEL)));
  return (
    <>
      <div className="cv2-scrim" style={{ background: "transparent" }} data-state={exit.state} onClick={onClose} aria-hidden />
      <div
        className="cv2-palette"
        role="dialog"
        aria-label="Command palette"
        data-state={exit.state}
        inert={exit.state === "closed"}
        onAnimationEnd={exit.onAnimationEnd}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter" && rows[hi]) {
            e.preventDefault();
            rows[hi].run();
            onClose();
          }
        }}
      >
        <label className="cv2-pop-search">
          <Glyph name="search" size={16} />
          <input autoFocus placeholder="Search sessions, messages and commands" value={q} onChange={(e) => (setQ(e.target.value), setHi(0))} aria-label="Search" />
        </label>
        <div className="cv2-pop-body" role="listbox">
          {rows.map((r, i) => (
            <React.Fragment key={r.id}>
              {(i === 0 || rows[i - 1].section !== r.section) && <div className="cv2-msect">{r.section}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === hi}
                className="cv2-mi"
                data-active={i === hi}
                onMouseEnter={() => setHi(i)}
                onClick={() => {
                  r.run();
                  onClose();
                }}
              >
                <span className="cv2-grow cv2-trunc">{r.label}</span>
                {r.meta && <span className="trail cv2-trunc" style={{ maxWidth: 140 }}>{r.meta}</span>}
                {r.key && (
                  <span className="trail">
                    <Kbd k={r.key} mac={mac} />
                  </span>
                )}
              </button>
            </React.Fragment>
          ))}
          {rows.length === 0 && <div className="cv2-mute" style={{ padding: "10px 16px" }}>{found.searching ? "Searching messages…" : "Nothing matches."}</div>}
        </div>
      </div>
    </>
  );
}

function Shortcuts({ onClose, exit }: { onClose: () => void; exit: ExitProps }) {
  const mac = useIsMac();
  return (
    <>
      <div className="cv2-scrim" data-state={exit.state} onClick={onClose} aria-hidden />
      <div
        className="cv2-sheet narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-state={exit.state}
        inert={exit.state === "closed"}
        onAnimationEnd={exit.onAnimationEnd}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="cv2-page">
          <div className="cv2-row">
            <h1 className="cv2-h1 cv2-grow">Keyboard</h1>
            <button type="button" className="cv2-iconbtn" aria-label="Close" autoFocus onClick={onClose}>
              <Glyph name="close" />
            </button>
          </div>
          <div className="cv2-keys">
            {DEFAULT_KEYBINDINGS.map((b) => (
              <React.Fragment key={`${b.key}:${b.command}`}>
                <span>{COMMAND_TITLES[b.command] ?? b.command}</span>
                <Kbd k={b.key} mac={mac} />
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function CodeWorkspace({ model, ui = {}, sidebar = true, byok, onProbe, onRefreshSubscriptions, onSetup, onManaged, firstRun, loading, resolveScreenshot, className }: CodeWorkspaceProps) {
  const mac = useIsMac();
  const [dock, dispatch] = React.useReducer(dockReducer, undefined, () => {
    const s = initialDockState(readStored(WIDTH_KEY, Number) ?? undefined);
    return ui.dockOpen ? { ...s, open: true, tab: ui.dockTab ?? s.tab, expanded: !!ui.dockExpanded } : { ...s, tab: ui.dockTab ?? s.tab };
  });
  const [focus, setFocus] = React.useState<DockFocus>({});
  // The work log's level: this device's choice, else the account's default (Settings › Code), else Summary.
  const storedDetail = () => readStored(DETAIL_KEY, (s) => ((DETAIL_LEVELS as readonly string[]).includes(s) ? (s as DetailLevel) : undefined));
  const [detail, setDetailState] = React.useState<DetailLevel>(() => ui.detailLevel ?? storedDetail() ?? cachedCodePrefs().detailLevel ?? "summary");
  const detailChosen = React.useRef<boolean | null>(null);
  detailChosen.current ??= !!ui.detailLevel || storedDetail() !== undefined;
  const setDetail = React.useCallback((next: React.SetStateAction<DetailLevel>) => {
    detailChosen.current = true;
    setDetailState(next);
  }, []);
  const accountDetail = useCodePrefs().prefs.detailLevel;
  React.useEffect(() => {
    if (!detailChosen.current && accountDetail) setDetailState(accountDetail);
  }, [accountDetail]);
  const [popover, setPopover] = React.useState<PopoverName>(popoverFromUi(ui.popover));
  const [palette, setPalette] = React.useState(ui.popover === "palette");
  const [headMenu, setHeadMenu] = React.useState<null | "session" | "more">(ui.popover === "session" ? "session" : ui.popover === "more" ? "more" : null);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [connections, setConnections] = React.useState(false);
  const [sideOpen, setSideOpen] = React.useState(sidebar);
  const [settings, setSettings] = React.useState<SettingsPane | null>(ui.settings ?? null);
  const [agentId, setAgentId] = React.useState<string | null>(ui.selectedAgentId ?? null);
  const [approvalIndex, setApprovalIndex] = React.useState(0);
  const [composerFocus, setComposerFocus] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  // One toast system on this screen: the app's (sonner), not a second bottom-centre pill.
  // A fixed id so a repeated status ("Press Esc again to stop") replaces itself instead of stacking.
  const setToast = React.useCallback((message: string | null) => {
    if (message) notify.message(message, { id: "code-workspace-status" });
  }, []);
  const palettePresence = usePresence(palette, EXIT_MID_MS);
  const shortcutsPresence = usePresence(shortcuts, EXIT_WIDE_MS);
  const dockPresence = usePresence(dock.open, EXIT_WIDE_MS);
  const composer = React.useRef<ComposerHandle>(null);
  const escArmed = React.useRef<number | null>(null);
  const headRef = React.useRef<HTMLDivElement>(null);
  const crumbRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => writeStored(WIDTH_KEY, String(dock.width)), [dock.width]);
  React.useEffect(() => {
    // Only a choice is remembered: a default written back would hide a later change to the account's.
    if (detailChosen.current) writeStored(DETAIL_KEY, detail);
  }, [detail]);
  React.useEffect(() => dispatch({ type: "thread-changed", threadId: model.thread.id }), [model.thread.id]);
  // The dock reads the whole session (every change, command and file), so
  // opening it brings in the turns a paged thread has not loaded yet, as
  // Chat's outputs panel does.
  const loadAllHistory = model.history?.hasOlder ? model.history.loadOlder : null;
  React.useEffect(() => {
    if (dock.open && loadAllHistory) void loadAllHistory({ all: true });
  }, [dock.open, loadAllHistory]);
  React.useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // First run no longer opens Connections over the thread as the first prompt sends (Alevr's
  // included models already work): the empty state offers it in one quiet line instead.
  const [connectionsHint, setConnectionsHint] = React.useState(false);
  React.useEffect(() => {
    setConnectionsHint(!!firstRun && !readStored("alevr.code.connectionsSeen", (s) => s === "1"));
  }, [firstRun]);
  const dismissConnectionsHint = () => {
    writeStored("alevr.code.connectionsSeen", "1");
    setConnectionsHint(false);
  };

  React.useEffect(() => {
    if (popover === "model" || popover === "catalog" || connections || settings === "connections") void onRefreshSubscriptions?.();
  }, [popover, connections, settings, onRefreshSubscriptions]);

  // A new subagent no longer takes over the panel (it interrupted whatever was open there):
  // it raises a count on the panel button, cleared when the Agents tab is looked at.
  const seenAgents = React.useRef<Set<string> | null>(null);
  const [unseenAgents, setUnseenAgents] = React.useState<string[]>([]);
  const agentsInView = dock.open && dock.tab === "agents";
  React.useEffect(() => {
    seenAgents.current = null;
    setUnseenAgents([]);
  }, [model.thread.id]);
  React.useEffect(() => {
    // The first pass with items is history, not news. A Mac thread renders empty until its log
    // arrives from the env server, so an empty pass is "not loaded yet", not "no agents".
    if (!seenAgents.current && model.items.length === 0) return;
    const ids = model.items.filter((i) => i.kind === "subagent").map((i) => i.agentId);
    const fresh = seenAgents.current ? newAgentIds(seenAgents.current, ids) : [];
    seenAgents.current = new Set(ids);
    if (fresh.length && !agentsInView) setUnseenAgents((u) => [...new Set([...u, ...fresh])]);
  }, [model.items, agentsInView]);
  React.useEffect(() => {
    if (agentsInView) setUnseenAgents([]);
  }, [agentsInView]);

  const running = model.state === "running" || model.state === "waiting";
  const pending = pendingRequests(model.items);
  const turns = React.useMemo(() => groupTurns(model.items, { state: model.state }), [model.items, model.state]);
  const checkpoints = turns.filter((t) => t.checkpoint).map((t) => ({ turn: t, cp: t.checkpoint! }));
  // A retryable failure's Retry sends the last prompt again (it was never wired: a dead end).
  const lastUser = lastPrompt(turns);
  const retryLast = lastUser && !running && model.actions.resend ? () => void model.actions.resend?.(lastUser) : undefined;

  const openDock = React.useCallback(
    (req: DockRequest) => {
      setFocus({ target: req.target, scope: req.scope, turnId: req.turnId });
      if (req.tab === "agents" && req.target) setAgentId(req.target);
      dispatch({ type: "open", tab: req.tab, threadId: model.thread.id });
    },
    [model.thread.id],
  );
  const toggleDock = (tab: DockTab) => dispatch({ type: "toggle", tab, threadId: model.thread.id });
  const openConnections = () => {
    if (model.actions.openConnections) model.actions.openConnections();
    else openAppSettings("connections");
  };
  const rename = () => {
    if (model.actions.renameThread) setRenaming(true);
  };

  const run = React.useCallback(
    (command: string) => {
      const a = model.actions;
      switch (command) {
        case "palette.toggle":
          setPalette((p) => !p);
          return true;
        case "thread.new":
          a.newThread?.();
          return true;
        case "sidebar.toggle":
          if (!sidebar) window.dispatchEvent(new CustomEvent("juno:toggle-sidebar"));
          else setSideOpen((s) => !s);
          return true;
        case "dock.terminal":
          toggleDock("terminal");
          return true;
        case "dock.changes":
          toggleDock("changes");
          return true;
        case "dock.files":
          toggleDock("files");
          return true;
        case "dock.preview":
          toggleDock("preview");
          return true;
        case "dock.agents":
          toggleDock("agents");
          return true;
        case "dock.expand":
          dispatch({ type: "toggle-expand" });
          return true;
        case "picker.model":
          setPopover("catalog");
          return true;
        case "picker.orchestrate":
          setPopover("team");
          return true;
        case "picker.contextWindow":
          setPopover("context");
          return true;
        case "composer.cycleEffort":
          a.setSelection(cycleEffort(model.instances, model.selection));
          return true;
        case "composer.cycleMode": {
          const caps = findInstance(model.instances, model.selection.instanceId)?.capabilities;
          const next = cycleComposerMode(composerModeOf(model.runtimeMode, model.interactionMode), caps?.approvals, caps?.planMode ?? true);
          setComposerMode(a, next, model.runtimeMode);
          setToast(`Mode: ${composerModeInfo(next).label}`);
          return true;
        }
        case "thread.cycleDetail":
          setDetail((d) => {
            const n = nextDetailLevel(d);
            setToast(`Work log: ${DETAIL_LEVEL_LABELS[n].label}`);
            return n;
          });
          return true;
        case "approval.deny":
        case "approval.allowOnce":
        case "approval.allowSession": {
          const req = pending[Math.min(approvalIndex, pending.length - 1)];
          if (!req) return false;
          const decision = command === "approval.deny" ? "decline" : command === "approval.allowOnce" ? "accept" : "acceptForSession";
          if (req.kind === "approval_request" && decision === "acceptForSession" && req.options && !req.options.includes("acceptForSession")) return false;
          void a.respond(req.requestId, decision);
          return true;
        }
        case "approval.previous":
          setApprovalIndex((i) => (i - 1 + pending.length) % pending.length);
          return true;
        case "approval.next":
          setApprovalIndex((i) => (i + 1) % pending.length);
          return true;
        case "thread.copyReference":
          void navigator.clipboard?.writeText(`${model.thread.title} (${model.thread.repo}${model.thread.branch ? `, ${model.thread.branch}` : ""})`);
          setToast("Copied a reference to this session.");
          return true;
        case "shortcuts.show":
          setShortcuts(true);
          return true;
        case "connections.open":
          openConnections();
          return true;
        case "thread.previous":
        case "thread.next": {
          const list = model.threads ?? [];
          const i = list.findIndex((t) => t.id === model.thread.id);
          const next = list[(i + (command === "thread.next" ? 1 : -1) + list.length) % list.length];
          if (next && next.id !== model.thread.id) a.openThread?.(next.id);
          return true;
        }
        default:
          return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, pending, approvalIndex],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const ctx: KeyContext = {
        terminalFocus: !!t?.closest?.(".cv2-term"),
        composerFocus: !!t?.classList?.contains("cv2-draft"),
        editableFocus: editable,
        turnRunning: running,
        approvalOpen: pending.length > 0,
        approvalMany: pending.length > 1,
        popoverOpen: popover !== null || palette || headMenu !== null,
        modelPickerOpen: popover === "model" || popover === "catalog",
        dockOpen: dock.open,
        changesFocus: dock.open && dock.tab === "changes",
        queueNotEmpty: model.queue.length > 0,
      };
      // An Esc a dialog already used (a Radix dialog closing, a sheet, an inline rename) is not
      // also a Stop or a request's hint: one press, one meaning.
      if (e.key === "Escape" && (e.defaultPrevented || t?.closest?.('[role="dialog"]'))) return;
      if (e.key === "Escape" && pending.length > 0 && popover === null && !palette && headMenu === null) {
        // Esc never answers a request (one stray press used to deny it): it only leaves it.
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.(".cv2-approve")) active.blur();
        setToast(mac ? DENY_HINT_MAC_MESSAGE : DENY_HINT_PC_MESSAGE);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && running && pending.length === 0 && popover === null && !palette && !editable) {
        const r = escPress(escArmed.current, Date.now(), running);
        escArmed.current = r.armedAt;
        if (r.stop) model.actions.stop();
        else setToast("Press Esc again to stop");
        e.preventDefault();
        return;
      }
      const key = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key;
      const command = resolveKeybinding({ key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }, ctx, DEFAULT_KEYBINDINGS, mac);
      if (!command) return;
      if (command === "composer.steer" || command.startsWith("hunk.") || command === "diff.toggleSplit" || command === "thread.undoLastTurn" || command === "thread.find") return;
      if (command === "approval.allowOnce" && editable) return;
      if (run(command)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, running, pending.length, popover, palette, headMenu, dock.open, dock.tab, model.queue.length, mac, model.actions, setToast]);

  const empty = model.items.length === 0 && !model.starting && !loading;
  const composerNode = (
    <Composer
      ref={composer}
      model={{ ...model, actions: { ...model.actions, openConnections } }}
      popover={popover}
      setPopover={setPopover}
      approvalIndex={approvalIndex}
      setApprovalIndex={setApprovalIndex}
      onOpenDock={(tab) => openDock({ tab })}
      onFocusChange={setComposerFocus}
      tall={empty}
    />
  );

  const a = model.actions;
  const sessionMenu: MenuEntry[] = [
    ...(a.renameThread ? [{ id: "rename", label: "Rename", icon: <Glyph name="rename" size={16} />, onSelect: rename }] : []),
    ...(a.pinThread
      ? [{ id: "pin", label: model.thread.pinned ? "Unpin" : "Pin", icon: <Glyph name={model.thread.pinned ? "unpin" : "pin"} size={16} />, onSelect: () => a.pinThread?.(!model.thread.pinned) }]
      : []),
    ...(a.shareThread ? [{ id: "share", label: "Share…", icon: <Glyph name="share" size={16} />, onSelect: () => a.shareThread?.() }] : []),
    { id: "copy", label: "Copy reference", icon: <Glyph name="copy" size={16} />, onSelect: () => run("thread.copyReference") },
    ...(checkpoints.length && model.actions.rollback
      ? [
          {
            id: "checkpoints",
            label: "Checkpoints",
            icon: <Glyph name="history" size={16} />,
            sub: {
              title: "Revert to a checkpoint",
              entries: checkpoints.map(({ turn, cp }) => ({
                id: cp.checkpointId,
                label: `After turn ${cp.turnOrdinal}`,
                l2: (turn.user?.text ?? "").replace(/\s+/g, " ").slice(0, 60),
                trail: cp.filesChanged ? `${cp.filesChanged} ${cp.filesChanged === 1 ? "file" : "files"}` : undefined,
                onSelect: () => model.actions.rollback?.(cp.checkpointId),
              })),
            },
          },
        ]
      : []),
    { kind: "sep", id: "s1" },
    {
      id: "detail",
      label: "Work log",
      icon: <Glyph name="list" size={16} />,
      trail: DETAIL_LEVEL_LABELS[detail].label,
      sub: { title: "Work log", entries: DETAIL_LEVELS.map((d) => ({ id: d, label: DETAIL_LEVEL_LABELS[d].label, l2: DETAIL_LEVEL_LABELS[d].description, checked: d === detail, onSelect: () => setDetail(d) })) },
    },
    ...(a.archiveThread || a.deleteThread ? [{ kind: "sep" as const, id: "s2" }] : []),
    ...(a.archiveThread ? [{ id: "archive", label: "Archive", icon: <Glyph name="archive" size={16} />, onSelect: () => a.archiveThread?.() }] : []),
    ...(a.deleteThread ? [{ id: "delete", label: "Delete…", icon: <Glyph name="delete" size={16} />, danger: true, onSelect: () => a.deleteThread?.() }] : []),
  ];
  const moreMenu: MenuEntry[] = [
    ...(model.actions.commit ? [{ id: "commit", label: "Commit…", icon: <Glyph name="commit" size={16} />, onSelect: () => model.actions.commit?.() }] : []),
    { id: "pr", label: "Create pull request…", icon: <Glyph name="pull-request" size={16} />, onSelect: () => composer.current?.setDraft("/pr ") },
    { id: "files", label: "Files", icon: <Glyph name="file-tree" size={16} />, trail: <Kbd k="mod+p" mac={mac} />, onSelect: () => openDock({ tab: "files" }) },
    { id: "preview", label: "Preview", icon: <Glyph name="browser" size={16} />, onSelect: () => openDock({ tab: "preview" }) },
    { kind: "sep", id: "s1" },
    { id: "pulls", label: "Pull requests", icon: <Glyph name="pull-request" size={16} />, onSelect: () => window.location.assign("/code/pulls") },
    { id: "conn", label: "Connections", icon: <Glyph name="plug" size={16} />, onSelect: openConnections },
    { id: "settings", label: "Settings", icon: <Glyph name="settings" size={16} />, onSelect: () => openAppSettings("code") },
    { id: "keys", label: "Keyboard shortcuts", icon: <Glyph name="keyboard" size={16} />, trail: <Kbd k="mod+/" mac={mac} />, onSelect: () => setShortcuts(true) },
  ];

  const connectionsProps: ConnectionsProps = React.useMemo(() => ({ instances: model.instances, device: model.device, flags: model.flags, byok, keys: model.byokKeys, onProbe, onManaged, onSetup, alevrPlan: ui.alevrPlan }), [model.instances, model.device, model.flags, byok, model.byokKeys, onProbe, onManaged, onSetup, ui.alevrPlan]);
  const settingsOwner = React.useRef({});
  React.useEffect(() => {
    codeSettingsBridge.publish(settingsOwner.current, {
      connections: connectionsProps, instances: model.instances, routing: model.routing,
      lead: model.selection, onRouting: model.actions.setRouting, runtimeMode: model.runtimeMode,
      onRuntimeMode: model.actions.setRuntimeMode, detail, onDetail: setDetail,
    });
  }, [connectionsProps, model.instances, model.routing, model.selection, model.actions.setRouting, model.actions.setRuntimeMode, model.runtimeMode, detail, setDetail]);
  React.useEffect(() => {
    const owner = settingsOwner.current;
    return () => codeSettingsBridge.clear(owner);
  }, []);
  if (settings) {
    return (
      <div className={cn("cv2 cv2-app", !(sidebar && sideOpen) && "no-side", className)} data-motion={ui.reducedMotion ? "reduced" : undefined}>
        {sidebar && sideOpen && <SettingsSidebar pane={settings} onPane={setSettings} onBack={() => setSettings(null)} />}
        <main className="cv2-main" aria-label="Settings">
          <div className="cv2-left">
            <header className="cv2-top">
              {!(sidebar && sideOpen) && (
                <button type="button" className="cv2-iconbtn" aria-label="Back to the session" title="Back" onClick={() => setSettings(null)} style={{ marginLeft: -8 }}>
                  <Glyph name="arrow-left" />
                </button>
              )}
              <div className="cv2-crumb">
                <span className="proj">Settings</span>
                <span className="slash" aria-hidden>
                  /
                </span>
                <span className="title" style={{ pointerEvents: "none" }}>
                  {settings.charAt(0).toUpperCase() + settings.slice(1)}
                </span>
              </div>
            </header>
            <div className="cv2-body">
              <SettingsContent
                pane={settings}
                connections={connectionsProps}
                instances={model.instances}
                routing={model.routing}
                lead={model.selection}
                onRouting={model.actions.setRouting}
                runtimeMode={model.runtimeMode}
                onRuntimeMode={model.actions.setRuntimeMode}
                detail={detail}
                onDetail={setDetail}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div
      className={cn("cv2 cv2-app", !(sidebar && sideOpen) && "no-side", className)}
      data-motion={ui.reducedMotion ? "reduced" : undefined}
      data-hidden={hidden ? "true" : undefined}
      data-composer-focus={composerFocus ? "true" : undefined}
    >
      {sidebar && sideOpen && (
        <nav className="cv2-side" aria-label="Code sessions">
          <div className="cv2-side-scroll" style={{ paddingTop: 12 }}>
            <CodeWorkList threads={model.threads ?? []} activeId={model.thread.id} onOpen={(id) => model.actions.openThread?.(id)} />
          </div>
        </nav>
      )}
      <main className={cn("cv2-main", dock.open && dock.expanded && "expanded")} aria-label={model.thread.title}>
        <div className="cv2-left">
        <header className="cv2-top">
          <button type="button" className="cv2-iconbtn cv2-only-narrow" aria-label="Sessions" onClick={() => (sidebar ? setPalette(true) : window.dispatchEvent(new CustomEvent("juno:toggle-sidebar")))}>
            <Glyph name="sidebar-toggle" />
          </button>
          <div className="cv2-crumb" ref={crumbRef}>
            <span className="proj">{model.thread.repo}</span>
            <span className="slash" aria-hidden>
              /
            </span>
            {renaming ? (
              <InlineTitleInput
                className="cv2-title-edit"
                initial={model.thread.title}
                onCommit={(value) => {
                  setRenaming(false);
                  if (value.trim() && value.trim() !== model.thread.title) model.actions.renameThread?.(value.trim());
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <button type="button" className="title" aria-haspopup="menu" aria-expanded={headMenu === "session"} onClick={() => setHeadMenu(headMenu === "session" ? null : "session")} onDoubleClick={rename} title={model.thread.title}>
                <span className="cv2-trunc">{empty ? "New session" : model.thread.title}</span>
                <Glyph name="chevron-down" size={14} className="cv2-mute" />
              </button>
            )}
            <ComposerPopover open={headMenu === "session"} onClose={() => setHeadMenu(null)} width={260} align="left" offset={0} label="Session" anchorRef={crumbRef} down role="menu">
              <MenuList entries={sessionMenu} onClose={() => setHeadMenu(null)} label="Session" />
            </ComposerPopover>
          </div>
          <div className="cv2-top-actions" ref={headRef}>
            <button type="button" className="cv2-iconbtn" aria-pressed={dock.open && dock.tab === "terminal"} aria-label="Terminal" title={`Terminal (${mac ? "⌘J" : "Ctrl J"})`} onClick={() => toggleDock("terminal")}>
              <Glyph name="terminal" />
            </button>
            <button
              type="button"
              className="cv2-iconbtn cv2-badged"
              aria-pressed={dock.open && dock.tab !== "terminal"}
              aria-label="Changes and panel"
              title={`Changes (${mac ? "⌘D" : "Ctrl D"})`}
              // New agents waiting to be seen: this opens on them.
              onClick={() => (unseenAgents.length ? openDock({ tab: "agents" }) : dock.open && dock.tab !== "terminal" ? dispatch({ type: "close" }) : openDock({ tab: dock.tab === "terminal" ? "changes" : dock.tab }))}
            >
              <Glyph name="panel-right" />
              <NewAgentsBadge count={unseenAgents.length} />
            </button>
            <button type="button" className="cv2-iconbtn" aria-label="More" aria-haspopup="menu" aria-expanded={headMenu === "more"} onClick={() => setHeadMenu(headMenu === "more" ? null : "more")}>
              <Glyph name="more" />
            </button>
            <ComposerPopover open={headMenu === "more"} onClose={() => setHeadMenu(null)} width={260} align="right" offset={0} label="More" anchorRef={headRef} down role="menu">
              <MenuList entries={moreMenu} onClose={() => setHeadMenu(null)} label="More" />
            </ComposerPopover>
          </div>
        </header>
        <div className="cv2-body">
          <div className="cv2-thread-col">
            {loading ? (
              <ThreadSkeleton />
            ) : empty ? (
              <div className="cv2-empty">
                <div className="spacer-top" />
                <h1>
                  {model.thread.repo ? (
                    <>
                      What will you build in <span className="proj">{model.thread.repo}</span>?
                    </>
                  ) : (
                    "What will you build?"
                  )}
                </h1>
                {model.pairingRequired && (
                  <div className="cv2-col">
                    <div className="cv2-notice" role="status">
                      This browser cannot control {model.pairingRequired.deviceName} yet.{" "}
                      <a href="/pair" className="underline underline-offset-4">
                        Pair this browser
                      </a>
                    </div>
                  </div>
                )}
                <div className="cv2-col">{composerNode}</div>
                {connectionsHint && (
                  <div className="cv2-col">
                    <ConnectionsHint onOpen={() => (dismissConnectionsHint(), setConnections(true))} onDismiss={dismissConnectionsHint} />
                  </div>
                )}
                <div className="spacer-bottom" />
              </div>
            ) : (
              <>
                <Thread
                  items={model.items}
                  history={model.history}
                  state={model.state}
                  instances={model.instances}
                  detailLevel={detail}
                  budgetUsd={model.routing.budget?.maxUsd}
                  selectedAgentId={agentId}
                  onSelectAgent={setAgentId}
                  onOpenDock={openDock}
                  onRollback={model.actions.rollback}
                  onApprovePlan={model.actions.approvePlan}
                  onUndoTurn={model.actions.rollback ? (turn) => turn.checkpoint && model.actions.rollback?.(turn.checkpoint.checkpointId) : undefined}
                  onRetry={retryLast}
                  onResend={model.actions.resend}
                  onEditMessage={(text) => composer.current?.setDraft(text)}
                  feedbackFor={model.actions.feedbackFor}
                  onFeedback={model.actions.setFeedback}
                  starting={model.starting}
                  offline={model.offline}
                  pairingRequired={model.pairingRequired}
                  resolveScreenshot={resolveScreenshot}
                />
                {!(dock.open && dock.expanded) && (
                  <div className="cv2-cwrap">
                    <div className="cv2-col">{composerNode}</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        </div>
          {dockPresence.mounted && (
            <>
              <div className="cv2-scrim cv2-only-overlay" data-state={dockPresence.closing ? "closed" : "open"} onClick={() => dispatch({ type: "close" })} aria-hidden />
              <Dock
                exit={exitOf(dockPresence)}
                model={model}
                dock={dock}
                dispatch={dispatch}
                focus={focus}
                selectedAgentId={agentId}
                onSelectAgent={setAgentId}
                onMention={(p) => composer.current?.setDraft(`@${p} `)}
                resolveScreenshot={resolveScreenshot}
                composer={dock.expanded && !empty ? composerNode : undefined}
              />
            </>
          )}
      </main>
      {palettePresence.mounted && (
        <Palette
          exit={exitOf(palettePresence)}
          onClose={() => setPalette(false)}
          onRun={(c) => run(c)}
          threads={(model.threads ?? []).filter((t) => t.id !== model.thread.id).map((t) => ({ id: t.id, title: t.title }))}
          onOpenThread={(id) => model.actions.openThread?.(id)}
          items={model.items}
          openId={model.thread.id}
          onJumpTurn={(turnId) =>
            document
              .querySelector<HTMLElement>(`[data-turn="${CSS.escape(turnId)}"]`)
              ?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" })
          }
        />
      )}
      {shortcutsPresence.mounted && <Shortcuts exit={exitOf(shortcutsPresence)} onClose={() => setShortcuts(false)} />}
      {connections && (
        <ConnectionsPanel
          sheet
          instances={model.instances}
          device={model.device}
          flags={model.flags}
          byok={byok}
          keys={model.byokKeys}
          onProbe={onProbe}
          onManaged={onManaged}
          onSetup={async (instance, action) => {
            await onSetup?.(instance, action);
            setConnections(false);
            dispatch({ type: "open", tab: "terminal", threadId: model.thread.id });
          }}
          onClose={() => {
            writeStored("alevr.code.connectionsSeen", "1");
            setConnections(false);
          }}
        />
      )}
    </div>
  );
}
