"use client";

/**
 * The right panel (TARGET §10): closed by default, one tab strip with text
 * labels (Changes, Terminal, Files, and only when relevant Preview, Agents,
 * Screen), expand and close at the right. Resizable by its leading edge,
 * a sheet from the right below 1024 px.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (the diff panel: a turn/session scope menu, file sections, unchanged regions
 * collapsed to an "N unmodified lines" bar, and no accept/reject per hunk).
 */
import * as React from "react";
import { ComputerTimeline } from "@/components/code/computer-timeline";
import type { FileChangeEntry, ProviderInstance, SubagentItem, TurnItem } from "@/lib/code-v2/contracts";
import { DOCK_TAB_LABELS, type DockState, type DockAction, type DockTab, nudgeDockWidth } from "@/lib/code-v2/dock";
import { hunkOrder, keptCounts, moveHunkFocus, parseUnifiedDiff, splitPath, splitRows, type DiffFile, type DiffHunk, type DiffLine, type HunkDecision } from "@/lib/code-v2/diff";
import { aggregateChanges, groupTurns, formatDuration } from "@/lib/code-v2/turns";
import { budgetLine } from "@/lib/code-v2/orchestrate";
import { displayName, shortModelLabel } from "@/lib/code-v2/providers-view";
import { ComposerPopover, Glyph, MenuList, ModelMark, Spinner, useIsMac } from "./primitives";
import { agentStep, isCandidate, teamHead } from "./thread";
import type { WorkspaceModel } from "./types";
import { XtermView } from "./xterm-view";
import { cn } from "@/lib/utils";

export interface DockFocus {
  /** Changes: path. Agents: agent id. Terminal: command item id. Screen: item id. */
  target?: string;
  scope?: "turn" | "thread";
  turnId?: string;
}

export function modelLabelFor(modelId: string, instances: readonly ProviderInstance[], instanceId: string): string {
  const instance = instances.find((i) => i.id === instanceId);
  const m = instance?.models?.find((x) => x.id === modelId);
  return m?.label ?? shortModelLabel(modelId.split(":").pop() ?? modelId);
}

// ── Changes ─────────────────────────────────────────────────────────────────

function highlight(line: DiffLine): React.ReactNode {
  if (!line.marks?.length) return line.text || " ";
  const out: React.ReactNode[] = [];
  let at = 0;
  line.marks.forEach(([a, b], i) => {
    if (a > at) out.push(line.text.slice(at, a));
    out.push(<mark key={i}>{line.text.slice(a, b)}</mark>);
    at = b;
  });
  out.push(line.text.slice(at));
  return out;
}

function Line({ line }: { line: DiffLine }) {
  return (
    <div className={cn("cv2-ln", line.kind === "add" && "a", line.kind === "del" && "d")}>
      <span className="cv2-tnum">{line.kind === "del" ? line.oldNo : line.newNo}</span>
      <span>{highlight(line)}</span>
    </div>
  );
}

export function filesFrom(changes: readonly FileChangeEntry[]): DiffFile[] {
  return changes.map((c) => {
    const parsed = c.diff ? parseUnifiedDiff(c.diff, c.path) : [];
    const file = parsed.find((f) => f.path === c.path) ?? parsed[0];
    return file ? { ...file, path: c.path, change: c.change } : { path: c.path, change: c.change, hunks: [], additions: c.additions ?? 0, deletions: c.deletions ?? 0 };
  });
}

/** Lines between hunks that the diff does not show ("41 unmodified lines"). */
export function gapBefore(hunks: readonly DiffHunk[], i: number): number {
  const h = hunks[i];
  if (i === 0) return Math.max(0, h.newStart - 1);
  const p = hunks[i - 1];
  return Math.max(0, h.newStart - (p.newStart + p.newLines));
}

function Gap({ count, lines, from }: { count: number; lines?: string[]; from: number }) {
  const [open, setOpen] = React.useState(false);
  if (count <= 0) return null;
  if (open && lines) {
    return (
      <>
        {lines.slice(from, from + count).map((t, i) => (
          <div key={i} className="cv2-ln">
            <span className="cv2-tnum">{from + i + 1}</span>
            <span>{t || " "}</span>
          </div>
        ))}
      </>
    );
  }
  return (
    <button type="button" className="cv2-gap" disabled={!lines} onClick={() => setOpen(true)} title={lines ? "Show them" : undefined}>
      {count} unmodified {count === 1 ? "line" : "lines"}
    </button>
  );
}

