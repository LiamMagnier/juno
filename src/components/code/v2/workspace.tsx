"use client";

/**
 * The Alevr Code v2 workspace (DESIGN §1, §4.1, §4.2, §6, §8): sidebar, top
 * bar, the thread with its composer, and the right dock. Renders entirely
 * from a `WorkspaceModel` (the live route builds it from the env server or
 * the CodeTask path; the /dev/code-v2 gallery from fixtures), so every state
 * can be shown and tested without a backend.
 */
import * as React from "react";
import type { DockTab } from "@/lib/code-v2/dock";
import { DOCK_TAB_GLYPHS, DOCK_TAB_LABELS, dockReducer, initialDockState } from "@/lib/code-v2/dock";
import { COMMAND_TITLES, DEFAULT_KEYBINDINGS, bindingFor, resolveKeybinding, type KeyContext } from "@/lib/code-v2/keymap";
import { DETAIL_LEVEL_LABELS, nextDetailLevel, type DetailLevel } from "@/lib/code-v2/turns";
import { Composer, pendingRequests, type ComposerHandle, type PopoverName } from "./composer";
import { ConnectionsPanel } from "./connections";
import { Dock, visibleTabs, type DockFocus } from "./dock";
import { cycleEffort, cycleRuntimeMode, findInstance } from "./model-info";
import { Glyph, Kbd, useIsMac } from "./primitives";
import { ThreadSidebar } from "./sidebar";
import { Thread, type DockRequest } from "./thread";
import type { WorkspaceModel, WorkspaceUiState } from "./types";
import { cn } from "@/lib/utils";
import type { ByokClient } from "@/lib/code-v2/byok-client";
import type { ProviderInstance } from "@/lib/code-v2/contracts";

const WIDTH_KEY = "alevr.code.dockWidth";
const DETAIL_KEY = "alevr.code.detailLevel";

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

export interface CodeWorkspaceProps {
  model: WorkspaceModel;
  ui?: WorkspaceUiState;
  /** Hide the Code sidebar (the app shell draws its own). */
  sidebar?: boolean;
  userName?: string;
  byok?: ByokClient;
  /** Connections sheet hooks (probe / setup through the env server). */
  onProbe?: (instanceId: string) => Promise<ProviderInstance | void>;
  onSetup?: (instance: ProviderInstance, action: "install" | "login") => Promise<void> | void;
  /** Open the Connections sheet on first run (no connected provider and never dismissed). */
  firstRun?: boolean;
  resolveScreenshot?: (ref: string) => string | null;
  className?: string;
}

