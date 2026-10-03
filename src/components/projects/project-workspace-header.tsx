"use client";

import * as React from "react";
import { Folder, Pin, NotebookPen, Plus } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import {
  ProjectBreadcrumbs,
  ProjectNameDialog,
  type ProjectDrag,
} from "@/components/projects/project-folders";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";

interface ProjectWorkspaceHeaderProps {
  project: {
    id: string;
    name: string;
    starred: boolean;
    updatedAt: string;
  };
  /** Every number here renders. See `counts` below for which ones at zero. */
  stats: {
    chatCount: number;
    fileCount: number;
    workCount?: number;
    codeCount?: number;
    artifactCount?: number;
  };
  isStarred: boolean;
  onToggleStar: () => void;
  onEditInstructions: () => void;
  onRename: (newName: string) => Promise<void>;
  onDelete: () => void;
  /** Extra entries for the actions menu, placed before the destructive group. */
  menuExtras?: React.ReactNode;
  /** The folders above this project, root first (owner only). */
  breadcrumbs?: { id: string; name: string }[];
  /** Drop a folder or a chat on a crumb to move it there. */
  onDropOnCrumb?: (targetId: string | null, drag: ProjectDrag) => void;
  acceptOnCrumb?: (drag: ProjectDrag, targetId: string | null) => boolean;
  onMove?: () => void;
  onNewFolder?: () => void;
  /** Why a folder can't be made here (too deep), or null. */
  newFolderRefusal?: string | null;
  className?: string;
}

/**
 * The project page's opening: the shared `<AppPageHeader>` with the project's
 * name as the heading, what it holds counted on one line as the lede, and the
 * pin / instructions / actions cluster on the right. Renaming goes through a
 * dialog — the same one the projects grid uses — rather than an
 * inline-editable heading, so the two routes agree.
 *
 * No mark beside the title, including for a project that has a cover image.
 * PREMIUM_AUDIT §2b's rule is that glyphs mark destinations and a page title
 * is a document; the cover is drawn once, at the head of the Overview rail,
 * where it is the project's picture rather than a second, larger copy of the
 * sidebar row that got you here.
 */
export function ProjectWorkspaceHeader({
  project,
  stats,
  isStarred,
  onToggleStar,
  onEditInstructions,
  onRename,
  onDelete,
  menuExtras,
  breadcrumbs = [],
  onDropOnCrumb,
  acceptOnCrumb,
  onMove,
  onNewFolder,
  newFolderRefusal,
  className,
}: ProjectWorkspaceHeaderProps) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);

  const openRename = () => setRenameOpen(true);

  const handleSaveName = async (draft: string) => {
    const next = draft.trim();
    if (!next || next === project.name) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await onRename(next);
      setRenameOpen(false);
    } finally {
      setRenaming(false);
    }
  };

  /**
   * What this project IS, in numbers, under its name.
   *
   * This line used to be `promptPreview(project.instructions)` with the stats
   * as a fallback — and the fallback was unreachable. `promptPreview` returns
   * the string "No instructions set." when there are none, which is truthy, so
   * the ternary took the summary branch on every project in the product: a
   * project with instructions repeated a sentence the Overview rail already
   * shows in full 300px below, and one without them printed "No instructions
   * set." under its title as the single most prominent fact about it. Four of
   * the five numbers this component is handed had never rendered at all.
   *
   * Chats and sources are always drawn, including at zero, so the line keeps
   * one shape as a project fills up rather than growing a segment at a time.
   * Tasks and code sessions join only once they exist — most projects never
   * have either, and a permanent "0 tasks" is a column of zeros teaching the
   * reader to stop reading the line.
   */
  const counts = [
    plural(stats.chatCount, "chat"),
    plural(stats.fileCount + (stats.artifactCount ?? 0), "source"),
    ...(stats.workCount ? [plural(stats.workCount, "task")] : []),
    ...(stats.codeCount ? [plural(stats.codeCount, "code session")] : []),
  ];
  // Mono, like every count in the editorial pages: figures read at a glance.
  const lede = (
    <span className="pj-annot flex flex-wrap gap-x-4 gap-y-1">
      {counts.map((count) => (
        <span key={count}>{count}</span>
      ))}
      <span>Updated {timeAgo(project.updatedAt)}</span>
    </span>
  );
  const parent = breadcrumbs[breadcrumbs.length - 1];

  return (
    <>
      <AppPageHeader
        className={className}
        backdrop
        backHref={parent ? `/projects/${parent.id}` : "/projects"}
        backLabel={parent ? `Back to ${parent.name}` : "Back to projects"}
        eyebrow={
          <ProjectBreadcrumbs
            crumbs={breadcrumbs}
            current={project.name}
            onDropInto={onDropOnCrumb}
            accept={acceptOnCrumb}
          />
        }
        heading={<span className="block min-w-0 truncate tracking-[-0.03em]">{project.name}</span>}
        lede={lede}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={onEditInstructions}
              aria-label="Instructions"
              title="Instructions"
              // On a phone the label folds into the mark, so the three
              // actions stay on the title's line instead of wrapping between
              // the title and its lede.
              className="w-9 border-foreground/[.12] px-0 coarse:w-11 @[40rem]/page:w-auto @[40rem]/page:px-4"
            >
              <NotebookPen className="size-4" aria-hidden="true" />
              <span className="hidden @[40rem]/page:inline">Instructions</span>
            </Button>

            <Pressable
              kind="icon"
              size="lg"
              onClick={onToggleStar}
              selected={isStarred}
              aria-pressed={isStarred}
              aria-label={isStarred ? "Unpin project" : "Pin project"}
              title={isStarred ? "Unpin project" : "Pin project"}
              className={cn(isStarred && "text-primary hover:text-primary")}
            >
              <IconSwap
                swapped={isStarred}
                from={<Pin className="size-4" />}
                to={<Pin weight="fill" className="size-4" />}
              />
            </Pressable>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" size="lg" aria-label="Project actions" title="Project actions">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_W}>
                <DropdownMenuItem onSelect={openRename}>
                  <ActionIcons.edit className="size-4" aria-hidden="true" />
                  <span>Rename</span>
                </DropdownMenuItem>
                {onNewFolder && (
                  <DropdownMenuItem onSelect={onNewFolder} disabled={!!newFolderRefusal}>
                    <Plus className="size-4" aria-hidden="true" />
                    <span>New folder inside</span>
                  </DropdownMenuItem>
                )}
                {onMove && (
                  <DropdownMenuItem onSelect={onMove}>
                    <Folder className="size-4" aria-hidden="true" />
                    <span>Move to…</span>
                  </DropdownMenuItem>
                )}
                {/* No "Edit instructions" item. The outline Instructions button
                    ~50px to the left of this menu is the same handler with the
                    same glyph and a standing hit target; a menu whose items
                    duplicate the buttons beside it teaches the reader that the
                    menu is where the leftovers go. */}
                {menuExtras && (
                  <>
                    <DropdownMenuSeparator />
                    {menuExtras}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onDelete}
                  variant="destructive"
                >
                  <ActionIcons.delete className="size-4" aria-hidden="true" />
                  <span>Delete project</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <ProjectNameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        mode="rename"
        initialName={project.name}
        busy={renaming}
        onSubmit={(name) => void handleSaveName(name)}
      />
    </>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
