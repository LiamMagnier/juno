"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, CornerDownRight, Folder, MessageSquare, Pin, PinOff, Plus, Search } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { promptPreview } from "@/lib/prompt-preview";
import { cn } from "@/lib/utils";
import {
  MAX_PROJECT_DEPTH,
  MOVE_REFUSAL_MESSAGES,
  buildProjectForest,
  depthOf,
  flattenProjectForest,
  validateNewChild,
  validateProjectMove,
  type DeleteChildrenMode,
} from "@/lib/projects/project-tree";
import { ProjectCover } from "@/components/projects/project-cover";
import "@/components/projects/projects.css";

/* ─────────────────────────────── Types ─────────────────────────────── */

/** A project as the list route answers it, enough to draw and nest it. */
export interface FolderProject {
  id: string;
  name: string;
  parentId: string | null;
  instructions?: string;
  updatedAt?: string;
  conversationCount?: number;
  fileCount?: number;
  coverUrl?: string | null;
  starred?: boolean;
  /** Subfolders directly inside (the detail route counts them for us). */
  childCount?: number;
}

/* ─────────────────────────────── Drag and drop ─────────────────────────────── */

/**
 * What is being dragged. A module-level slot rather than `dataTransfer`
 * alone, because `getData` is unreadable during `dragover` and a target must
 * know whether it will take the drop BEFORE it is dropped on (that is what
 * lights it, or dims it as refused).
 */
export type ProjectDrag = { kind: "project"; id: string } | { kind: "chat"; id: string; projectId: string | null };

let activeDrag: ProjectDrag | null = null;
const DRAG_MIME = "application/x-alevr-item";

export function dragSourceProps(drag: ProjectDrag) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      activeDrag = drag;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(drag));
      event.dataTransfer.setData("text/plain", drag.id);
      (event.currentTarget as HTMLElement).setAttribute("data-dragging", "");
    },
    onDragEnd: (event: React.DragEvent) => {
      activeDrag = null;
      (event.currentTarget as HTMLElement).removeAttribute("data-dragging");
    },
  };
}

/**
 * A drop target: lit while something it accepts is over it, dimmed when the
 * thing over it is refused (a folder dragged into itself), inert otherwise.
 */
export function useDropTarget(accept: (drag: ProjectDrag) => boolean, onDrop: (drag: ProjectDrag) => void) {
  const [state, setState] = React.useState<"over" | "refuse" | null>(null);
  const depth = React.useRef(0);
  return {
    "data-drop": state ?? undefined,
    onDragEnter: (event: React.DragEvent) => {
      if (!activeDrag) return;
      depth.current += 1;
      setState(accept(activeDrag) ? "over" : "refuse");
      event.preventDefault();
    },
    onDragOver: (event: React.DragEvent) => {
      if (!activeDrag || !accept(activeDrag)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setState(null);
    },
    onDrop: (event: React.DragEvent) => {
      depth.current = 0;
      setState(null);
      const drag = activeDrag;
      activeDrag = null;
      if (!drag || !accept(drag)) return;
      event.preventDefault();
      onDrop(drag);
    },
  } as const;
}

/** Whether `drag` may land in the project `targetId` (null = top level / no project). */
export function canDropInto(projects: readonly FolderProject[], drag: ProjectDrag, targetId: string | null) {
  if (drag.kind === "chat") return targetId !== null && drag.projectId !== targetId;
  const current = projects.find((p) => p.id === drag.id)?.parentId ?? null;
  if (current === targetId) return false;
  return validateProjectMove(projects, drag.id, targetId).ok;
}

/* ─────────────────────────────── The dialog shell ─────────────────────────────── */

/**
 * Every project dialog's one shape: a 16px panel with a 6px frame holding a
 * 10px page (16 - 6), and the actions on the frame below the page, 8px from
 * the panel's edge, so the 8px buttons in that corner are concentric with it.
 * The page carries the serif title, a mono line naming what it acts on, and
 * the body.
 */
export function ProjectSheet({
  open,
  onOpenChange,
  annot,
  title,
  description,
  children,
  footer,
  footerStart,
  className,
  pageClassName,
  contentProps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  annot?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer: React.ReactNode;
  /** Left side of the action row: counts, a hint. */
  footerStart?: React.ReactNode;
  className?: string;
  pageClassName?: string;
  contentProps?: Omit<React.ComponentPropsWithoutRef<typeof DialogContent>, "className" | "children">;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...contentProps}
        className={cn("pj nest-panel nest-p-1.5 flex max-w-md flex-col gap-0 overflow-hidden p-1.5 sm:p-1.5", className)}
      >
        <div className={cn("pj-sheet flex min-h-0 flex-1 flex-col rounded-inner", pageClassName)}>
          <div className="shrink-0 px-5 pb-4 pr-14 pt-5">
            {annot && <p className="pj-annot mb-2 truncate">{annot}</p>}
            <DialogTitle className="pj-name text-balance text-foreground">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="mt-1.5 text-pretty text-ui leading-relaxed">{description}</DialogDescription>
            ) : (
              <DialogDescription className="sr-only">{typeof title === "string" ? title : "Project"}</DialogDescription>
            )}
          </div>
          {children}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 p-0.5 pt-1.5">
          <div className="min-w-0 pl-3">{footerStart}</div>
          <div className="flex items-center gap-1.5">{footer}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────── Name: create / rename ─────────────────────────────── */

