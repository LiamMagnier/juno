"use client";

import * as React from "react";
import { Pin, NotebookPen } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pressable } from "@/components/ui/pressable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
  className,
}: ProjectWorkspaceHeaderProps) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState(project.name);
  const [renaming, setRenaming] = React.useState(false);

  const openRename = () => {
    setNameDraft(project.name);
    setRenameOpen(true);
  };

  const handleSaveName = async () => {
    const next = nameDraft.trim();
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
  const lede = (
    <span className="font-mono text-caption tabular-nums">
      {counts.join(" · ")} · Updated {timeAgo(project.updatedAt)}
    </span>
  );

  return (
    <>
      <AppPageHeader
        className={className}
        backHref="/projects"
        backLabel="Back to projects"
        eyebrow="Project"
        heading={<span className="min-w-0 truncate">{project.name}</span>}
        lede={lede}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onEditInstructions}
            >
              <NotebookPen className="size-3.5" aria-hidden="true" />
              Instructions
            </Button>

            <Pressable
              kind="icon"
              size="md"
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
                <Pressable kind="icon" size="md" aria-label="Project actions" title="Project actions">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_W}>
                <DropdownMenuItem onSelect={openRename}>
                  <ActionIcons.edit className="size-4" aria-hidden="true" />
                  <span>Rename</span>
                </DropdownMenuItem>
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

      <Dialog open={renameOpen} onOpenChange={(open) => { if (!open) setRenameOpen(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>Change the name of this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="project-rename">Project name</Label>
            <Input
              id="project-rename"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="New project name"
              autoFocus
              aria-label="Project name"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveName();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveName} disabled={renaming || !nameDraft.trim()}>
              {renaming ? "Renaming…" : "Rename project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
