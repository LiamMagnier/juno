"use client";

/**
 * The right dock (DESIGN §4.1, §5.16; INTERACTION I-10, I-11): one workbench
 * with tabs for Changes, Terminal, Files, Preview, Plan, Agents and Screen.
 * Resizable by its leading edge (pointer-captured, rAF-batched, snaps to
 * 360 / 460 / 760 on release, double-click resets), expandable over the
 * thread (⌘⇧D), a sheet from the right below 1024 px.
 */
import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ComputerTimeline } from "@/components/code/computer-timeline";
import type { FileChangeEntry, PlanItem, ProviderInstance, SubagentItem, TodoListItem, TurnItem } from "@/lib/code-v2/contracts";
import {
  DOCK_TAB_GLYPHS,
  DOCK_TAB_LABELS,
  type DockState,
  type DockAction,
  type DockTab,
  effectiveDockWidth,
  nudgeDockWidth,
} from "@/lib/code-v2/dock";
import {
  hunkOrder,
  keptCounts,
  moveHunkFocus,
  parseUnifiedDiff,
  splitPath,
  splitRows,
  type DiffFile,
  type DiffLine,
  type HunkDecision,
} from "@/lib/code-v2/diff";
import { aggregateChanges, groupTurns, formatDuration } from "@/lib/code-v2/turns";
import { displayName } from "@/lib/code-v2/providers-view";
import { AgentTree, BestOfN, modelLabelFor } from "./agent-tree";
import { Glyph, Kbd, ModelMark, Spinner, useIsMac } from "./primitives";
import type { WorkspaceModel } from "./types";
import { cn } from "@/lib/utils";

export interface DockFocus {
  /** Changes: path. Agents: agent id. Terminal: command item id. Screen: item id. */
  target?: string;
  scope?: "turn" | "thread";
  turnId?: string;
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
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div className={cn("cv2-ln", line.kind === "add" && "a", line.kind === "del" && "d")}>
      <span className="cv2-tnum">{line.kind === "del" ? line.oldNo : line.newNo}</span>
      <span>{sign}</span>
      <span>{highlight(line)}</span>
    </div>
  );
}

export function filesFrom(changes: readonly FileChangeEntry[]): DiffFile[] {
  return changes.map((c) => {
    const parsed = c.diff ? parseUnifiedDiff(c.diff, c.path) : [];
    const file = parsed.find((f) => f.path === c.path) ?? parsed[0];
    return file
      ? { ...file, path: c.path, change: c.change }
      : { path: c.path, change: c.change, hunks: [], additions: c.additions ?? 0, deletions: c.deletions ?? 0 };
  });
}