export function ProjectNameDialog({
  open,
  onOpenChange,
  mode,
  parentName,
  initialName = "",
  busy = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "folder" | "rename";
  /** For a new folder: where it is made. */
  parentName?: string;
  initialName?: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = React.useState(initialName);
  React.useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);
  const optional = mode === "create";
  const submit = () => {
    if (!optional && !name.trim()) return;
    onSubmit(name.trim());
  };
  const copy = {
    create: { annot: "Projects", title: "New project", action: "Create project", placeholder: "Leave blank to name it from the first chat" },
    folder: { annot: parentName ? `Inside ${parentName}` : "Projects", title: "New folder", action: "Create folder", placeholder: "Research, Drafts, Q4…" },
    rename: { annot: "Rename", title: "Rename project", action: "Rename", placeholder: "Project name" },
  }[mode];
  return (
    <ProjectSheet
      open={open}
      onOpenChange={onOpenChange}
      annot={copy.annot}
      title={copy.title}
      description={
        mode === "folder"
          ? "A project inside this one. Its chats follow this project’s instructions and read its files, then the folder’s own."
          : mode === "create"
            ? "Chats, instructions and files kept together. Name it now, or let the first chat name it."
            : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!optional && !name.trim()}>
            {copy.action}
          </Button>
        </>
      }
    >
      <div className="px-5 pb-5">
        <label htmlFor="pj-name-input" className="pj-annot mb-2 block">
          Name{optional ? " (optional)" : ""}
        </label>
        <Input
          id="pj-name-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={copy.placeholder}
          autoFocus
          maxLength={120}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </div>
    </ProjectSheet>
  );
}

/* ─────────────────────────────── Delete ─────────────────────────────── */

