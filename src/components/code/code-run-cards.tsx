"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion, type Variants } from "framer-motion";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import { spring, staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { CodeAgentState, CodePendingApproval } from "@/hooks/use-code-session";
import type { ClientMessage } from "@/types/chat";

/*
 * THE RUN STACK — everything the reader has to know before they type the next
 * instruction, in one column directly above the composer.
 *
 * These four cards used to be four sibling expressions inside 1,600 lines of
 * session view, in an order nobody had argued for: what changed sat at the top,
 * the approval request in the middle, and the queue note — the least urgent of
 * the four — closest to the composer. The order here is deliberate and it is
 * the file's only real opinion:
 *
 *   furthest    what changed          the run's OUTPUT. Reference, collapsed.
 *               helper agents         who else is working. Reference.
 *               why it can't run      an explanation with a way out.
 *               queued                a promise about the near future.
 *   nearest     needs your approval   the run is BLOCKED on you, right now.
 *
 * Distance from the composer is the ranking: the nearest card is the one whose
 * buttons the thumb is already next to, and the one the eye lands on when it
 * comes back down from the transcript.
 *
 * One recipe for all of them — `mx-1 mb-2 rounded-field border-border/70
 * bg-muted px-3 py-2.5` — because they stack, and a stack whose members have
 * three different fills reads as three unrelated things that happen to be
 * adjacent. (The three of them used to be 3.8%, 3.8% and 4.3% lightness: three
 * fills for one elevation rung, all of them BELOW the `bg-card` composer they
 * sit on. The stack now lifts: background 0% → composer 6.5% → run cards 9.5%.)
 */
const RUN_CARD = "mx-1 mb-2 rounded-field border border-border/70 bg-muted";
const RUN_CARD_INSET = "px-3 py-2.5";

/*
 * The approval card's entrance, spelled out rather than reusing `variants.rise`.
 *
 * `variants.rise` carries `transition.base` inside its own `visible`, and a
 * variant's transition beats the component's `transition` prop — so pairing it
 * with `spring.emphasized` at the call site would have SHADOWED the spring
 * while looking exactly like the thing that set it. The travel is `rise`'s own
 * 8px; the small scale is what stops a card this wide from arriving as a hard
 * rectangle, and it is the only number here not lifted verbatim.
 */
const APPROVAL_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: spring.emphasized },
  // Exits accelerate. The card leaves because the reader has already answered,
  // so making them watch a spring settle on the way out is making them wait.
  exit: { opacity: 0, y: 8, scale: 0.98, transition: transition.exit },
};

export interface CodeFileChange {
  path: string;
  changeKind: string;
  churn: string | null;
}

/*
 * WHAT THE RUN CHANGED, read back out of the transcript's activity rather than
 * from the task stream, because `useCodeSession` folds `file_change` events
 * straight into display strings ("edit src/foo.ts", "+3 −1") and keeps no
 * structured list. That is why the path is recovered with a split: the producer
 * composes `${changeKind} ${path}`, and a path cannot contain the first space.
 *
 * Latest write per path wins, so a file touched four times is one row with its
 * final churn — this is a summary of the result, not a log.
 */
export function useSessionFileChanges(messages: ClientMessage[]): CodeFileChange[] {
  return React.useMemo(() => {
    const byPath = new Map<string, CodeFileChange>();
    for (const message of messages) {
      for (const event of message.activity ?? []) {
        if (event.kind !== "write") continue;
        const space = event.title.indexOf(" ");
        const changeKind = space === -1 ? "edit" : event.title.slice(0, space);
        const path = space === -1 ? event.title : event.title.slice(space + 1);
        byPath.set(path, { path, changeKind, churn: event.detail ?? null });
      }
    }
    return [...byPath.values()];
  }, [messages]);
}

