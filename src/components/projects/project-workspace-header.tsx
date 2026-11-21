"use client";

import * as React from "react";
import { toast } from "sonner";
import { Folder, MessageSquarePlus, Pin, Plus, Settings } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
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
  onOpenChat: () => void;
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
}

export function ProjectWorkspaceHeader({
  project,
  isStarred,
  onToggleStar,
  onSaveDetails,
  onDelete,
  onOpenSettings,
  onOpenChat,
  menuExtras,
  breadcrumbs = [],
  onDropOnCrumb,
  acceptOnCrumb,
  onMove,
  onNewFolder,
  newFolderRefusal,
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

  const description = project.description.trim();

  return (
    <>
      <header className="pj-workspace-header">
        <ProjectBreadcrumbs crumbs={breadcrumbs} current={project.name} onDropInto={onDropOnCrumb} accept={acceptOnCrumb} />
        <div className="pj-title-row">
          <h1 className="pj-workspace-title">{project.name}</h1>
          <div className="pj-title-actions">
            <Pressable
              kind="icon"
              size="lg"
              onClick={onToggleStar}
              aria-pressed={isStarred}
              aria-label={isStarred ? "Unpin project" : "Pin project"}
              title={isStarred ? "Unpin project" : "Pin project"}
              className={isStarred ? "text-presence-ink" : "text-muted-foreground"}
            >
              <IconSwap swapped={isStarred} from={<Pin className="size-4" />} to={<Pin weight="fill" className="size-4" />} />
            </Pressable>

            {onOpenSettings && (
              <Pressable kind="icon" size="lg" onClick={onOpenSettings} aria-label="Settings" title="Settings" className="pj-desktop-settings text-muted-foreground">
                <Settings className="size-4" aria-hidden="true" />
              </Pressable>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" size="lg" aria-label="Project actions" title="Project actions">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_W}>
                <DropdownMenuItem onSelect={onOpenChat}>
                  <MessageSquarePlus className="size-4" aria-hidden="true" />
                  <span>New chat</span>
                </DropdownMenuItem>
                {onSaveDetails && (
                  <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
                    <ActionIcons.edit className="size-4" aria-hidden="true" />
                    <span>Edit details</span>
                  </DropdownMenuItem>
                )}
                {onOpenSettings && (
                  <DropdownMenuItem onSelect={onOpenSettings}>
                    <Settings className="size-4" aria-hidden="true" />
                    <span>Settings</span>
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
          </div>
        </div>
        {description && <p className="pj-workspace-description">{description}</p>}
      </header>

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
