"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Pin,
  NotebookPen,
  Sparkles,
  MessageCircle,
  Zap,
  Code2,
  FileText,
  Boxes,
} from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { CardEyebrow } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
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
    workCount: number;
    codeCount: number;
    fileCount: number;
    artifactCount: number;
  };
  isStarred: boolean;
  onToggleStar: () => void;
  onEditInstructions: () => void;
  onRename: (newName: string) => Promise<void>;
  onDelete: () => void;
  className?: string;
}

export function ProjectWorkspaceHeader({
  project,
  stats,
  isStarred,
  onToggleStar,
  onEditInstructions,
  onRename,
  onDelete,
  className,
}: ProjectWorkspaceHeaderProps) {
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState(project.name);

  React.useEffect(() => {
    setNameDraft(project.name);
  }, [project.name]);

  const handleSaveName = async () => {
    if (!nameDraft.trim() || nameDraft.trim() === project.name) {
      setEditingName(false);
      setNameDraft(project.name);
      return;
    }
    await onRename(nameDraft.trim());
    setEditingName(false);
  };

  return (
    <header className={cn("mb-6 flex flex-col gap-4", className)}>
      {/* Back button */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="-ml-2 gap-1.5 font-mono text-caption text-muted-foreground hover:text-foreground"
        >
          <Link href="/projects">
            <ArrowLeft className="size-3.5" /> All projects
          </Link>
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardEyebrow>Project Workspace</CardEyebrow>
            {project.instructions && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-micro text-primary">
                <Sparkles className="size-2.5" /> Custom Instructions
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            {editingName ? (
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                autoFocus
                onBlur={handleSaveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                aria-label="Project name"
                className="h-auto max-w-xl px-2.5 py-1 text-page-title font-serif font-medium"
              />
            ) : (
              <>
                <h1 className="truncate text-page-title font-serif font-medium text-foreground tracking-tight">
                  {project.name}
                </h1>
                <Pressable
                  kind="icon"
                  size="md"
                  onClick={() => {
                    setNameDraft(project.name);
                    setEditingName(true);
                  }}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Rename project"
                >
                  <ActionIcons.edit className="size-3.5" />
                </Pressable>
              </>
            )}
          </div>

          {/* Context Pillars Badges */}
          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-micro text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2.5 py-1 text-foreground/85">
              <MessageCircle className="size-3 text-primary" />
              {stats.chatCount} {stats.chatCount === 1 ? "chat" : "chats"}
            </span>

            {stats.workCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2.5 py-1 text-foreground/85">
                <Zap className="size-3 text-primary" />
                {stats.workCount} {stats.workCount === 1 ? "work run" : "work runs"}
              </span>
            )}

            {stats.codeCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2.5 py-1 text-foreground/85">
                <Code2 className="size-3 text-primary" />
                {stats.codeCount} {stats.codeCount === 1 ? "code session" : "code sessions"}
              </span>
            )}

            <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2.5 py-1 text-foreground/85">
              <FileText className="size-3 text-primary" />
              {stats.fileCount} {stats.fileCount === 1 ? "file" : "files"}
            </span>

            {stats.artifactCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2.5 py-1 text-foreground/85">
                <Boxes className="size-3 text-primary" />
                {stats.artifactCount} {stats.artifactCount === 1 ? "artifact" : "artifacts"}
              </span>
            )}

            <span className="text-muted-foreground/60">· Updated {timeAgo(project.updatedAt)}</span>
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onEditInstructions}
            className="h-8 gap-1.5 font-mono text-caption"
          >
            <NotebookPen className="size-3.5" />
            <span>Instructions</span>
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleStar}
            className="text-muted-foreground hover:text-foreground"
            aria-label={isStarred ? "Unpin project" : "Pin project"}
            aria-pressed={isStarred}
          >
            <Pin className={cn("size-4", isStarred && "fill-primary text-primary")} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Project actions"
              >
                <ActionIcons.more className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onSelect={() => {
                  setNameDraft(project.name);
                  setEditingName(true);
                }}
              >
                <ActionIcons.edit className="mr-2 size-4" />
                <span>Rename</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEditInstructions}>
                <NotebookPen className="mr-2 size-4" />
                <span>Edit instructions</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDelete}
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              >
                <ActionIcons.delete className="mr-2 size-4" />
                <span>Delete project</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
