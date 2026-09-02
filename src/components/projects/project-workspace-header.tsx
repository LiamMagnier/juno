"use client";

import * as React from "react";
import { Pin, NotebookPen } from "lucide-react";
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
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { promptPreview } from "@/lib/prompt-preview";
import { cn } from "@/lib/utils";

interface ProjectWorkspaceHeaderProps {
  project: {
    id: string;
    name: string;
    instructions: string;
    starred: boolean;
    updatedAt: string;
  };
  stats: {
    chatCount: number;
    fileCount: number;
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
 * name as the heading, its instructions summarised on one line as the lede,
 * and the pin / instructions / actions cluster on the right. Renaming goes
 * through a dialog — the same one the projects grid uses — rather than an
 * inline-editable heading, so the two routes agree.
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

  const summary = promptPreview(project.instructions);
  const lede = summary ? (
    <span className="line-clamp-1" title={summary}>
      {summary}
    </span>
  ) : (
    <span className="font-mono text-caption tabular-nums">
      {plural(stats.chatCount, "chat")} · {plural(stats.fileCount, "file")} · Updated {timeAgo(project.updatedAt)}
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
              className="gap-1.5"
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
              className={cn(isStarred && "text-primary hover:text-primary")}
            >
              <Pin className={cn("size-4", isStarred && "fill-current")} aria-hidden="true" />
            </Pressable>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" size="md" aria-label="Project actions">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={openRename}>
                  <ActionIcons.edit className="mr-2 size-4" aria-hidden="true" />
                  <span>Rename</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onEditInstructions}>
                  <NotebookPen className="mr-2 size-4" aria-hidden="true" />
                  <span>Edit instructions</span>
                </DropdownMenuItem>
                {menuExtras && (
                  <>
                    <DropdownMenuSeparator />
                    {menuExtras}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onDelete}
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <ActionIcons.delete className="mr-2 size-4" aria-hidden="true" />
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