function ChangesPane({
  model,
  focus,
  wide,
  active,
}: {
  model: WorkspaceModel;
  focus: DockFocus;
  wide: boolean;
  active: boolean;
}) {
  const mac = useIsMac();
  const turns = React.useMemo(() => groupTurns(model.items, { state: model.state }), [model.items, model.state]);
  const [scope, setScope] = React.useState<"turn" | "thread">(focus.scope ?? "turn");
  const [split, setSplit] = React.useState(false);
  const [local, setLocal] = React.useState<Record<string, HunkDecision>>({});
  const [focused, setFocused] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [undo, setUndo] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (focus.scope) setScope(focus.scope);
  }, [focus.scope, focus.turnId]);
  const turn = (focus.turnId ? turns.find((t) => t.id === focus.turnId) : undefined) ?? [...turns].reverse().find((t) => t.changes.length > 0);
  const changes = scope === "turn" && turn ? turn.changes : aggregateChanges(model.items);
  const files = React.useMemo(() => filesFrom(changes), [changes]);
  const decisions = { ...model.hunkDecisions, ...local };
  const counts = keptCounts(files, decisions);
  const order = hunkOrder(files);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!focus.target) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(focus.target)}"]`);
    el?.scrollIntoView({ block: "start" });
  }, [focus.target]);
  React.useEffect(() => {
    if (!focused) return;
    root.current?.querySelector<HTMLElement>(`[data-hunk="${CSS.escape(focused)}"]`)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focused]);

  const decide = React.useCallback(
    (file: DiffFile, hunkId: string, d: HunkDecision | null) => {
      setLocal((l) => {
        const n = { ...l };
        if (d) n[hunkId] = d;
        else delete n[hunkId];
        return n;
      });
      model.actions.decideHunk?.(file.path, hunkId, d);
      if (d === "rejected") {
        setUndo(hunkId);
        setTimeout(() => setUndo((u) => (u === hunkId ? null : u)), 6000);
      }
    },
    [model.actions],
  );

  // ] [ A R and ⌥⌘D while Changes has focus (DESIGN §8).
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === "]" || e.key === "[") {
        e.preventDefault();
        setFocused((f) => moveHunkFocus(order, f, e.key === "]" ? 1 : -1));
      } else if ((e.key === "a" || e.key === "r") && !e.metaKey && !e.ctrlKey && focused) {
        const file = files.find((f) => f.hunks.some((h) => h.id === focused));
        if (file) {
          e.preventDefault();
          decide(file, focused, e.key === "a" ? "accepted" : "rejected");
          setFocused((f) => moveHunkFocus(order, f, 1));
        }
      } else if (e.code === "KeyD" && e.altKey && (mac ? e.metaKey : e.ctrlKey) && wide) {
        e.preventDefault();
        setSplit((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, order, focused, files, decide, mac, wide]);

  return (
    <div className="cv2-dock-pane" ref={root} tabIndex={-1}>
      <div className="cv2-dockbar">
        <div className="cv2-seg" role="radiogroup" aria-label="Scope">
          {(["turn", "thread"] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
              {scope === s && <motion.span layoutId="changes-scope" className="cv2-seg-fill" transition={{ type: "spring", stiffness: 420, damping: 40 }} />}
              <span style={{ position: "relative" }}>{s === "turn" ? "This turn" : "Whole thread"}</span>
            </button>
          ))}
        </div>
        <span className="cv2-grow" />
        {wide && (
          <button type="button" className="cv2-iconbtn" aria-pressed={split} aria-label="Split view" title="Split view" onClick={() => setSplit((s) => !s)}>
            <Glyph name="columns" />
          </button>
        )}
        <span className="cv2-tnum">
          <span className="cv2-add">+{counts.additions}</span> <span className="cv2-del">−{counts.deletions}</span>
        </span>
        {model.actions.commit && (
          <button type="button" className="cv2-btn ink" onClick={model.actions.commit} disabled={!files.length}>
            Commit…
          </button>
        )}
      </div>
      <div className="cv2-dockscroll">
        {files.length === 0 && <div className="cv2-dock-empty">{scope === "turn" ? "This turn changed no files." : "Nothing changed yet."}</div>}
        {files.map((f) => {
          const { name, dir } = splitPath(f.path);
          const isCollapsed = collapsed[f.path] ?? false;
          const fc = keptCounts([f], decisions);
          return (
            <div key={f.path} data-file={f.path}>
              <button type="button" className="cv2-fileh" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !isCollapsed }))}>
                <Glyph name="chevron-down" size={14} className="chev" />
                <span className="cv2-mono" style={{ color: "hsl(var(--foreground))" }}>
                  {name}
                </span>
                <span className="cv2-mono cv2-mute cv2-trunc cv2-grow">{dir}</span>
                {f.change !== "modify" && <span className="cv2-mute">{f.change === "add" ? "new" : f.change === "delete" ? "deleted" : "renamed"}</span>}
                <span className="cv2-tnum">
                  <span className="cv2-add">+{fc.additions}</span> <span className="cv2-del">−{fc.deletions}</span>
                </span>
              </button>
              {!isCollapsed && f.hunks.length === 0 && <div className="cv2-mute" style={{ padding: "0 14px 10px 36px" }}>No line diff for this file yet.</div>}
              {!isCollapsed &&
                f.hunks.map((h) => {
                  const d = decisions[h.id];
                  return (
                    <div key={h.id} className="cv2-diff" data-hunk={h.id} data-focused={focused === h.id} data-decision={d} onClick={() => setFocused(h.id)}>
                      <div className="cv2-hunk">
                        <span className="cv2-mono cv2-trunc cv2-grow">
                          {h.header}
                          {h.section ? ` ${h.section}` : ""}
                        </span>
                        {d ? (
                          <span className="decided cv2-row" style={{ gap: 6 }}>
                            {d === "accepted" ? "Accepted" : "Rejected"}
                            {(undo === h.id || d === "accepted") && (
                              <button type="button" className="cv2-btn sm ghost" onClick={(e) => (e.stopPropagation(), decide(f, h.id, null))}>
                                Undo
                              </button>
                            )}
                          </span>
                        ) : (
                          <>
                            <button type="button" className="cv2-btn sm ghost" onClick={(e) => (e.stopPropagation(), decide(f, h.id, "rejected"))}>
                              Reject
                            </button>
                            <button type="button" className="cv2-btn sm" onClick={(e) => (e.stopPropagation(), decide(f, h.id, "accepted"))}>
                              Accept
                            </button>
                          </>
                        )}
                      </div>
                      {split && wide ? (
                        <div className="cv2-split">
                          <div>
                            {splitRows(h).map((r, i) => (r.left ? <Line key={i} line={r.left} /> : <div key={i} className="cv2-ln">&nbsp;</div>))}
                          </div>
                          <div>
                            {splitRows(h).map((r, i) => (r.right ? <Line key={i} line={r.right} /> : <div key={i} className="cv2-ln">&nbsp;</div>))}
                          </div>
                        </div>
                      ) : (
                        (d === "rejected" ? h.lines.filter((l) => l.kind !== "add").map((l) => ({ ...l, kind: "context" as const })) : h.lines).map((l, i) => <Line key={i} line={l} />)
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
        {order.length > 1 && (
          <div className="cv2-mute cv2-wide cv2-row" style={{ gap: 6, padding: "4px 14px 16px", fontSize: 12 }}>
            <Kbd k="]" /> <Kbd k="[" /> move between hunks, <Kbd k="a" /> accept, <Kbd k="r" /> reject
          </div>
        )}
      </div>
    </div>
  );
}

// ── Terminal (stream view; xterm.js is not installed in this build) ─────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function TerminalPane({ model, focus }: { model: WorkspaceModel; focus: DockFocus }) {
  const commands = model.items.filter((i): i is Extract<TurnItem, { kind: "command_execution" }> => i.kind === "command_execution");
  const sessions = React.useMemo(() => {
    const own = model.terminals ?? [];
    const agent = commands.map((c) => ({
      id: c.id,
      title: c.command,
      readOnly: true,
      output: `$ ${c.command}\n${c.output ?? ""}${c.exitCode !== undefined ? `\n[exit ${c.exitCode}${c.durationMs ? ` · ${formatDuration(c.durationMs)}` : ""}]` : ""}`,
      exited: c.status !== "running",
    }));
    return [...own, ...agent];
  }, [model.terminals, commands]);
  const [active, setActive] = React.useState<string | null>(focus.target ?? null);
  React.useEffect(() => {
    if (focus.target) setActive(focus.target);
  }, [focus.target]);
  const current = sessions.find((s) => s.id === active) ?? sessions[0];
  const [input, setInput] = React.useState("");
  const scroll = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [current?.output]);
  if (model.offline) return <div className="cv2-dock-empty">Offline. Terminals come back when {model.device?.name ?? "your Mac"} is back.</div>;
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockbar" style={{ gap: 4, overflowX: "auto" }}>
        {sessions.map((s) => (
          <button key={s.id} type="button" className={cn("cv2-btn sm", s.id === current?.id ? "" : "ghost")} title={s.title} onClick={() => setActive(s.id)} style={{ maxWidth: 200 }}>
            <Glyph name={s.readOnly ? "terminal" : "keyboard"} size={14} />
            <span className="cv2-trunc cv2-mono">{s.title}</span>
          </button>
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
          <div className="cv2-dockscroll" ref={scroll} role="log" aria-label={current.title}>
            <div className="cv2-term">{current.output.replace(ANSI, "")}</div>
          </div>
          {!current.readOnly && !current.exited && (
            <form
              className="cv2-term-input"
              onSubmit={(e) => {
                e.preventDefault();
                model.actions.terminalInput?.(current.id, `${input}\n`);
                setInput("");
              }}
            >
              <span className="cv2-mute">$</span>
              <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="Terminal input" spellCheck={false} />
            </form>
          )}
          {current.readOnly && <div className="cv2-term-input cv2-mute">Run by the agent. Read-only.</div>}
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

function FilesPane({ model, onMention }: { model: WorkspaceModel; onMention?: (path: string) => void }) {
  const files = React.useMemo(() => model.files ?? [], [model.files]);
  const changed = React.useMemo(() => new Map(aggregateChanges(model.items).map((c) => [c.path, c])), [model.items]);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [selected, setSelected] = React.useState<string | null>(null);
  const tree = React.useMemo(() => buildTree(files), [files]);
  const filtered = query.trim() ? files.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase())) : null;
  const render = (node: TreeNode, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
      .map((child) => {
        const c = changed.get(child.path);
        const isOpen = open[child.path] ?? depth < 1;
        return (
          <React.Fragment key={child.path}>
            <button
              type="button"
              className="cv2-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              aria-expanded={child.file ? undefined : isOpen}
              aria-current={selected === child.path ? "true" : undefined}
              onClick={() => (child.file ? setSelected(child.path) : setOpen((o) => ({ ...o, [child.path]: !isOpen })))}
            >
              <Glyph name={child.file ? "file-code" : isOpen ? "folder-open" : "folder"} />
              <span className={cn("cv2-trunc cv2-grow", child.file && "cv2-mono")}>{child.name}</span>
              {c && (
                <span className="cv2-tnum" style={{ fontSize: 12 }}>
                  <span className="cv2-add">+{c.additions ?? 0}</span> <span className="cv2-del">−{c.deletions ?? 0}</span>
                </span>
              )}
            </button>
            {!child.file && isOpen && render(child, depth + 1)}
          </React.Fragment>
        );
      });
  if (selected) {
    const text = model.fileContents?.[selected];
    return (
      <div className="cv2-dock-pane">
        <div className="cv2-dockbar">
          <button type="button" className="cv2-iconbtn" aria-label="Back to files" onClick={() => setSelected(null)}>
            <Glyph name="chevron-left" />
          </button>
          <span className="cv2-mono cv2-trunc cv2-grow">{selected}</span>
          {onMention && (
            <button type="button" className="cv2-btn" onClick={() => onMention(selected)}>
              Mention in composer
            </button>
          )}
        </div>
        <div className="cv2-dockscroll">
          {text === undefined ? (
            <div className="cv2-dock-empty">The file opens when your Mac sends it.</div>
          ) : (
            <div className="cv2-viewer">
              {text.split("\n").map((l, i) => (
                <div key={i} className="cv2-ln">
                  <span className="cv2-tnum">{i + 1}</span>
                  <span />
                  <span>{l || " "}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="cv2-dock-pane">
      <label className="cv2-pop-search" style={{ height: 44 }}>
        <Glyph name="search" />
        <input placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files" />
      </label>
      <div className="cv2-dockscroll" style={{ padding: "6px 6px 12px" }}>
        {files.length === 0 && <div className="cv2-dock-empty">{model.offline ? `Offline. Files come back when ${model.device?.name ?? "your Mac"} is back.` : "No file list for this workspace yet."}</div>}
        {filtered
          ? filtered.slice(0, 200).map((p) => (
              <button key={p} type="button" className="cv2-tree-row" style={{ paddingLeft: 12 }} onClick={() => setSelected(p)}>
                <Glyph name="file-code" />
                <span className="cv2-mono cv2-trunc">{p}</span>
              </button>
            ))
          : render(tree, 0)}
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
          <Glyph name="refresh" />
        </button>
        <div className="cv2-seg" role="radiogroup" aria-label="Width">
          {[false, true].map((n) => (
            <button key={String(n)} type="button" role="radio" aria-checked={narrow === n} onClick={() => setNarrow(n)}>
              {narrow === n && <span className="cv2-seg-fill" />}
              <span style={{ position: "relative" }}>{n ? "390" : "Desktop"}</span>
            </button>
          ))}
        </div>
      </form>
      <div className="cv2-preview-frame">
        {shown ? (
          <iframe key={nonce} title="Preview" src={shown} style={narrow ? { maxWidth: 390 } : undefined} sandbox="allow-scripts allow-forms allow-same-origin" />
        ) : (
          <div className="cv2-dock-empty">Start the dev server, then open its address here.</div>
        )}
      </div>
    </div>
  );
}

// ── Plan ────────────────────────────────────────────────────────────────────

function PlanPane({ model }: { model: WorkspaceModel }) {
  const plan = [...model.items].reverse().find((i): i is PlanItem => i.kind === "plan");
  const todo = [...model.items].reverse().find((i): i is TodoListItem => i.kind === "todo_list");
  if (!plan && !todo) return <div className="cv2-dock-empty">No plan yet. Turn on Plan first in the permissions menu to get one before any change.</div>;
  const steps = todo?.todos ?? plan?.steps ?? [];
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockscroll" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {plan?.text && <div className="cv2-prose" style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: "21px" }}>{plan.text}</div>}
        {steps.map((s, i) => (
          <div key={i} className={cn("cv2-plan-step", s.status === "completed" && "done")}>
            {s.status === "completed" ? <Glyph name="check" /> : s.status === "in_progress" ? <Spinner /> : <Glyph name="circle-dashed" />}
            <span>{s.text}</span>
          </div>
        ))}
        {plan?.awaitingApproval && model.actions.approvePlan && (
          <div className="cv2-row" style={{ gap: 8 }}>
            <button type="button" className="cv2-btn ghost" onClick={() => model.actions.approvePlan?.(plan.id, false)}>
              Revise
            </button>
            <button type="button" className="cv2-btn ink" onClick={() => model.actions.approvePlan?.(plan.id, true)}>
              Approve and build
            </button>
          </div>
        )}
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
  return (
    <div className="cv2-dock-pane" style={{ ["--cv2-pane-shift" as string]: "8px" }} key={agent.agentId}>
      <div className="cv2-dockbar">
        <button type="button" className="cv2-iconbtn" aria-label="All agents" onClick={onBack}>
          <Glyph name="chevron-left" />
        </button>
        <ModelMark modelId={agent.model.model} instance={instance} />
        <span className="cv2-m">{agent.label ?? "Agent"}</span>
        <span className="cv2-mute cv2-trunc cv2-grow">
          {modelLabelFor(agent.model.model, model.instances, agent.model.instanceId)}
          {instance ? ` · ${displayName(instance)}` : ""}
        </span>
        {live && model.actions.stopAgent && (
          <button type="button" className="cv2-btn ghost" onClick={() => model.actions.stopAgent?.(agent.agentId)}>
            Stop
          </button>
        )}
      </div>
      <div className="cv2-dockscroll" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {agent.task && (
          <div>
            <div className="cv2-mute" style={{ fontSize: 12 }}>
              Task from the lead
            </div>
            <div style={{ fontSize: 13.5, lineHeight: "21px", marginTop: 4, whiteSpace: "pre-wrap" }}>{agent.task}</div>
          </div>
        )}
        {agent.status === "waiting" && (
          <div>
            <span className="cv2-sig">Waiting for you:</span> <span className="cv2-mute">{agent.liveLine ?? "needs an answer"}</span>
          </div>
        )}
        {agent.status === "running" && agent.liveLine && (
          <div className="cv2-step">
            <Spinner />
            <span className="verb cv2-shimmer">{agent.liveLine}</span>
            {agent.elapsedMs !== undefined && <span className="t">{formatDuration(agent.elapsedMs)}</span>}
          </div>
        )}
        {words.map((w) => (
          <div key={w.id} className="cv2-prose" style={{ fontSize: 13.5, lineHeight: "21px", whiteSpace: "pre-wrap" }}>
            {w.text}
          </div>
        ))}
        {agent.closingText && <div style={{ whiteSpace: "pre-wrap" }}>{agent.closingText}</div>}
        {agent.worktreeBranch && <div className="cv2-mono cv2-mute">{agent.worktreeBranch}</div>}
        {agent.tokens && (
          <div className="cv2-mute cv2-tnum" style={{ fontSize: 12 }}>
            {Math.round(agent.tokens.input / 1000)}K in · {Math.round(agent.tokens.output / 1000)}K out
            {agent.costUsd !== undefined ? ` · $${agent.costUsd.toFixed(2)}` : ""}
          </div>
        )}
      </div>
      {live && model.actions.messageAgent && (
        <form
          className="cv2-term-input"
          style={{ fontFamily: "inherit", fontSize: 13, padding: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!msg.trim()) return;
            model.actions.messageAgent?.(agent.agentId, msg.trim());
            setMsg("");
          }}
        >
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder={`Message ${agent.label ?? "the agent"}`}
            aria-label={`Message ${agent.label ?? "the agent"}`}
            style={{ height: 34, padding: "0 12px", borderRadius: 17, boxShadow: "inset 0 0 0 1px hsl(var(--border))" }}
          />
          <button type="submit" className="cv2-send" style={{ width: 28, height: 28 }} aria-label="Send" disabled={!msg.trim()}>
            <span className="glyph">
              <Glyph name="arrow-up" size={14} />
            </span>
          </button>
        </form>
      )}
    </div>
  );
}

function AgentsPane({
  model,
  selectedId,
  onSelect,
}: {
  model: WorkspaceModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const agents = latestAgents(model.items);
  const selected = agents.find((a) => a.agentId === selectedId);
  if (selected) return <AgentDetail agent={selected} model={model} onBack={() => onSelect(null)} />;
  if (!agents.length) return <div className="cv2-dock-empty">No agents in this thread. Choose Lead + workers or Best of N in Orchestrate to fan out.</div>;
  if (model.routing.preset === "best-of-n" && agents.some((a) => a.candidate)) {
    return (
      <div className="cv2-dock-pane">
        <div className="cv2-dockbar">
          <span className="cv2-m">Compare</span>
          <span className="cv2-mute">Each ran in its own worktree. Keep one; the others are deleted.</span>
        </div>
        <div className="cv2-dockscroll">
          <BestOfN items={agents.filter((a) => a.candidate || a.role === "worker")} instances={model.instances} onKeep={model.actions.keepCandidate} />
        </div>
      </div>
    );
  }
  return (
    <div className="cv2-dock-pane">
      <div className="cv2-dockscroll" style={{ padding: "12px 16px" }}>
        <AgentTree items={agents} instances={model.instances} budgetUsd={model.routing.budget?.maxUsd} selectedId={selectedId} onSelect={(id) => onSelect(id)} />
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
          <>
            <button type="button" className="cv2-btn" onClick={() => model.actions.stop()}>
              Take over
            </button>
            <button type="button" className="cv2-btn ink" onClick={() => model.actions.stop()}>
              Stop <Kbd k="escape" />
            </button>
          </>
        )}
      </div>
      <div className="cv2-dockscroll" style={{ padding: 12 }}>
        <ComputerTimeline items={steps} resolveScreenshot={resolveScreenshot} />
      </div>
    </div>
  );
}

// ── The dock ────────────────────────────────────────────────────────────────

export function visibleTabs(model: WorkspaceModel): DockTab[] {
  const tabs: DockTab[] = ["changes", "terminal", "files", "preview"];
  if (model.items.some((i) => i.kind === "plan" || i.kind === "todo_list")) tabs.push("plan");
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
  /** The composer, re-parented into the dock while expanded. */
  composer?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const tabs = visibleTabs(model);
  const width = effectiveDockWidth(dock);
  const handle = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const frame = React.useRef(0);
  const counts: Partial<Record<DockTab, number>> = {
    changes: aggregateChanges(model.items).length || undefined,
    agents: latestAgents(model.items).length || undefined,
  };
  const prevTab = React.useRef(dock.tab);
  const dir = tabs.indexOf(dock.tab) >= tabs.indexOf(prevTab.current) ? 1 : -1;
  React.useEffect(() => {
    prevTab.current = dock.tab;
  }, [dock.tab]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const right = (handle.current?.closest(".cv2-body") as HTMLElement | null)?.getBoundingClientRect().right ?? window.innerWidth;
    const w = right - e.clientX;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => dispatch({ type: "drag", width: w }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    const right = (handle.current?.closest(".cv2-body") as HTMLElement | null)?.getBoundingClientRect().right ?? window.innerWidth;
    dispatch({ type: "release", width: right - e.clientX });
  };

  return (
    <aside className="cv2-dock" style={{ ["--dock-w" as string]: `${width}px` }} aria-label="Dock">
      <div
        ref={handle}
        className="cv2-dock-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the dock"
        aria-valuemin={360}
        aria-valuemax={760}
        aria-valuenow={width}
        tabIndex={0}
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => dispatch({ type: "reset-width" })}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            dispatch({ type: "release", width: nudgeDockWidth(dock.width, e.key === "ArrowLeft" ? 1 : -1, e.shiftKey) });
          }
        }}
      />
      <div className="cv2-tabs" role="tablist" aria-label="Dock tabs">
        <button type="button" className="cv2-iconbtn cv2-only-narrow" aria-label="Close the dock" onClick={() => dispatch({ type: "close" })}>
          <Glyph name="close" />
        </button>
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={dock.tab === t} className="cv2-tab" onClick={() => dispatch({ type: "open", tab: t, threadId: model.thread.id })}>
            {dock.tab === t && <motion.span layoutId="dock-tab" className="fill" transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 40 }} />}
            <Glyph name={DOCK_TAB_GLYPHS[t]} size={14} />
            <span>{DOCK_TAB_LABELS[t]}</span>
            {counts[t] ? <span className="n">{counts[t]}</span> : null}
          </button>
        ))}
        <span className="cv2-grow" />
        <button type="button" className="cv2-iconbtn cv2-wide" aria-label={dock.expanded ? "Restore the dock" : "Expand the dock"} title={dock.expanded ? "Restore" : "Expand"} aria-pressed={dock.expanded} onClick={() => dispatch({ type: "toggle-expand" })}>
          <Glyph name={dock.expanded ? "collapse" : "expand"} />
        </button>
      </div>
      <div key={dock.tab} className="cv2-dock-pane" style={{ ["--cv2-pane-shift" as string]: `${dir * 4}px` }} role="tabpanel" aria-label={DOCK_TAB_LABELS[dock.tab]}>
        {dock.tab === "changes" && <ChangesPane model={model} focus={focus} wide={width >= 640 || dock.expanded} active />}
        {dock.tab === "terminal" && <TerminalPane model={model} focus={focus} />}
        {dock.tab === "files" && <FilesPane model={model} onMention={onMention} />}
        {dock.tab === "preview" && <PreviewPane model={model} />}
        {dock.tab === "plan" && <PlanPane model={model} />}
        {dock.tab === "agents" && <AgentsPane model={model} selectedId={selectedAgentId} onSelect={onSelectAgent} />}
        {dock.tab === "screen" && <ScreenPane model={model} resolveScreenshot={resolveScreenshot} />}
      </div>
      {dock.expanded && composer && <div className="cv2-cwrap">{composer}</div>}
    </aside>
  );
}

export type { ProviderInstance };