export function DeleteProjectDialog({
  open,
  onOpenChange,
  project,
  parentName,
  folderCount,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { name: string } | null;
  /** Where the subfolders go on "lift"; undefined = the top level. */
  parentName?: string;
  /** Subfolders directly inside. 0 = an ordinary delete, no choice to make. */
  folderCount: number;
  busy?: boolean;
  onConfirm: (mode: DeleteChildrenMode) => void;
}) {
  const [mode, setMode] = React.useState<DeleteChildrenMode>("lift");
  React.useEffect(() => {
    if (open) setMode("lift");
  }, [open]);
  const where = parentName ? `up into ${parentName}` : "up to the top level";
  return (
    <ProjectSheet
      open={open}
      onOpenChange={onOpenChange}
      annot="Delete"
      title={`Delete “${project?.name ?? "this project"}”?`}
      description="Its chats are kept, unlinked. Its instructions and files are removed. This can’t be undone."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" loading={busy} onClick={() => onConfirm(folderCount ? mode : "lift")}>
            {folderCount && mode === "cascade" ? "Delete all" : "Delete"}
          </Button>
        </>
      }
    >
      {folderCount > 0 && (
        <fieldset className="px-5 pb-5">
          <legend className="pj-annot mb-2">
            {folderCount === 1 ? "It holds 1 folder" : `It holds ${folderCount} folders`}
          </legend>
          <div className="grid gap-1.5" role="radiogroup">
            {(
              [
                { value: "lift", title: `Keep the folders`, body: `Move them ${where}, with everything in them.` },
                { value: "cascade", title: "Delete them too", body: "Every folder inside goes as well. Their chats are kept, unlinked." },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-control border px-3 py-2.5 transition-colors duration-fast ease-out-soft",
                  mode === option.value
                    ? "border-foreground/25 bg-foreground/[.035]"
                    : "border-[var(--pj-hair)] hover:bg-foreground/[.02]"
                )}
              >
                <input
                  type="radio"
                  name="pj-delete-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-1 accent-[var(--pj-presence)]"
                />
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-foreground">{option.title}</span>
                  <span className="block text-caption leading-relaxed text-muted-foreground">{option.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </ProjectSheet>
  );
}

/* ─────────────────────────────── Move to… ─────────────────────────────── */

export type MoveSubject =
  | { kind: "project"; id: string; name: string; parentId: string | null }
  | { kind: "chat"; id: string; name: string; projectId: string | null };

/**
 * The picker: every project as a tree, the subject's own branch and any
 * folder too deep to take it shown but not choosable, the current place
 * marked. One choice, then Move.
 */
export function MoveToDialog({
  open,
  onOpenChange,
  subject,
  projects,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: MoveSubject | null;
  projects: readonly FolderProject[];
  busy?: boolean;
  onConfirm: (targetId: string | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  const current = subject ? (subject.kind === "project" ? subject.parentId : subject.projectId) : null;
  const [choice, setChoice] = React.useState<string | null>(current);
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setChoice(current);
    }
  }, [open, current]);

  const rows = React.useMemo(() => {
    const flat = flattenProjectForest(buildProjectForest(projects, (a, b) => a.name.localeCompare(b.name)));
    const q = query.trim().toLowerCase();
    return flat
      .filter(({ node }) => !q || node.name.toLowerCase().includes(q))
      .map(({ node, depth }) => {
        let refusal: string | null = null;
        if (subject?.kind === "project") {
          const check = validateProjectMove(projects, subject.id, node.id);
          if (!check.ok) refusal = check.reason === "depth" ? "Too deep" : check.reason === "self" ? "This project" : "Inside it";
        }
        return { node, depth: q ? 1 : depth, refusal };
      });
  }, [projects, query, subject]);

  const nameOf = (id: string | null) =>
    id ? projects.find((p) => p.id === id)?.name ?? "a project" : subject?.kind === "chat" ? "no project" : "the top level";
  const rootLabel = subject?.kind === "chat" ? "No project" : "Top level";
  const changed = choice !== current;

  return (
    <ProjectSheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-lg"
      annot={`Now in ${nameOf(current)}`}
      title={`Move “${subject?.name ?? ""}”`}
      footerStart={<span className="pj-annot">{changed ? `To ${nameOf(choice)}` : "Choose a place"}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!changed} loading={busy} onClick={() => onConfirm(choice)}>
            Move here
          </Button>
        </>
      }
    >
      <div className="px-5 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a project"
            aria-label="Find a project"
            className="pl-9"
          />
        </div>
      </div>
      {/* The list runs to the page's edges, so its rows (rounded-control, 8)
          sit 2px inside a 10px page: 10 - 2. */}
      <div role="listbox" aria-label="Destinations" className="max-h-[min(22rem,50dvh)] overflow-y-auto border-t border-[var(--pj-hair)] p-0.5">
        {!query.trim() && (
          <PickerRow
            label={rootLabel}
            depth={1}
            icon={subject?.kind === "chat" ? MessageSquare : CornerDownRight}
            selected={choice === null}
            current={current === null}
            onSelect={() => setChoice(null)}
          />
        )}
        {rows.map(({ node, depth, refusal }) => (
          <PickerRow
            key={node.id}
            label={node.name}
            depth={depth}
            icon={Folder}
            selected={choice === node.id}
            current={current === node.id}
            disabledReason={refusal}
            onSelect={() => setChoice(node.id)}
          />
        ))}
        {rows.length === 0 && <p className="px-4 py-6 text-center text-ui text-muted-foreground">No project by that name.</p>}
      </div>
    </ProjectSheet>
  );
}

function PickerRow({
  label,
  depth,
  icon: Icon,
  selected,
  current,
  disabledReason,
  onSelect,
}: {
  label: string;
  depth: number;
  icon: typeof Folder;
  selected: boolean;
  current: boolean;
  disabledReason?: string | null;
  onSelect: () => void;
}) {
  const disabled = !!disabledReason;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-10 w-full items-center gap-2.5 rounded-control px-3 text-left text-ui transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
        selected ? "bg-[var(--pj-presence-soft)] text-foreground" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-45 hover:bg-transparent"
      )}
      style={{ paddingLeft: `${12 + (depth - 1) * 18}px` }}
    >
      <Icon className={cn("size-4 shrink-0", selected ? "text-[var(--pj-presence)]" : "text-muted-foreground")} aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>{label}</span>
      {current && <span className="pj-annot shrink-0">Current</span>}
      {disabledReason && !current && <span className="pj-annot shrink-0">{disabledReason}</span>}
    </button>
  );
}