function Palette({ onClose, onRun, threads, onOpenThread }: { onClose: () => void; onRun: (command: string) => void; threads: { id: string; title: string }[]; onOpenThread: (id: string) => void }) {
  const mac = useIsMac();
  const [q, setQ] = React.useState("");
  const [hi, setHi] = React.useState(0);
  const commands = DEFAULT_KEYBINDINGS.filter((b) => !b.command.startsWith("approval.") && !b.command.startsWith("hunk.") && b.command !== "palette.toggle" && b.command !== "composer.steer");
  const rows = [
    ...threads.map((t) => ({ id: `t:${t.id}`, section: "Threads", label: t.title, key: "", run: () => onOpenThread(t.id) })),
    ...commands.map((b) => ({ id: b.command, section: "Commands", label: COMMAND_TITLES[b.command] ?? b.command, key: b.key, run: () => onRun(b.command) })),
    { id: "connections", section: "Settings", label: "Connections", key: "", run: () => onRun("connections.open") },
  ].filter((r) => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="cv2-scrim" style={{ background: "transparent" }} onClick={onClose} aria-hidden />
      <div
        className="cv2-palette"
        role="dialog"
        aria-label="Command palette"
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
          <Glyph name="search" />
          <input autoFocus placeholder="Search threads and commands" value={q} onChange={(e) => (setQ(e.target.value), setHi(0))} aria-label="Search" />
        </label>
        <div className="cv2-pop-body" role="listbox">
          {rows.map((r, i) => (
            <React.Fragment key={r.id}>
              {(i === 0 || rows[i - 1].section !== r.section) && <div className="cv2-pop-sect">{r.section}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === hi}
                className="cv2-opt"
                data-active={i === hi}
                onMouseEnter={() => setHi(i)}
                onClick={() => {
                  r.run();
                  onClose();
                }}
              >
                <span className="cv2-grow cv2-trunc">{r.label}</span>
                {r.key && <Kbd k={r.key} mac={mac} />}
              </button>
            </React.Fragment>
          ))}
          {rows.length === 0 && <div className="cv2-mute" style={{ padding: "10px 16px" }}>Nothing matches.</div>}
        </div>
      </div>
    </>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const mac = useIsMac();
  return (
    <>
      <div className="cv2-scrim" onClick={onClose} aria-hidden />
      <div className="cv2-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="cv2-page">
          <div className="cv2-row" style={{ marginBottom: 14 }}>
            <h1 className="cv2-h1 cv2-grow">Keyboard</h1>
            <button type="button" className="cv2-iconbtn" aria-label="Close" autoFocus onClick={onClose}>
              <Glyph name="close" />
            </button>
          </div>
          <div className="cv2-list">
            {DEFAULT_KEYBINDINGS.map((b) => (
              <div key={`${b.key}:${b.command}`} className="cv2-li" style={{ gridTemplateColumns: "minmax(0,1fr) auto", padding: "8px 16px" }}>
                <span>{COMMAND_TITLES[b.command] ?? b.command}</span>
                <Kbd k={b.key} mac={mac} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function CodeWorkspace({ model, ui = {}, sidebar = true, userName, byok, onProbe, onSetup, firstRun, resolveScreenshot, className }: CodeWorkspaceProps) {
  const mac = useIsMac();
  const [dock, dispatch] = React.useReducer(dockReducer, undefined, () => {
    const s = initialDockState(readStored(WIDTH_KEY, Number) ?? undefined);
    return ui.dockOpen ? { ...s, open: true, tab: ui.dockTab ?? s.tab, expanded: !!ui.dockExpanded } : { ...s, tab: ui.dockTab ?? s.tab };
  });
  const [focus, setFocus] = React.useState<DockFocus>({});
  const [detail, setDetail] = React.useState<DetailLevel>(() => ui.detailLevel ?? readStored(DETAIL_KEY, (s) => s as DetailLevel) ?? "summary");
  const [popover, setPopover] = React.useState<PopoverName>((ui.popover as PopoverName) ?? null);
  const [palette, setPalette] = React.useState(ui.popover === "palette");
  const [shortcuts, setShortcuts] = React.useState(false);
  const [connections, setConnections] = React.useState(false);
  const [sideOpen, setSideOpen] = React.useState(sidebar);
  const [agentId, setAgentId] = React.useState<string | null>(ui.selectedAgentId ?? null);
  const [approvalIndex, setApprovalIndex] = React.useState(0);
  const [composerFocus, setComposerFocus] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const composer = React.useRef<ComposerHandle>(null);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => writeStored(WIDTH_KEY, String(dock.width)), [dock.width]);
  React.useEffect(() => writeStored(DETAIL_KEY, detail), [detail]);
  React.useEffect(() => dispatch({ type: "thread-changed", threadId: model.thread.id }), [model.thread.id]);
  React.useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  // First run: no connected provider at all, and the reader has not dismissed the sheet.
  React.useEffect(() => {
    if (!firstRun) return;
    if (readStored("alevr.code.connectionsSeen", (s) => s === "1")) return;
    setConnections(true);
  }, [firstRun]);

  const running = model.state === "running" || model.state === "waiting";
  const pending = pendingRequests(model.items);
  const tabs = visibleTabs(model);

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
    else setConnections(true);
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
          setSideOpen((s) => !s);
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
          setPopover("model");
          return true;
        case "picker.orchestrate":
          setPopover("orchestrate");
          return true;
        case "picker.contextWindow":
          setPopover("tier");
          return true;
        case "composer.cycleEffort":
          a.setSelection(cycleEffort(model.instances, model.selection));
          return true;
        case "composer.cycleMode":
          a.setRuntimeMode(cycleRuntimeMode(model.runtimeMode, findInstance(model.instances, model.selection.instanceId)?.capabilities?.approvals));
          return true;
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
          void navigator.clipboard?.writeText(`${model.thread.title} (${model.thread.repo}${model.thread.branch ? ` · ${model.thread.branch}` : ""})`);
          setToast("Copied a reference to this thread.");
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

  // The keyboard map (DESIGN §8), resolved against the focus context.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const ctx: KeyContext = {
        terminalFocus: !!t?.closest?.(".cv2-term, .cv2-term-input"),
        composerFocus: !!t?.classList?.contains("cv2-draft"),
        editableFocus: editable,
        turnRunning: running,
        approvalOpen: pending.length > 0,
        approvalMany: pending.length > 1,
        popoverOpen: popover !== null || palette,
        modelPickerOpen: popover === "model",
        dockOpen: dock.open,
        changesFocus: dock.open && dock.tab === "changes",
        queueNotEmpty: model.queue.length > 0,
      };
      // ⌥ chords report a composed character on the Mac: match by key code.
      const key = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key;
      const command = resolveKeybinding({ key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }, ctx, DEFAULT_KEYBINDINGS, mac);
      if (!command) return;
      // The composer and the Changes pane own these when they have focus.
      if (command === "composer.steer" || command.startsWith("hunk.") || command === "diff.toggleSplit" || command === "thread.undoLastTurn" || command === "thread.find") return;
      if (command === "approval.allowOnce" && editable) return;
      if (run(command)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, running, pending.length, popover, palette, dock.open, dock.tab, model.queue.length, mac]);

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
    />
  );
  const empty = model.items.length === 0 && !model.starting;
  const narrowDockOpen = dock.open;

  return (
    <div
      ref={root}
      className={cn("cv2 cv2-app", !(sidebar && sideOpen) && "no-side", className)}
      data-reduced-motion={ui.reducedMotion ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      data-composer-focus={composerFocus ? "true" : undefined}
    >
      {sidebar && sideOpen && (
        <ThreadSidebar
          threads={model.threads ?? []}
          activeId={model.thread.id}
          userName={userName}
          onOpen={(id) => model.actions.openThread?.(id)}
          onNew={() => model.actions.newThread?.()}
          onSearch={() => setPalette(true)}
          onConnections={openConnections}
        />
      )}
      <main className="cv2-main" aria-label={model.thread.title}>
        <header className="cv2-top">
          <button type="button" className="cv2-iconbtn cv2-only-narrow" aria-label="Threads" onClick={() => model.actions.openThread ? setPalette(true) : undefined}>
            <Glyph name="chevron-left" />
          </button>
          <button
            type="button"
            className="cv2-top-title cv2-trunc"
            title="Double-click to rename"
            onDoubleClick={() => {
              const next = window.prompt("Rename this thread", model.thread.title);
              if (next && next.trim()) model.actions.renameThread?.(next.trim());
            }}
          >
            {model.thread.title}
          </button>
          <span className="cv2-top-where cv2-mono cv2-trunc">
            {model.thread.repo}
            {model.thread.branch ? ` · ${model.thread.branch}` : ""}
          </span>
          <div className="cv2-top-actions">
            {(["terminal", "changes", "files", "preview", "agents"] as DockTab[])
              .filter((t) => t !== "agents" || tabs.includes("agents"))
              .map((t) => {
                const b = bindingFor(`dock.${t}`);
                return (
                  <button
                    key={t}
                    type="button"
                    className={cn("cv2-iconbtn", t !== "changes" && "cv2-wide")}
                    aria-pressed={dock.open && dock.tab === t}
                    aria-label={DOCK_TAB_LABELS[t]}
                    title={b ? `${DOCK_TAB_LABELS[t]} (${b.key.replace("mod", mac ? "⌘" : "Ctrl").replace("shift", "⇧").replace(/\+/g, "").toUpperCase()})` : DOCK_TAB_LABELS[t]}
                    onClick={() => toggleDock(t)}
                  >
                    <Glyph name={DOCK_TAB_GLYPHS[t]} />
                  </button>
                );
              })}
            <button type="button" className="cv2-iconbtn" aria-label="Command palette" title="More" onClick={() => setPalette(true)}>
              <Glyph name="more" />
            </button>
          </div>
        </header>
        <div className={cn("cv2-body", dock.open && dock.expanded && "expanded")}>
          <div className="cv2-thread-col">
            {empty ? (
              <div className="cv2-empty">
                <div className="where cv2-mono">
                  {model.thread.repo}
                  {model.thread.branch ? ` · ${model.thread.branch}` : ""}
                </div>
                <div className="cv2-col" style={{ width: "100%" }}>
                  {composerNode}
                </div>
              </div>
            ) : (
              <>
                <Thread
                  items={model.items}
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
                  starting={model.starting}
                  offline={model.offline}
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
          {dock.open && (
            <>
              {narrowDockOpen && <div className="cv2-scrim cv2-only-overlay" onClick={() => dispatch({ type: "close" })} aria-hidden />}
              <Dock
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
        </div>
      </main>
      {palette && (
        <Palette
          onClose={() => setPalette(false)}
          onRun={(c) => run(c)}
          threads={(model.threads ?? []).filter((t) => t.id !== model.thread.id).map((t) => ({ id: t.id, title: t.title }))}
          onOpenThread={(id) => model.actions.openThread?.(id)}
        />
      )}
      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      {connections && (
        <ConnectionsPanel
          sheet
          instances={model.instances}
          device={model.device}
          flags={model.flags}
          byok={byok}
          keys={model.byokKeys}
          onProbe={onProbe}
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
      {toast && (
        <div className="cv2-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