function ChangesPane({ model, focus, wide, active }: { model: WorkspaceModel; focus: DockFocus; wide: boolean; active: boolean }) {
  const mac = useIsMac();
  const turns = React.useMemo(() => groupTurns(model.items, { state: model.state }), [model.items, model.state]);
  const [scope, setScope] = React.useState<"turn" | "thread">(focus.scope ?? "turn");
  const [split, setSplit] = React.useState(false);
  const [wrap, setWrap] = React.useState(false);
  const [local, setLocal] = React.useState<Record<string, HunkDecision>>({});
  const [focused, setFocused] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [menu, setMenu] = React.useState<null | "scope" | "view">(null);
  const bar = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focus.scope) setScope(focus.scope);
  }, [focus.scope, focus.turnId]);
  const turnIndex = focus.turnId ? turns.findIndex((t) => t.id === focus.turnId) : -1;
  const turn = (turnIndex >= 0 ? turns[turnIndex] : undefined) ?? [...turns].reverse().find((t) => t.changes.length > 0);
  const changes = scope === "turn" && turn ? turn.changes : aggregateChanges(model.items);
  const files = React.useMemo(() => filesFrom(changes), [changes]);
  const decisions = { ...model.hunkDecisions, ...local };
  const counts = keptCounts(files, decisions);
  const order = hunkOrder(files);
  const root = React.useRef<HTMLDivElement>(null);
  const many = files.length > 5;

  React.useEffect(() => {
    if (!focus.target) return;
    setCollapsed((c) => ({ ...c, [focus.target!]: false }));
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(focus.target!)}"]`)?.scrollIntoView({ block: "start" }));
  }, [focus.target]);

  const decide = React.useCallback(
    (file: DiffFile, hunkId: string, d: HunkDecision | null) => {
      const before = local[hunkId];
      const set = (value: HunkDecision | undefined) =>
        setLocal((l) => {
          const n = { ...l };
          if (value) n[hunkId] = value;
          else delete n[hunkId];
          return n;
        });
      set(d ?? undefined);
      const applied = model.actions.decideHunk?.(file.path, hunkId, d, file);
      if (applied instanceof Promise) void applied.then((ok) => ok === false && set(before));
    },
    [model.actions, local],
  );

  // ] [ move between hunks, r reverts the focused one, ⌥⌘D toggles split.
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === "]" || e.key === "[") {
        e.preventDefault();
        setFocused((f) => moveHunkFocus(order, f, e.key === "]" ? 1 : -1));
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey && focused) {
        const file = files.find((f) => f.hunks.some((h) => h.id === focused));
        if (file) {
          e.preventDefault();
          decide(file, focused, decisions[focused] === "rejected" ? null : "rejected");
        }
      } else if (e.code === "KeyD" && e.altKey && (mac ? e.metaKey : e.ctrlKey) && wide) {
        e.preventDefault();
        setSplit((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, order, focused, files, decide, mac, wide, decisions]);

  const scopeLabel = scope === "thread" ? "Whole session" : turnIndex >= 0 || turn ? `Turn ${(turn?.ordinal ?? 0) + 1}` : "This turn";
  return (
    <div className="cv2-dock-pane" ref={root} tabIndex={-1}>
      <div className="cv2-dockbar" ref={bar}>
        <button type="button" className="cv2-ctl" style={{ marginLeft: -6 }} aria-haspopup="menu" aria-expanded={menu === "scope"} onClick={() => setMenu(menu === "scope" ? null : "scope")}>
          <span className="v">{scopeLabel}</span>
          <Glyph name="chevron-down" size={12} className="chev" />
        </button>
        <span className="n">
          <span className="cv2-add">+{counts.additions}</span> <span className="cv2-del">−{counts.deletions}</span>
        </span>
        <span className="cv2-grow" />
        <button type="button" className="cv2-iconbtn" aria-label="View options" aria-haspopup="menu" aria-expanded={menu === "view"} onClick={() => setMenu(menu === "view" ? null : "view")}>
          <Glyph name="more" />
        </button>
        {model.actions.commit && (
          <button type="button" className="cv2-btn" onClick={model.actions.commit} disabled={!files.length}>
            Commit…
          </button>
        )}
        <ComposerPopover open={menu === "scope"} onClose={() => setMenu(null)} width={220} align="left" offset={8} label="Scope" anchorRef={bar} down role="menu">
          <MenuList
            label="Scope"
            onClose={() => setMenu(null)}
            entries={[
              { id: "turn", label: turn ? `Turn ${turn.ordinal + 1}` : "This turn", checked: scope === "turn", onSelect: () => setScope("turn") },
              { id: "thread", label: "Whole session", checked: scope === "thread", onSelect: () => setScope("thread") },
            ]}
          />
        </ComposerPopover>
        <ComposerPopover open={menu === "view"} onClose={() => setMenu(null)} width={220} align="right" offset={8} label="View" anchorRef={bar} down role="menu">
          <MenuList
            label="View"
            onClose={() => setMenu(null)}
            entries={[
              { id: "unified", label: "Unified", checked: !split, onSelect: () => setSplit(false) },
              ...(wide ? [{ id: "split", label: "Split", checked: split, onSelect: () => setSplit(true) }] : []),
              { kind: "sep", id: "s" },
              { id: "wrap", label: "Wrap lines", checked: wrap, keepOpen: true, onSelect: () => setWrap((w) => !w) },
              { id: "expand", label: "Expand all files", onSelect: () => setCollapsed({}) },
              { id: "collapse", label: "Collapse all files", onSelect: () => setCollapsed(Object.fromEntries(files.map((f) => [f.path, true]))) },
            ]}
          />
        </ComposerPopover>
      </div>
      <div className="cv2-dockscroll">
        {files.length === 0 && <div className="cv2-dock-empty">{scope === "turn" ? "This turn changed no files." : "Nothing changed yet."}</div>}
        {files.map((f) => {
          const { name, dir } = splitPath(f.path);
          const isCollapsed = collapsed[f.path] ?? many;
          const fc = keptCounts([f], decisions);
          const content = model.fileContents?.[f.path]?.split("\n");
          return (
            <div key={f.path} data-file={f.path}>
              <button type="button" className="cv2-fileh" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !isCollapsed }))} title={f.path}>
                <Glyph name="chevron-down" size={14} className="chev" />
                <span className="nm">{name}</span>
                <span className="dir cv2-trunc">{dir.replace(/\/$/, "")}</span>
                {f.change !== "modify" && <span className="dir">{f.change === "add" ? "new" : f.change === "delete" ? "deleted" : "renamed"}</span>}
                <span className="n">
                  <span className="cv2-add">+{fc.additions}</span> <span className="cv2-del">−{fc.deletions}</span>
                </span>
              </button>
              {!isCollapsed && f.hunks.length === 0 && <div className="cv2-mute cv2-small" style={{ padding: "10px 16px 14px 34px" }}>No line diff for this file yet.</div>}
              {!isCollapsed &&
                f.hunks.map((h, hi) => {
                  const d = decisions[h.id];
                  return (
                    <React.Fragment key={h.id}>
                      {f.change !== "add" && <Gap count={gapBefore(f.hunks, hi)} lines={content} from={hi === 0 ? 0 : f.hunks[hi - 1].newStart - 1 + f.hunks[hi - 1].newLines} />}
                      <div className={cn("cv2-diff", wrap && "wrap")} data-hunk={h.id} data-focused={focused === h.id} data-decision={d} onClick={() => setFocused(h.id)}>
                        {model.actions.decideHunk && (
                          <span className="cv2-hunkbar" data-on={d === "rejected" ? "true" : undefined}>
                            {d === "rejected" ? (
                              <>
                                Reverted
                                <button type="button" className="cv2-btn ghost" onClick={(e) => (e.stopPropagation(), decide(f, h.id, null))}>
                                  Undo
                                </button>
                              </>
                            ) : (
                              <button type="button" className="cv2-btn" onClick={(e) => (e.stopPropagation(), decide(f, h.id, "rejected"))}>
                                Revert
                              </button>
                            )}
                          </span>
                        )}
                        {split && wide ? (
                          <div className="cv2-split">
                            <div>{splitRows(h).map((r, i) => (r.left ? <Line key={i} line={r.left} /> : <div key={i} className="cv2-ln">&nbsp;</div>))}</div>
                            <div>{splitRows(h).map((r, i) => (r.right ? <Line key={i} line={r.right} /> : <div key={i} className="cv2-ln">&nbsp;</div>))}</div>
                          </div>
                        ) : (
                          h.lines.map((l, i) => <Line key={i} line={l} />)
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Terminal ────────────────────────────────────────────────────────────────

function TerminalPane({ model, focus }: { model: WorkspaceModel; focus: DockFocus }) {
  const commands = model.items.filter((i): i is Extract<TurnItem, { kind: "command_execution" }> => i.kind === "command_execution");
  const sessions = React.useMemo(() => {
    const own = model.terminals ?? [];
    const agent = commands.map((c) => ({
      id: c.id,
      title: c.command,
      readOnly: true,
      output: `$ ${c.command}\n${c.output ?? ""}${c.exitCode !== undefined ? `\n[exit ${c.exitCode}${c.durationMs ? `, ${formatDuration(c.durationMs)}` : ""}]` : ""}`,
      offset: 0,
      exited: c.status !== "running",
    }));
    return [...own, ...agent];
  }, [model.terminals, commands]);
  const [active, setActive] = React.useState<string | null>(focus.target ?? null);
  React.useEffect(() => {
    if (focus.target) setActive(focus.target);
  }, [focus.target]);
  const current = sessions.find((s) => s.id === active) ?? sessions[sessions.length - 1];
  if (model.offline) return <div className="cv2-dock-empty">Offline. Terminals come back when {model.device?.name ?? "your Mac"} is back.</div>;
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockbar" style={{ gap: 2, overflowX: "auto", scrollbarWidth: "none" }} role="tablist" aria-label="Terminals">
        {sessions.map((s) => (
          <span key={s.id} className="cv2-row" style={{ gap: 0, flex: "none" }}>
            <button type="button" role="tab" aria-selected={s.id === current?.id} className="cv2-ttab" title={s.title} onClick={() => setActive(s.id)}>
              <span className="cv2-trunc">{s.readOnly ? s.title.split(" ").slice(0, 2).join(" ") : s.title}</span>
            </button>
            {!s.readOnly && model.actions.closeTerminal && (
              <button type="button" className="cv2-iconbtn" style={{ width: 20, height: 20 }} aria-label={`Close ${s.title}`} onClick={() => model.actions.closeTerminal?.(s.id)}>
                <Glyph name="close" size={12} />
              </button>
            )}
          </span>
        ))}
        <span className="cv2-grow" />
        {model.actions.openTerminal && (
          <button type="button" className="cv2-iconbtn" aria-label="New terminal" title="New terminal" onClick={() => model.actions.openTerminal?.()}>
            <Glyph name="plus" />
          </button>
        )}
      </div>
      {!current ? (
        <div className="cv2-dock-empty">No terminal yet. Commands the agent runs show here, read-only.</div>
      ) : (
        <>
          <div className="cv2-term">
            <XtermView
              terminalId={current.id}
              buffer={{ output: current.output, offset: current.offset ?? 0 }}
              readOnly={current.readOnly || !!current.exited || !model.actions.terminalInput}
              label={current.title}
              onInput={(data) => model.actions.terminalInput?.(current.id, data)}
              onResize={current.readOnly ? undefined : (cols, rows) => model.actions.terminalResize?.(current.id, cols, rows)}
            />
          </div>
          {current.readOnly && <div className="cv2-term-note">Run by the agent. Read-only.</div>}
          {!current.readOnly && current.exited && <div className="cv2-term-note">This shell has exited.</div>}
        </>
      )}
    </div>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), file: false };
  for (const p of paths) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), file: i === parts.length - 1 });
      node = node.children.get(part)!;
    });
  }
  return root;
}