/* ─────────────────────────────── Breadcrumbs ─────────────────────────────── */

/**
 * Projects / Atlas launch / Research. Each crumb is a link and a drop target:
 * drop a folder or a chat on a crumb to move it there ("Projects" is the top
 * level, which only folders can go to).
 */
export function ProjectBreadcrumbs({
  crumbs,
  current,
  onDropInto,
  accept,
}: {
  crumbs: { id: string; name: string }[];
  current: string;
  onDropInto?: (targetId: string | null, drag: ProjectDrag) => void;
  accept?: (drag: ProjectDrag, targetId: string | null) => boolean;
}) {
  return (
    <nav aria-label="Folder path" className="pj flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
      <Crumb href="/projects" label="Projects" targetId={null} onDropInto={onDropInto} accept={accept} />
      {crumbs.map((crumb) => (
        <React.Fragment key={crumb.id}>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          <Crumb href={`/projects/${crumb.id}`} label={crumb.name} targetId={crumb.id} onDropInto={onDropInto} accept={accept} />
        </React.Fragment>
      ))}
      <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      <span aria-current="page" className="pj-annot truncate text-foreground/80">
        {current}
      </span>
    </nav>
  );
}

function Crumb({
  href,
  label,
  targetId,
  onDropInto,
  accept,
}: {
  href: string;
  label: string;
  targetId: string | null;
  onDropInto?: (targetId: string | null, drag: ProjectDrag) => void;
  accept?: (drag: ProjectDrag, targetId: string | null) => boolean;
}) {
  const drop = useDropTarget(
    (drag) => !!onDropInto && (accept ? accept(drag, targetId) : true),
    (drag) => onDropInto?.(targetId, drag)
  );
  return (
    <Link
      href={href}
      {...drop}
      className="pj-drop pj-annot max-w-[14rem] truncate rounded-xs px-1 py-0.5 transition-colors duration-fast ease-out-soft hover:text-foreground"
    >
      {label}
    </Link>
  );
}

/* ─────────────────────────────── The tile ─────────────────────────────── */

const FOLDER_NAMES = 2;

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One project or folder. A 12px card with a 4px frame: the cover plate
 * reaches the frame and takes 8 (12 - 4); the name, excerpt and meta sit on
 * the 12px text inset. The cover is the project's own dot-matrix drawing
 * (project-cover.tsx), or its uploaded image. The name is the link
 * (stretched over the tile); the folder names are links above it; pin and
 * menu surface on hover and focus, and are always there on touch.
 *
 * `compact` (a folder inside a project) keeps the cover, on a shallower
 * 2:1 plate on a finer dot pitch, and drops the excerpt: a folder is read by its name and its
 * drawing, the same object as a project at a smaller size.
 */