/** The last thing the runner said it was doing, or null when nothing is live. */
export function useCurrentActivity(messages: ClientMessage[], live: boolean): string | null {
  const last = messages[messages.length - 1];
  const events = last?.activity;
  const title = events && events.length > 0 ? events[events.length - 1].title : null;
  return live ? title ?? null : null;
}

export interface CodeRunStackProps {
  files: CodeFileChange[];
  agents: CodeAgentState[];
  pendingApproval: CodePendingApproval | null;
  responding: boolean;
  onRespond: (approve: boolean) => void;
  /** Copy for a task waiting to be picked up. Null unless the task is queued. */
  queuedNote: string | null;
  /**
   * Why the session cannot dispatch, and — when a second ask could change the
   * answer — the thing that asks again. Null whenever the answer is simply not
   * known yet: a note that appears for one round trip and vanishes is a
   * flicker, not an explanation.
   */
  blocked: { reason: string; onRecheck?: () => Promise<void> | void } | null;
}

export function CodeRunStack({
  files,
  agents,
  pendingApproval,
  responding,
  onRespond,
  queuedNote,
  blocked,
}: CodeRunStackProps) {
  return (
    <MotionConfig reducedMotion="user">
      {/* ALWAYS MOUNTED. A live region inserted at the same moment its text
          appears is frequently never announced at all (chat/approval-card makes
          the same argument), and the approval card's own sr-only span did
          exactly that — so the one moment Juno Code blocks and needs an answer
          was likely to pass in silence. This region outlives every state it
          reports on, including the queue banner, which had the same shape. */}
      <p role="status" aria-live="polite" className="sr-only">
        {pendingApproval
          ? `Juno Code needs your approval to: ${pendingApproval.summary}.${
              pendingApproval.risk === "destructive"
                ? " This is a destructive action."
                : pendingApproval.risk === "outside"
                  ? " This affects files outside the workspace."
                  : ""
            } Deny or Allow below.`
          : (queuedNote ?? "")}
      </p>

      {files.length > 0 && <ChangedFilesCard files={files} />}
      {agents.length > 0 && <AgentsCard agents={agents} />}
      {blocked && <BlockedNote reason={blocked.reason} onRecheck={blocked.onRecheck} />}
      {queuedNote && (
        <p className={cn(RUN_CARD, RUN_CARD_INSET, "flex items-center gap-2 text-xs text-muted-foreground motion-safe:animate-rise-in")}>
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground motion-safe:animate-pulse" aria-hidden="true" />
          {queuedNote}
        </p>
      )}

      {/*
        THE ONE CARD WITH A SPRING ON IT.

        An approval request is the only thing on this surface that arrives
        unbidden, blocks the run, and is dismissed by a press the reader makes
        within a second or two of seeing it. A CSS entrance would keep playing
        into an element that is already leaving; a spring carries its velocity
        through the interruption, which is exactly the case `src/lib/motion.ts`
        says to reach for framer over a keyframe.
      */}
      <AnimatePresence initial={false}>
        {pendingApproval && (
          <motion.div
            key={pendingApproval.requestId}
            variants={APPROVAL_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <ApprovalCard
              summary={pendingApproval.summary}
              risk={pendingApproval.risk}
              detail={pendingApproval.detail}
              responding={responding}
              onRespond={onRespond}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

/**
 * Why this session cannot run, and the one thing that fixes it.
 *
 * This used to exist only as the composer's PLACEHOLDER text, which is three
 * bad things at once: it disappears the moment you type, it is styled as an
 * invitation rather than as a problem, and it can hold a sentence but never a
 * control. A Mac that is merely asleep is the commonest blocked state here and
 * the most obviously worth a "Check again" — the presence poll is a 30-second
 * loop, so without one the honest instruction was "wait".
 */
function BlockedNote({
  reason,
  onRecheck,
}: {
  reason: string;
  onRecheck?: () => Promise<void> | void;
}) {
  const [checking, setChecking] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => () => {
    alive.current = false;
  }, []);

  const recheck = async () => {
    if (!onRecheck || checking) return;
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      // The presence poll outlives a navigation; this component does not.
      if (alive.current) setChecking(false);
    }
  };

  return (
    <div
      role="status"
      className={cn(
        RUN_CARD,
        RUN_CARD_INSET,
        "flex flex-wrap items-center gap-x-2.5 gap-y-2 motion-safe:animate-rise-in",
      )}
    >
      <StatusIcons.info className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{reason}</p>
      {onRecheck && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void recheck()}
          disabled={checking}
          className="shrink-0 gap-1.5 coarse:h-11"
        >
          <CodeIcons.refresh className={cn("size-3.5", checking && "animate-spin")} aria-hidden="true" />
          {checking ? "Checking…" : "Check again"}
        </Button>
      )}
    </div>
  );
}

/*
 * How a change kind reads at a glance.
 *
 * The rows were a flat mono column — `edit  src/foo.ts  +3 −1` — where the one
 * word that says whether a file was CREATED or DELETED sat in the same grey as
 * the path beside it. On a fifty-file run that is fifty identical lines. The
 * kind is the only categorical fact in the row, so it is the only one that gets
 * colour, and only for the two kinds that are not the default.
 */
function changeTone(kind: string): string {
  const k = kind.toLowerCase();
  if (k.startsWith("add") || k.startsWith("creat") || k === "new") return "text-success";
  if (k.startsWith("del") || k.startsWith("remov")) return "text-destructive";
  return "text-muted-foreground";
}

/** `+3 −1` per file, summed for the header. Parsed rather than recomputed
 *  because the producer already folded the numbers into a display string —
 *  see `useSessionFileChanges`. A row whose churn does not parse contributes
 *  nothing rather than a zero, so a partial parse never understates loudly. */
function totalChurn(files: CodeFileChange[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const file of files) {
    // U+2212 MINUS SIGN, which is what the producer writes — a hyphen here
    // would silently match nothing and report every run as additions only.
    const match = file.churn?.match(/\+(\d+)\s+[−-](\d+)/);
    if (!match) continue;
    seen = true;
    added += Number(match[1]);
    removed += Number(match[2]);
  }
  return seen ? { added, removed } : null;
}

/*
 * THE TREE THIS CARD SHOWS, BUILT FROM THE ONLY PATHS THE SESSION REPORTED.
 *
 * There is no workspace listing anywhere on the web: `GET /api/code/workspaces`
 * returns `{id, key, name, path, lastOpenedAt}` and no route reads inside one.
 * So this is not a repository browser and must not look like one — it is the
 * run's own `file_change` paths given back their shape. Every node here stands
 * for a file the session actually said it wrote; nothing is inferred about what
 * else is in those directories, and an empty-looking folder is one this run did
 * not touch rather than one that is empty.
 */
interface FileTreeNode {
  /** The row's label: one path segment, or several joined by "/" where a chain
   *  of single-child directories was folded into one row. */
  name: string;
  /** Full path from the root — the React key, and the collapse-state key. */
  key: string;
  /** Set on a leaf. A directory row carries null and summarises its subtree. */
  file: CodeFileChange | null;
  children: FileTreeNode[];
  /** Files under this node, itself included. */
  count: number;
  churn: { added: number; removed: number } | null;
}

/**
 * Paths → a tree, with single-child chains folded flat.
 *
 * The folding is what makes this worth doing at all. Without it a one-file run
 * on `src/lib/a.ts` becomes three rows where it used to be one, and the card
 * that exists to stay small above the composer would have grown for the
 * commonest case. With it, a lone file is still one row reading the whole path,
 * and the tree only appears where there is genuinely a shape to see.
 *
 * Order is directories first, then alphabetical. That discards the order the run
 * wrote them in, which is the correct trade for the reason `useSessionFileChanges`
 * already gives: this is a summary of the result, not a log, and a list that
 * re-sorts itself as a run streams is one nobody can read a path off.
 */
function buildFileTree(files: readonly CodeFileChange[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", key: "", file: null, children: [], count: 0, churn: null };

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    let node = root;
    segments.forEach((segment, index) => {
      const key = node.key === "" ? segment : `${node.key}/${segment}`;
      let next = node.children.find((child) => child.key === key);
      if (!next) {
        next = { name: segment, key, file: null, children: [], count: 0, churn: null };
        node.children.push(next);
      }
      if (index === segments.length - 1) next.file = file;
      node = next;
    });
  }

  return finishNodes(root.children);
}

function finishNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  const done = nodes.map((node) => {
    // Fold `src` → `lib` → `a.ts` down to whichever descendant first branches or
    // first carries a change of its own. A node with a `file` is never folded
    // away: it is a real row with a change kind and a churn on it.
    let folded = node;
    while (folded.file === null && folded.children.length === 1) {
      const only = folded.children[0];
      folded = { ...only, name: `${folded.name}/${only.name}` };
    }
    const children = finishNodes(folded.children);
    const subtree = collectFiles(folded.file, children);
    return { ...folded, children, count: subtree.length, churn: totalChurn(subtree) };
  });

  // Directories before files, then by name. `localeCompare` rather than `<` so
  // a path with an accent in it sorts where a reader expects rather than after Z.
  return done.sort((a, b) => {
    const aDir = a.children.length > 0;
    const bDir = b.children.length > 0;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function collectFiles(own: CodeFileChange | null, children: readonly FileTreeNode[]): CodeFileChange[] {
  const out = own ? [own] : [];
  for (const child of children) {
    if (child.file) out.push(child.file);
    out.push(...collectFiles(null, child.children));
  }
  return out;
}

/** The visible rows, in reading order, given which directories are shut. */
function flattenTree(
  nodes: readonly FileTreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0
): { node: FileTreeNode; depth: number }[] {
  const rows: { node: FileTreeNode; depth: number }[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children.length > 0 && !collapsed.has(node.key)) {
      rows.push(...flattenTree(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

/**
 * WHAT THE RUN CHANGED.
 *
 * Both footers on this surface promise you can "review the changes", and the
 * surface used to offer nowhere to do it: file changes arrive as real events
 * with a path, a change kind and +added/−removed, and their only destination
 * was a run trace with no way to open.
 *
 * It is still not a diff, and the reason is upstream of this file rather than a
 * decision taken in it: the `file_change` payload carries `path`, `changeKind`,
 * `added` and `removed` and no patch text, so the readers that fold it into a
 * message (`use-code-session.ts`, `code-remote.ts`) have nothing to hand a diff
 * renderer. `src/components/aicss/file-diff.tsx` — parser and colour-blind-safe
 * row renderer both — is sitting there finished and waiting for the day the
 * producer sends the hunks. Until it does, drawing a diff here would mean
 * inventing one.
 *
 * What this DOES do is give the paths back their shape. Fifty flat mono lines
 * sharing a prefix is fifty lines you read character by character to find the
 * one that is not under `src/components`; the same fifty as a tree is a handful
 * of rows you can shut. See `buildFileTree` for what the tree is and is not.
 *
 * Collapsed by default: it sits directly above the composer, and a fifty-file
 * run must not push the prompt off screen. The header therefore has to carry
 * the summary — a count alone made you open the list to learn whether the run
 * had written three lines or three hundred.
 */
function ChangedFilesCard({ files }: { files: CodeFileChange[] }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const churn = React.useMemo(() => totalChurn(files), [files]);
  const tree = React.useMemo(() => buildFileTree(files), [files]);
  // Directories start open, and a directory a run adds mid-stream opens too:
  // this holds only the ones a reader has explicitly shut. The alternative —
  // tracking which are open — would shut every folder that appeared after the
  // first paint, which on a streaming run is most of them.
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const rows = React.useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  const toggleDirectory = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section
      aria-label="Files this session changed"
      // p-0.5 is what makes the row's own rounded-control (9px) concentric
      // inside this rounded-field (10px) shell: outer = inner + padding.
      className={cn(RUN_CARD, "p-0.5 motion-safe:animate-rise-in")}
    >
      <Pressable
        kind="row"
        size="sm"
        aria-expanded={open}
        // The list is always in the document (it collapses rather than
        // unmounting), so this can point at it unconditionally.
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        // ~30px otherwise, on the only disclosure above a composer whose every
        // other control carries `coarse:h-11`.
        className="coarse:min-h-11"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="font-mono text-label text-muted-foreground">
          {files.length === 1 ? "1 file changed" : `${files.length} files changed`}
        </span>
        {churn && (
          // tabular-nums: these two figures tick up in place while a run
          // streams, and proportional digits make the header twitch sideways.
          <span className="ml-auto shrink-0 font-mono text-caption tabular-nums">
            <span className="text-success">+{churn.added}</span>{" "}
            <span className="text-destructive">−{churn.removed}</span>
          </span>
        )}
      </Pressable>
      {/*
        The same grid/`grid-template-rows` collapse the attachment tray uses. As
        `{open && <ul>}` the list snapped in instantly while its own chevron
        rotated over `duration-fast` — the disclosure and the thing it disclosed
        were animating to two different rules.

        `aria-hidden` while closed because the rows stay in the document for the
        transition to have something to animate; without it a screen reader
        would read out a file list the disclosure says is collapsed.
      */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/*
            A LIST OF DISCLOSURES, NOT `role="tree"`.
            The visual idiom is design/layers-panel.tsx's — 6px of inset plus
            12px a level, one chevron column — but the ARIA is deliberately not:
            a tree is a SELECTION widget, and nothing in here is selectable, so
            `role="treeitem"` would have owed every row an `aria-selected` that
            could only ever have been a lie, plus arrow-key navigation this card
            does not implement. What a screen reader gets instead is what it
            actually needs and what the indentation cannot give it — each file
            row states its whole path, not the folded leaf name a sighted reader
            reads off the row above.
          */}
          <ul id={listId} aria-hidden={!open} className="px-1.5 pb-2 pt-1">
            {rows.map(({ node, depth }, i) => {
              const directory = node.children.length > 0;
              const shut = collapsed.has(node.key);
              const row = (
                <>
                  {directory ? (
                    shut ? (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )
                  ) : (
                    // The same 12px the chevron occupies, so file names line up
                    // with the directory names above them instead of hanging
                    // three pixels to their left.
                    <span className="w-3 shrink-0" aria-hidden="true" />
                  )}
                  {node.file ? (
                    <span className={cn("shrink-0 font-mono", changeTone(node.file.changeKind))}>
                      {node.file.changeKind}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {node.count}
                    </span>
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono",
                      node.file ? "text-foreground" : "text-muted-foreground"
                    )}
                    title={node.file ? node.file.path : `${node.key}/`}
                  >
                    {/* Two spellings of the same fact. The eye reads the folded
                        name and takes the rest from the indentation; a reader
                        who cannot see the indentation gets the whole path. */}
                    <span aria-hidden="true">{node.file ? node.name : `${node.name}/`}</span>
                    <span className="sr-only">{node.file ? node.file.path : `${node.key}/`}</span>
                  </span>
                  {node.file?.churn ? (
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {node.file.churn}
                    </span>
                  ) : (
                    // A shut directory must still say how much moved inside it,
                    // otherwise collapsing the tree costs the summary the header
                    // was rebuilt to provide.
                    node.churn && (
                      <span className="shrink-0 font-mono tabular-nums">
                        <span className="text-success">+{node.churn.added}</span>{" "}
                        <span className="text-destructive">−{node.churn.removed}</span>
                      </span>
                    )
                  )}
                </>
              );

              const shared = cn(
                "flex w-full items-baseline gap-2 py-0.5 text-left text-caption",
                // Rows are dealt out as the run writes them rather than
                // repainted. `tight` is the rung for dense rows, and the shared
                // cap stops a fifty-file run taking two seconds to appear.
                "[animation-fill-mode:backwards] motion-safe:animate-fade-in-up"
              );
              // 6px of inset, then 12px a level — the layers panel's ladder, and
              // the reason a nested path stays legible at `text-caption`.
              const indent = { ...staggerDelay(i, "tight"), paddingLeft: 6 + depth * 12 };

              return (
                <li key={node.key}>
                  {directory ? (
                    <button
                      type="button"
                      aria-expanded={!shut}
                      // Out of the tab order while the CARD is shut. The rows
                      // stay in the document so the collapse has something to
                      // animate, and `aria-hidden` over a focusable control is
                      // the one way that trick goes wrong: Tab lands on a button
                      // no screen reader will name.
                      tabIndex={open ? 0 : -1}
                      onClick={() => toggleDirectory(node.key)}
                      className={cn(shared, "rounded-xs hover:bg-accent/60")}
                      style={indent}
                    >
                      {row}
                    </button>
                  ) : (
                    <span className={shared} style={indent}>
                      {row}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** The tone each reported agent state reads in. Unknown states stay neutral
 *  rather than guessing — the runner owns this vocabulary, not this file. */
const AGENT_TONE: Record<string, string> = {
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  interrupted: "text-muted-foreground",
  waiting_approval: "text-warning",
};
const AGENT_SETTLED = ["completed", "failed", "cancelled", "interrupted"];

/** Live cards for delegated child agents (multi-agent cloud runs): role, task,
 *  real state, current activity, files, and conflict warnings. No fake
 *  progress — only what the runner actually reported. */
function AgentsCard({ agents }: { agents: CodeAgentState[] }) {
  const active = agents.some((a) => !AGENT_SETTLED.includes(a.status));
  return (
    <section
      aria-label="Helper agents"
      className={cn(RUN_CARD, RUN_CARD_INSET, "motion-safe:animate-rise-in")}
    >
      <p className="mb-1.5 flex items-center gap-2 font-mono text-label text-muted-foreground">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            active ? "bg-primary motion-safe:animate-pulse" : "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        Agents
        <span className="ml-auto tabular-nums">
          {agents.filter((a) => AGENT_SETTLED.includes(a.status)).length}/{agents.length} done
        </span>
      </p>
      <ul className="flex flex-col gap-1.5">
        {agents.map((agent, i) => {
          const status = typeof agent.status === "string" ? agent.status : "unknown";
          const tone = AGENT_TONE[status] ?? "text-foreground/80";
          const tokens =
            agent.usage && Number.isFinite(agent.usage.inputTokens + agent.usage.outputTokens)
              ? agent.usage.inputTokens + agent.usage.outputTokens
              : 0;
          return (
            <li
              key={agent.id}
              className="flex flex-col gap-0.5 text-xs [animation-fill-mode:backwards] motion-safe:animate-fade-in-up"
              style={staggerDelay(i, "tight")}
            >
              <span className="flex items-baseline gap-2">
                <span className="font-medium capitalize text-foreground">{agent.role}</span>
                <span className="truncate text-foreground/80">{agent.title}</span>
                <span className={cn("ml-auto shrink-0 font-mono text-caption", tone)}>
                  {status.replace("_", " ")}
                </span>
              </span>
              <span className="flex items-baseline gap-2 text-caption text-muted-foreground">
                <span className="truncate">
                  {agent.status === "failed" && agent.error ? agent.error : agent.currentActivity ?? ""}
                </span>
                {tokens > 0 && (
                  // tabular-nums: this counter ticks up in place while the agent
                  // runs, and proportional digits make the row jitter sideways.
                  <span className="ml-auto shrink-0 font-mono tabular-nums">
                    {tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tok
                  </span>
                )}
              </span>
              {agent.filesChanged && agent.filesChanged.length > 0 && (
                <span className="text-caption text-muted-foreground">
                  {agent.applied ? "applied" : "proposed"}: {agent.filesChanged.join(", ")}
                </span>
              )}
              {agent.conflictedFiles && agent.conflictedFiles.length > 0 && (
                <span className="flex items-start gap-1.5 text-caption text-warning">
                  <StatusIcons.warning className="mt-px size-3 shrink-0" aria-hidden="true" />
                  conflicts with your checkout: {agent.conflictedFiles.join(", ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** An agent follow-up question: approve or deny the proposed action. The Mac
 *  waits up to five minutes, then denies on its own (native host behavior). */
function ApprovalCard({
  summary,
  risk,
  detail,
  responding,
  onRespond,
}: {
  summary: string;
  risk: string;
  detail: string | null;
  responding: boolean;
  onRespond: (approve: boolean) => void;
}) {
  return (
    // Not a dialog: this card appears inline in the transcript, never takes
    // focus and traps nothing, so role="alertdialog" promised modal behavior no
    // AT could act on. A labelled group is what it actually is — paired with a
    // polite live announcement (in CodeRunStack) so the request isn't silent.
    <div
      role="group"
      aria-label="Juno Code approval request"
      // `bg-warning/10` — the alpha globals.css names as the product's warning
      // chip. At /5 the highest-stakes surface in Juno Code was a ~1%-lightness
      // tint on the black ground, leaving `border-warning/40` to carry the whole
      // alarm on its own. Inset matches the sibling cards above the composer.
      className="mx-1 mb-2 space-y-2.5 rounded-field border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
    >
      <div className="flex items-start gap-2.5">
        <CodeIcons.permission className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">
            <span className="text-muted-foreground">Juno Code wants to: </span>
            <span className="font-medium">{summary}</span>
          </p>
          {detail && (
            // rounded-xs, not rounded-lg: `lg` is the legacy alias for 24px, so
            // this block's corner was twice the 12px card holding it, inside
            // ~6px of inset. Concentric wants inner = outer − padding.
            //
            // `bg-muted/60` RAISES the well instead of darkening it: recessing
            // by darkening has no headroom left on a 0%-lightness ground, so the
            // old `bg-background/60` read as a hole punched in the card rather
            // than an inset. `tabIndex={0}` because this region scrolls, and a
            // scrollable region no keyboard can reach is one a keyboard user
            // cannot read the end of.
            <pre
              tabIndex={0}
              className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-muted/60 px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground"
            >
              {detail}
            </pre>
          )}
        </div>
        {(risk === "destructive" || risk === "outside") && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-caption",
              risk === "destructive"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning-foreground",
            )}
          >
            <StatusIcons.warning className="size-3" aria-hidden="true" />
            {risk === "destructive" ? "Destructive" : "Outside workspace"}
          </span>
        )}
      </div>
      {/* REFUSE FIRST, AT EQUAL WEIGHT — the rule the shared approval card
          states and this one inverted. Leading with a primary Allow answers for
          a reader who is here precisely to stop and think, and colouring that
          Allow `destructive` on the highest-risk prompt on the surface made red
          mean "go ahead" here and "refuse" one screen over. The risk badge
          above already carries the danger; the buttons carry the choice. Both
          at h-11, matching chat/approval-card — `size="sm"` gave a 40px target
          to the one control in Juno Code that must not be mis-tapped. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="destructive-outline"
          disabled={responding}
          onClick={() => onRespond(false)}
          className="h-11 px-4"
        >
          Deny
        </Button>
        <Button type="button" disabled={responding} onClick={() => onRespond(true)} className="h-11 gap-1.5 px-4">
          {responding && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          Allow
        </Button>
        <span className="text-caption text-muted-foreground">Your Mac denies automatically after 5 minutes.</span>
      </div>
    </div>
  );
}