function FilesPane({ model, focus, onMention }: { model: WorkspaceModel; focus: DockFocus; onMention?: (path: string) => void }) {
  const files = React.useMemo(() => model.files ?? [], [model.files]);
  const changed = React.useMemo(() => new Map(aggregateChanges(model.items).map((c) => [c.path, c])), [model.items]);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [selected, setSelected] = React.useState<string | null>(focus.target && files.includes(focus.target) ? focus.target : null);
  React.useEffect(() => {
    if (focus.target && files.some((f) => f === focus.target || f.endsWith(`/${focus.target}`))) setSelected(files.find((f) => f === focus.target || f.endsWith(`/${focus.target}`)) ?? null);
  }, [focus.target, files]);
  const tree = React.useMemo(() => buildTree(files), [files]);
  const filtered = query.trim() ? files.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase())) : null;
  const render = (node: TreeNode, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
      .map((child) => {
        const c = changed.get(child.path);
        const isOpen = open[child.path] ?? depth < 2;
        return (
          <React.Fragment key={child.path}>
            <button
              type="button"
              className="cv2-tree-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={child.file ? undefined : isOpen}
              aria-current={selected === child.path ? "true" : undefined}
              onClick={() => (child.file ? setSelected(child.path) : setOpen((o) => ({ ...o, [child.path]: !isOpen })))}
            >
              <Glyph name={child.file ? "document" : isOpen ? "folder-open" : "folder"} size={16} />
              <span className="cv2-trunc">{child.name}</span>
              {c && (
                <span className="n">
                  <span className="cv2-add">+{c.additions ?? 0}</span> <span className="cv2-del">−{c.deletions ?? 0}</span>
                </span>
              )}
            </button>
            {!child.file && isOpen && render(child, depth + 1)}
          </React.Fragment>
        );
      });
  const text = selected ? model.fileContents?.[selected] : undefined;
  const parts = selected?.split("/") ?? [];
  return (
    <div className="cv2-dock-pane">
      <div className={cn("cv2-files", "split")}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          <div className="cv2-dockbar">
            {selected ? (
              <span className="cv2-bc cv2-grow" title={selected}>
                {parts.slice(0, -1).map((p, i) => (
                  <React.Fragment key={i}>
                    <span className="cv2-trunc" style={{ flex: "0 1 auto" }}>{p}</span>
                    <Glyph name="chevron-right" size={12} />
                  </React.Fragment>
                ))}
                <span className="last cv2-trunc">{parts[parts.length - 1]}</span>
              </span>
            ) : (
              <span className="cv2-mute cv2-grow cv2-small">Choose a file</span>
            )}
            {selected && onMention && (
              <button type="button" className="cv2-btn ghost" onClick={() => onMention(selected)}>
                Mention
              </button>
            )}
          </div>
          <div className="cv2-dockscroll">
            {!selected ? (
              <div className="cv2-dock-empty">{files.length ? "Pick a file in the tree to read it." : model.offline ? `Offline. Files come back when ${model.device?.name ?? "your Mac"} is back.` : "No file list for this workspace yet."}</div>
            ) : text === undefined ? (
              <div className="cv2-dock-empty">The file opens when your Mac sends it.</div>
            ) : (
              <div className="cv2-viewer">
                {text.split("\n").map((l, i) => (
                  <div key={i} className="cv2-ln">
                    <span className="cv2-tnum">{i + 1}</span>
                    <span>{l || " "}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="tree">
          <label className="cv2-pop-search" style={{ height: 40 }}>
            <Glyph name="search" size={16} />
            <input placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files" />
          </label>
          <div className="cv2-dockscroll" style={{ padding: "6px 6px 12px" }}>
            {filtered
              ? filtered.slice(0, 200).map((p) => (
                  <button key={p} type="button" className="cv2-tree-row" style={{ paddingLeft: 8 }} aria-current={selected === p ? "true" : undefined} onClick={() => setSelected(p)} title={p}>
                    <Glyph name="document" size={16} />
                    <span className="cv2-trunc">{p.split("/").pop()}</span>
                  </button>
                ))
              : render(tree, 0)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────

function PreviewPane({ model }: { model: WorkspaceModel }) {
  const [url, setUrl] = React.useState(model.previewUrl ?? "http://localhost:3000");
  const [shown, setShown] = React.useState(model.previewUrl ?? "");
  const [narrow, setNarrow] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  if (model.offline) return <div className="cv2-dock-empty">Offline. The preview comes back when {model.device?.name ?? "your Mac"} is back.</div>;
  return (
    <div className="cv2-dock-pane">
      <form
        className="cv2-dockbar"
        onSubmit={(e) => {
          e.preventDefault();
          setShown(url);
          setNonce((n) => n + 1);
        }}
      >
        <input className="cv2-preview-url" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Preview address" spellCheck={false} />
        <button type="button" className="cv2-iconbtn" aria-label="Reload" onClick={() => (setShown(url), setNonce((n) => n + 1))}>
          <Glyph name="refresh" size={16} />
        </button>
        <button type="button" className="cv2-iconbtn" aria-pressed={narrow} aria-label="Phone width" title="Phone width" onClick={() => setNarrow((n) => !n)}>
          <Glyph name="phone" size={16} />
        </button>
      </form>
      <div className="cv2-preview-frame">
        {shown ? <iframe key={nonce} title="Preview" src={shown} style={narrow ? { maxWidth: 390 } : undefined} sandbox="allow-scripts allow-forms" /> : <div className="cv2-dock-empty">Start the dev server, then open its address here.</div>}
      </div>
    </div>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────

function AgentDetail({ agent, model, onBack }: { agent: SubagentItem; model: WorkspaceModel; onBack: () => void }) {
  const instance = model.instances.find((i) => i.id === agent.model.instanceId);
  const words = model.items.filter((i): i is Extract<TurnItem, { kind: "assistant_message" }> => i.kind === "assistant_message" && i.agentId === agent.agentId);
  const [msg, setMsg] = React.useState("");
  const live = agent.status === "running" || agent.status === "waiting";
  const step = agentStep(agent);
  const name = agent.label ?? "Agent";
  return (
    <div className="cv2-dock-pane" key={agent.agentId}>
      <div className="cv2-dockbar">
        <button type="button" className="cv2-iconbtn" aria-label="All agents" onClick={onBack} style={{ marginLeft: -6 }}>
          <Glyph name="chevron-left" />
        </button>
        <span className="cv2-m">{name}</span>
        <span className="cv2-mute cv2-small cv2-trunc cv2-grow">
          {modelLabelFor(agent.model.model, model.instances, agent.model.instanceId)}
          {instance && instance.kind !== "alevr" ? ` · ${displayName(instance)}` : ""}
        </span>
        {live && model.actions.stopAgent && (
          <button type="button" className="cv2-link" onClick={() => model.actions.stopAgent?.(agent.agentId)}>
            Stop
          </button>
        )}
      </div>
      <div className="cv2-dockscroll" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        {agent.task && (
          <div>
            <div className="cv2-mute cv2-small">Task from the lead</div>
            <div className="cv2-prose" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
              {agent.task}
            </div>
          </div>
        )}
        <div className="cv2-log">
          <div className={cn("cv2-wl", step.needs && "needs")}>
            <span className={cn("verb", agent.status === "running" && "cv2-shine")}>{agent.status === "running" ? "Now" : agent.status === "waiting" ? "Needs you" : "Last"}</span>
            <span className="obj">{step.text}</span>
            {agent.elapsedMs !== undefined && <span className="t">{formatDuration(agent.elapsedMs)}</span>}
          </div>
          {agent.candidate?.additions !== undefined && (
            <div className="cv2-wl">
              <span className="verb">Changed</span>
              <span className="n">
                <span className="cv2-add">+{agent.candidate.additions}</span> <span className="cv2-del">−{agent.candidate.deletions ?? 0}</span>
              </span>
            </div>
          )}
          {agent.worktreeBranch && (
            <div className="cv2-wl">
              <span className="verb">Branch</span>
              <span className="obj">{agent.worktreeBranch}</span>
            </div>
          )}
        </div>
        {words.map((w) => (
          <div key={w.id} className="cv2-prose" style={{ whiteSpace: "pre-wrap" }}>
            {w.text}
          </div>
        ))}
        {agent.tokens && (
          <div className="cv2-mute cv2-small cv2-tnum">
            {Math.round(agent.tokens.input / 1000)}K in, {Math.round(agent.tokens.output / 1000)}K out
            {agent.costUsd !== undefined ? `, $${agent.costUsd.toFixed(2)}` : ""}
          </div>
        )}
      </div>
      {live && model.actions.messageAgent && (
        <form
          className="cv2-mini"
          onSubmit={(e) => {
            e.preventDefault();
            if (!msg.trim()) return;
            model.actions.messageAgent?.(agent.agentId, msg.trim());
            setMsg("");
          }}
        >
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Message ${name}`} aria-label={`Message ${name}`} />
          <button type="submit" className="cv2-send" aria-label="Send" disabled={!msg.trim()}>
            <span className="glyph">
              <Glyph name="arrow-up" size={16} />
            </span>
          </button>
        </form>
      )}
    </div>
  );
}

function AgentsPane({ model, selectedId, onSelect }: { model: WorkspaceModel; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const agents = latestAgents(model.items);
  const selected = agents.find((a) => a.agentId === selectedId);
  const [pick, setPick] = React.useState<string | null>(null);
  const best = model.routing.preset === "best-of-n" || agents.some(isCandidate);
  if (selected && !best) return <AgentDetail agent={selected} model={model} onBack={() => onSelect(null)} />;
  if (!agents.length) return <div className="cv2-dock-empty">No agents in this session. Choose Team or Best of N under the composer&apos;s options to fan out.</div>;
  const elapsed = Math.max(0, ...agents.map((a) => a.elapsedMs ?? 0));
  const costs = agents.map((a) => a.costUsd).filter((c): c is number => c !== undefined);
  const spent = costs.length ? costs.reduce((a, b) => a + b, 0) : undefined;
  const money = budgetLine(spent, model.routing.budget?.maxUsd);

  if (best) {
    const kept = agents.find((a) => a.candidate?.kept);
    const chosen = agents.find((a) => a.agentId === (pick ?? selectedId)) ?? kept ?? agents[0];
    return (
      <div className="cv2-dock-pane">
        <div className="cv2-dockbar">
          <span className="cv2-m">{teamHead(agents)}</span>
          <span className="cv2-grow" />
          <span className="cv2-mute cv2-small cv2-tnum">{money ?? (elapsed ? formatDuration(elapsed) : "")}</span>
        </div>
        <div className="cv2-dockscroll" style={{ paddingTop: 6 }} role="radiogroup" aria-label="Candidates">
          {agents.map((a, i) => {
            const c = a.candidate ?? {};
            const letter = String.fromCharCode(65 + i);
            return (
              <button key={a.id} type="button" role="radio" aria-checked={chosen?.agentId === a.agentId} aria-pressed={chosen?.agentId === a.agentId} className="cv2-arow" onClick={() => setPick(a.agentId)}>
                <span style={{ minWidth: 0 }}>
                  <span className="l1">
                    <span className="cv2-m" style={{ width: 14 }}>{letter}</span>
                    <ModelMark modelId={a.model.model} instance={model.instances.find((x) => x.id === a.model.instanceId)} />
                    <span className="cv2-trunc">{modelLabelFor(a.model.model, model.instances, a.model.instanceId)}</span>
                    {a.status === "running" && <Spinner size={12} />}
                  </span>
                  <span className="l2" style={{ display: "block", paddingLeft: 22 }}>
                    {c.testsLine ? `${c.testsLine}. ` : ""}
                    {a.closingText ?? a.liveLine ?? ""}
                  </span>
                </span>
                <span className="t">
                  {a.elapsedMs !== undefined ? formatDuration(a.elapsedMs) : ""}
                  {c.additions !== undefined && (
                    <>
                      {"  "}
                      <span className="cv2-add">+{c.additions}</span> <span className="cv2-del">−{c.deletions ?? 0}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="cv2-mini" style={{ justifyContent: "flex-end" }}>
          {kept ? (
            <span className="cv2-mute">Kept {String.fromCharCode(65 + agents.indexOf(kept))}. The other worktrees were removed.</span>
          ) : (
            <>
              <span className="cv2-mute cv2-small cv2-grow">The others&apos; worktrees are removed.</span>
              <button type="button" className="cv2-btn ink" disabled={!chosen || chosen.status === "running"} onClick={() => chosen && model.actions.keepCandidate?.(chosen.agentId)}>
                Keep {String.fromCharCode(65 + Math.max(0, agents.indexOf(chosen!)))}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockbar">
        <span className="cv2-m">{teamHead(agents)}</span>
        <span className="cv2-grow" />
        <span className="cv2-mute cv2-small cv2-tnum">{money ?? (elapsed ? formatDuration(elapsed) : "")}</span>
      </div>
      <div className="cv2-dockscroll" style={{ paddingTop: 6 }}>
        {agents.map((a) => {
          const step = agentStep(a);
          const instance = model.instances.find((x) => x.id === a.model.instanceId);
          return (
            <button key={a.id} type="button" className="cv2-arow" aria-pressed={selectedId === a.agentId} onClick={() => onSelect(a.agentId)}>
              <span style={{ minWidth: 0 }}>
                <span className="l1">
                  <span>{a.label ?? "Agent"}</span>
                  <ModelMark modelId={a.model.model} instance={instance} />
                  <span className="mdl cv2-trunc">{modelLabelFor(a.model.model, model.instances, a.model.instanceId)}</span>
                </span>
                <span className={cn("l2", step.needs && "cv2-sig", a.status === "running" && "cv2-shine")} style={{ display: "block" }}>
                  {step.text}
                </span>
              </span>
              <span className="t">{a.elapsedMs !== undefined ? formatDuration(a.elapsedMs) : ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Newest state per agent (a subagent may be re-sent as updates). */
export function latestAgents(items: readonly TurnItem[]): SubagentItem[] {
  const by = new Map<string, SubagentItem>();
  for (const i of items) if (i.kind === "subagent") by.set(i.agentId, i);
  return [...by.values()];
}

// ── Screen ──────────────────────────────────────────────────────────────────

function ScreenPane({ model, resolveScreenshot }: { model: WorkspaceModel; resolveScreenshot?: (ref: string) => string | null }) {
  const steps = model.items.filter((i) => i.kind === "computer_action");
  const running = steps.some((s) => s.kind === "computer_action" && (s.status === "running" || s.status === "pending"));
  if (!steps.length) return <div className="cv2-dock-empty">Nothing on screen. When an agent uses the computer, each step shows here.</div>;
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockbar">
        <span className="cv2-grow cv2-mute">{running ? "Using the computer" : "Finished using the computer"}</span>
        {running && (
          <button type="button" className="cv2-btn" title="Stop (Esc)" onClick={() => model.actions.stop()}>
            Stop
          </button>
        )}
      </div>
      <div className="cv2-dockscroll cv2-screen">
        <ComputerTimeline items={steps} resolveScreenshot={resolveScreenshot} />
      </div>
    </div>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

export function visibleTabs(model: WorkspaceModel): DockTab[] {
  const tabs: DockTab[] = ["changes", "terminal", "files"];
  if (model.previewUrl) tabs.push("preview");
  if (model.items.some((i) => i.kind === "subagent")) tabs.push("agents");
  if (model.items.some((i) => i.kind === "computer_action")) tabs.push("screen");
  return tabs;
}

export function Dock({
  model,
  dock,
  dispatch,
  focus,
  selectedAgentId,
  onSelectAgent,
  onMention,
  resolveScreenshot,
  composer,
}: {
  model: WorkspaceModel;
  dock: DockState;
  dispatch: (a: DockAction) => void;
  focus: DockFocus;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  onMention?: (path: string) => void;
  resolveScreenshot?: (ref: string) => string | null;
  /** The composer, re-parented into the panel while expanded. */
  composer?: React.ReactNode;
}) {
  const tabs = visibleTabs(model);
  const tab = tabs.includes(dock.tab) ? dock.tab : dock.tab === "preview" ? "preview" : tabs[0];
  const shownTabs = tabs.includes(tab) ? tabs : [...tabs, tab];
  const handle = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [width, setWidth] = React.useState<number | null>(dock.width && dock.width !== 460 ? dock.width : null);
  const frame = React.useRef(0);
  const counts: Partial<Record<DockTab, number>> = {
    changes: aggregateChanges(model.items).length || undefined,
    agents: latestAgents(model.items).length || undefined,
  };
  const bodyRight = () => (handle.current?.closest(".cv2-main") as HTMLElement | null)?.getBoundingClientRect().right ?? window.innerWidth;
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const w = bodyRight() - e.clientX;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setWidth(Math.max(420, w)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    const w = Math.max(420, bodyRight() - e.clientX);
    setWidth(w);
    dispatch({ type: "release", width: Math.min(w, 760) });
  };

  return (
    <aside className="cv2-dock" style={width ? { ["--dock-w" as string]: `${width}px` } : undefined} aria-label="Panel">
      <div
        ref={handle}
        className="cv2-dock-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
        aria-valuemin={420}
        aria-valuenow={width ?? undefined}
        tabIndex={0}
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => (setWidth(null), dispatch({ type: "reset-width" }))}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const next = nudgeDockWidth(width ?? dock.width, e.key === "ArrowLeft" ? 1 : -1, e.shiftKey);
            setWidth(next);
            dispatch({ type: "release", width: next });
          }
        }}
      />
      <div className="cv2-tabs" role="tablist" aria-label="Panel tabs">
        {shownTabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="cv2-tab" onClick={() => dispatch({ type: "open", tab: t, threadId: model.thread.id })}>
            {DOCK_TAB_LABELS[t]}
            {counts[t] ? <span className="n">{counts[t]}</span> : null}
          </button>
        ))}
        <span className="cv2-grow" />
        <button type="button" className="cv2-iconbtn cv2-wide" aria-label={dock.expanded ? "Restore the panel" : "Expand the panel"} title={dock.expanded ? "Restore (⌘⇧D)" : "Expand (⌘⇧D)"} aria-pressed={dock.expanded} onClick={() => dispatch({ type: "toggle-expand" })}>
          <Glyph name={dock.expanded ? "collapse" : "expand"} size={16} />
        </button>
        <button type="button" className="cv2-iconbtn" aria-label="Close the panel" title="Close" onClick={() => dispatch({ type: "close" })}>
          <Glyph name="close" size={16} />
        </button>
      </div>
      <div key={tab} className="cv2-dock-pane" role="tabpanel" aria-label={DOCK_TAB_LABELS[tab]} style={{ borderTop: "1px solid hsl(var(--border))" }}>
        {tab === "changes" && <ChangesPane model={model} focus={focus} wide={(width ?? 700) >= 640 || dock.expanded} active />}
        {tab === "terminal" && <TerminalPane model={model} focus={focus} />}
        {tab === "files" && <FilesPane model={model} focus={focus} onMention={onMention} />}
        {tab === "preview" && <PreviewPane model={model} />}
        {tab === "agents" && <AgentsPane model={model} selectedId={selectedAgentId} onSelect={onSelectAgent} />}
        {tab === "screen" && <ScreenPane model={model} resolveScreenshot={resolveScreenshot} />}
        {tab === "plan" && <div className="cv2-dock-empty">The plan is in the thread.</div>}
      </div>
      {dock.expanded && composer && <div className="cv2-cwrap" style={{ paddingTop: 8 }}>{composer}</div>}
    </aside>
  );
}

export type { ProviderInstance };
