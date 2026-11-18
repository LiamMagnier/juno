"use client";

import * as React from "react";
import { toast } from "sonner";
import { Folder, Pin, Plus, Settings } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page";
import { Pressable } from "@/components/ui/pressable";
import { ProjectBreadcrumbs, type ProjectDrag } from "@/components/projects/project-folders";
import { ProjectDetailsDialog } from "@/components/projects/project-details-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";

interface ProjectWorkspaceHeaderProps {
  project: {
    id: string;
    name: string;
    description: string;
    starred: boolean;
    updatedAt: string;
  };
  isStarred: boolean;
  onToggleStar: () => void;
  /** Absent for a reader who cannot edit (a VIEWER). */
  onSaveDetails?: (details: { name: string; description: string }) => Promise<void>;
  onDelete?: () => void;
  /** Model, tools and task defaults: the project's settings view. */
  onOpenSettings?: () => void;
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
 * The project page's opening, at the head of its left column: the way back,
 * the project's name in the house serif, and under it what the project is
 * for, in the owner's words. Pin and the actions menu sit on the name's line.
 *
 * The description replaces the line of counts this header used to carry
 * ("3 chats · 4 sources · Updated today"): the chats are listed right under
 * the composer and the knowledge has its own panel, so the counts said again
 * what the page already shows. A project with no description offers to add
 * one in the same place, quietly, to its owner.
 *
 * Name and description are edited together in one dialog (Edit details), the
 * same form that creates a project, so the two routes agree.
 */
export function ProjectWorkspaceHeader({
  project,
  isStarred,
  onToggleStar,
  onSaveDetails,
  onDelete,
  onOpenSettings,
  menuExtras,
  breadcrumbs = [],
  onDropOnCrumb,
  acceptOnCrumb,
  onMove,
  onNewFolder,
  newFolderRefusal,
  className,
}: ProjectWorkspaceHeaderProps) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const saveDetails = async (details: { name: string; description: string }) => {
    if (!onSaveDetails) return;
    if (!details.name || (details.name === project.name && details.description === project.description)) {
      setDetailsOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onSaveDetails(details);
      setDetailsOpen(false);
    } catch {
      toast.error("Couldn’t save these details. Nothing has changed.");
    } finally {
      setSaving(false);
    }
  };

  const parent = breadcrumbs[breadcrumbs.length - 1];
  const description = project.description.trim();
  const lede = description ? (
    <span className="block whitespace-pre-line break-words">{description}</span>
  ) : onSaveDetails ? (
    <button
      type="button"
      onClick={() => setDetailsOpen(true)}
      className="-mx-1 rounded-xs px-1 text-muted-foreground underline-offset-4 transition-colors duration-fast hover:text-foreground hover:underline"
    >
      Add a description
    </button>
  ) : null;

  return (
    <>
      <AppPageHeader
        className={cn("pj-head", className)}
        backHref={parent ? `/projects/${parent.id}` : "/projects"}
        backLabel={parent ? `Back to ${parent.name}` : "All projects"}
        eyebrow={
          <ProjectBreadcrumbs crumbs={breadcrumbs} current={project.name} onDropInto={onDropOnCrumb} accept={acceptOnCrumb} />
        }
        heading={<span className="block min-w-0 break-words">{project.name}</span>}
        lede={lede}
        actions={
          <>
            <Pressable
              kind="icon"
              size="lg"
              onClick={onToggleStar}
              selected={isStarred}
              aria-pressed={isStarred}
              aria-label={isStarred ? "Unpin project" : "Pin project"}
              title={isStarred ? "Unpin project" : "Pin project"}
            >
              <IconSwap swapped={isStarred} from={<Pin className="size-4" />} to={<Pin weight="fill" className="size-4" />} />
            </Pressable>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" size="lg" aria-label="Project actions" title="Project actions">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_W}>
                {onSaveDetails && (
                  <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
                    <ActionIcons.edit className="size-4" aria-hidden="true" />
                    <span>Edit details</span>
                  </DropdownMenuItem>
                )}
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
                {onOpenSettings && (
                  <DropdownMenuItem onSelect={onOpenSettings}>
                    <Settings className="size-4" aria-hidden="true" />
                    <span>Settings</span>
                  </DropdownMenuItem>
                )}
                {menuExtras && (
                  <>
                    <DropdownMenuSeparator />
                    {menuExtras}
                  </>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onDelete} variant="destructive">
                      <ActionIcons.delete className="size-4" aria-hidden="true" />
                      <span>Delete project</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <ProjectDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        mode="edit"
        initialName={project.name}
        initialDescription={project.description}
        busy={saving}
        onSubmit={(details) => void saveDetails(details)}
      />
    </>
  );
}