export function ProjectTile({
  project: p,
  folders = [],
  pathLabel,
  allProjects,
  compact = false,
  live = false,
  index = 0,
  onToggleStar,
  onRename,
  onMove,
  onNewFolder,
  onDelete,
  onDropInto,
}: {
  project: FolderProject;
  /** Its subfolders, named under it. */
  folders?: FolderProject[];
  /** Where it sits, when drawn out of place (a search result). */
  pathLabel?: string;
  /** The whole tree, so a drop can be checked before it lands. */
  allProjects: readonly FolderProject[];
  compact?: boolean;
  /** The most recently touched project: its cover carries the presence trajectory. */
  live?: boolean;
  /** Its place in the grid (the entrance and the cover's draw-on follow it). */
  index?: number;
  onToggleStar?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onNewFolder?: () => void;
  onDelete?: () => void;
  onDropInto?: (drag: ProjectDrag) => void;
}) {
  const drop = useDropTarget(
    (drag) => !!onDropInto && canDropInto(allProjects, drag, p.id),
    (drag) => onDropInto?.(drag)
  );
  const fileCount = Math.max(0, (p.fileCount ?? 0) - (p.coverUrl ? 1 : 0));
  const folderCount = p.childCount ?? folders.length;
  const canNest = validateNewChild(allProjects, p.id).ok;
  const excerpt = promptPreview(p.instructions ?? "");
  const hasActions = !!(onToggleStar || onRename || onMove || onDelete);

  // A folder tile is narrow: chats, its own folders and the age, no prefix.
  const meta = compact
    ? [plural(p.conversationCount ?? 0, "chat"), ...(folderCount > 0 ? [plural(folderCount, "folder")] : []), ...(p.updatedAt ? [timeAgo(p.updatedAt)] : [])]
    : [plural(p.conversationCount ?? 0, "chat"), plural(fileCount, "file"), ...(p.updatedAt ? [`updated ${timeAgo(p.updatedAt)}`] : [])];

  return (
    <article
      {...drop}
      {...dragSourceProps({ kind: "project", id: p.id })}
      className={cn("pj-tile nest-card nest-p-1 group/tile relative flex h-full flex-col", compact && "pj-tile-compact")}
      style={{ ["--i" as string]: Math.min(index, 11) }}
    >
      <div className={cn("pj-cover relative w-full overflow-hidden rounded-inner", compact ? "aspect-[16/7] @[30rem]/page:aspect-[2/1]" : "aspect-[16/7]")}>
        {p.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.coverUrl} alt="" className="pj-cover-art size-full object-cover" draggable={false} />
        ) : (
          <ProjectCover id={p.id} folders={folderCount} live={live} index={index} aspect={compact ? 2 : undefined}
            className={compact ? "pj-cover-art-sm" : undefined} />
        )}
      </div>

      <div className={cn("flex flex-1 flex-col px-3", compact ? "pb-2.5 pt-3" : "pb-3 pt-3.5")}>
        {pathLabel && <p className="pj-annot mb-1 truncate pr-6">{pathLabel}</p>}
        <Link
          href={`/projects/${p.id}`}
          draggable={false}
          className={cn(
            "block truncate text-foreground outline-none after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring",
            compact ? "pj-name-sm" : "pj-name"
          )}
        >
          {p.name}
        </Link>
        {!compact && (
          <p className={cn("mt-1 truncate text-ui", excerpt ? "text-muted-foreground" : "text-muted-foreground/70")}>
            {excerpt || "No instructions yet"}
          </p>
        )}

        {!compact && folders.length > 0 && (
          <p className="relative z-[1] mt-3 flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
            <Folder className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="shrink-0 text-foreground/80">{plural(folders.length, "folder")}</span>
            <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {folders.slice(0, FOLDER_NAMES).map((folder, i) => (
                <React.Fragment key={folder.id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/projects/${folder.id}`}
                    draggable={false}
                    className="rounded-sm underline-offset-[3px] outline-none transition-colors duration-fast hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
                  >
                    {folder.name}
                  </Link>
                </React.Fragment>
              ))}
              {folders.length > FOLDER_NAMES && `, +${folders.length - FOLDER_NAMES}`}
            </span>
          </p>
        )}

        <p className={cn("pj-annot mt-auto truncate", compact ? "pt-1.5" : "pt-4")}>{meta.join(" · ")}</p>
      </div>

      {hasActions && p.starred && (
        <span
          className="pj-pinned pointer-events-none absolute right-3 top-3 z-[2] grid size-7 place-items-center text-foreground/75 coarse:hidden"
          aria-hidden="true"
        >
          <Pin motion="none" weight="fill" className="size-3.5" />
        </span>
      )}

      {hasActions && (
        <div className="pj-actions absolute right-3 top-3 z-[2] flex items-center gap-0.5 rounded-full p-0.5">
          {onToggleStar && (
            <Pressable
              kind="icon"
              size="sm"
              aria-pressed={!!p.starred}
              aria-label={p.starred ? `Unpin ${p.name}` : `Pin ${p.name}`}
              title={p.starred ? "Unpin" : "Pin"}
              onClick={onToggleStar}
              className="rounded-full"
            >
              <IconSwap
                swapped={!!p.starred}
                from={<Pin motion="none" className="size-3.5" />}
                to={<Pin motion="none" weight="fill" className="size-3.5" />}
              />
            </Pressable>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" aria-label={`Actions for ${p.name}`} title="More" className="rounded-full">
                <ActionIcons.more className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_W}>
              {onToggleStar && (
                <DropdownMenuItem onSelect={onToggleStar}>
                  {p.starred ? <PinOff className="size-4" aria-hidden="true" /> : <Pin className="size-4" aria-hidden="true" />}
                  <span>{p.starred ? "Unpin" : "Pin"}</span>
                </DropdownMenuItem>
              )}
              {onNewFolder && (
                <DropdownMenuItem onSelect={onNewFolder} disabled={!canNest}>
                  <Plus className="size-4" aria-hidden="true" />
                  <span>New folder inside</span>
                </DropdownMenuItem>
              )}
              {onRename && (
                <DropdownMenuItem onSelect={onRename}>
                  <ActionIcons.edit className="size-4" aria-hidden="true" />
                  <span>Rename</span>
                </DropdownMenuItem>
              )}
              {onMove && (
                <DropdownMenuItem onSelect={onMove}>
                  <Folder className="size-4" aria-hidden="true" />
                  <span>Move to…</span>
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onDelete} variant="destructive">
                    <ActionIcons.delete className="size-4" aria-hidden="true" />
                    <span>Delete</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </article>
  );
}

/**
 * The Folders section's empty state: no dashed placeholder, an invitation in
 * the tile's own language. A cover plate drawn for this project's folders
 * (three spokes from the hub, the presence trajectory on its way round) next
 * to a serif line, a sentence and the one action. Where the tree is already
 * as deep as it goes, the action gives way to the reason, in mono.
 */
export function FoldersEmpty({
  projectId,
  projectName,
  onNewFolder,
  disabledReason,
}: {
  projectId: string;
  projectName: string;
  onNewFolder: () => void;
  disabledReason?: string | null;
}) {
  return (
    <div className="pj-empty grid items-center gap-5 @[34rem]/page:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)] @[34rem]/page:gap-7">
      <div className="pj-cover relative aspect-[16/7] w-full overflow-hidden rounded-card">
        <ProjectCover id={`${projectId}:folders`} folders={3} live aspect={16 / 7} />
      </div>
      <div className="min-w-0">
        <h3 className="pj-name-sm text-foreground">Arrange it in folders</h3>
        <p className="mt-1.5 max-w-[34ch] text-pretty text-ui leading-relaxed text-muted-foreground">
          A folder keeps one part of {projectName} together. Drag a chat onto it to file it there.
        </p>
        {disabledReason ? (
          <p className="pj-annot mt-4">{disabledReason}</p>
        ) : (
          <Button variant="outline" size="sm" className="mt-4" onClick={onNewFolder}>
            <Plus className="size-4" aria-hidden="true" /> New folder
          </Button>
        )}
      </div>
    </div>
  );
}

/** Why a folder can't hold another, or null. */
export function newFolderRefusal(projects: readonly FolderProject[], parentId: string): string | null {
  const check = validateNewChild(projects, parentId);
  if (check.ok) return null;
  return check.reason === "depth" ? `Folders nest ${MAX_PROJECT_DEPTH} deep at most` : MOVE_REFUSAL_MESSAGES[check.reason];
}

/** "Atlas launch / Research", for a project drawn out of place. */
export function pathOf(projects: readonly FolderProject[], id: string): string {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const names: string[] = [];
  let cursor = byId.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    names.unshift(byId.get(cursor)!.name);
    cursor = byId.get(cursor)!.parentId;
  }
  return names.length ? names.join(" / ") : "Top level";
}

export { depthOf };
