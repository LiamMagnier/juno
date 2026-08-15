"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { COMPOSER_CHIP_CLASS } from "@/components/work/composer-home/composer-chip";
import { cn } from "@/lib/utils";

/*
 * Filing a task into a Project, from the home composer's utility strip.
 *
 * Extracted from `work-composer.tsx` verbatim. It is the only control on that
 * surface that owns a fetch, a create, a dropdown and three renderings of
 * itself, and at two hundred lines it was longer than several of the composer's
 * siblings that already have their own files — `connectors-chip.tsx`,
 * `permission-chip.tsx`, `composer-add-menu.tsx`. It belongs with them.
 */

/** As much of `GET /api/projects` as a chip has any use for. */
interface ComposerProject {
  id: string;
  name: string;
  conversationCount: number;
}

/**
 * Files this task into a Project, so the project's instructions and files apply.
 *
 * An account with no projects gets a "New project" button rather than a chip
 * that opens onto an empty menu and an apology. The two are the same click
 * either way — the only thing a reader with no projects can usefully do here is
 * make one — and an empty dropdown is a promise of a list that does not exist.
 *
 * The list is loaded on mount rather than on open. It is one small GET against
 * a page that is already making two, and knowing whether the account has any
 * projects is what decides which of the two controls above is even rendered;
 * deferring it would mean rendering a dropdown first and swapping it out under
 * the reader's hand.
 */
export function ProjectChip({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  /**
   * The name travels with the id because this chip is the only holder of the
   * project list on the page, and two other things now need the name: the voice
   * briefing, which must not tell the model a filed task is unfiled. Handing it
   * over at the press is cheaper and less fallible than a second fetch.
   */
  onChange: (project: { id: string; name: string } | null) => void;
  disabled: boolean;
}) {
  const [projects, setProjects] = React.useState<ComposerProject[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("projects");
      const data = (await response.json()) as { projects?: ComposerProject[] };
      setProjects(data.projects ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A brand-new project is created unnamed — the API calls it "Untitled
  // project" and renames it from its first conversation — and filed against
  // this task straight away, so it behaves exactly like picking an existing one.
  const createAndPick = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? "Could not create the project.");
      setProjects((prev) => [
        { id: data.id!, name: "New project", conversationCount: 0 },
        ...(prev ?? []),
      ]);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      onChange({ id: data.id, name: "New project" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setCreating(false);
      setOpen(false);
    }
  }, [creating, onChange]);

  const selected = projects?.find((project) => project.id === value) ?? null;

  if (projects === null && !failed) {
    return (
      <button
        type="button"
        disabled
        className={COMPOSER_CHIP_CLASS}
        aria-hidden="true"
        tabIndex={-1}
      >
        <AppIcons.projects className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-muted-foreground">Project</span>
      </button>
    );
  }

  if (projects !== null && projects.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void createAndPick()}
        disabled={disabled || creating}
        className={COMPOSER_CHIP_CLASS}
      >
        {creating ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="truncate">New project</span>
      </button>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            selected ? `Project: ${selected.name}. Change it` : "File this task in a project"
          }
          className={COMPOSER_CHIP_CLASS}
        >
          <AppIcons.projects
            className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.name ?? "Project"}
          </span>
          <ChevronDown
            className="size-3 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      {/* `side="top"`. The chip used to sit ABOVE the field, where opening
          downward landed the menu over the textarea the reader was heading for;
          it is now on the strip along the composer's bottom edge, so the same
          direction would push the list down over the task list below. Every
          other control on this strip opens upward for the same reason. */}
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex max-h-[min(22rem,60vh)] w-60 flex-col p-0"
      >
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t load your projects. This is empty because the request failed, not because
                you have none.
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (projects ?? []).map((project) => {
              const active = project.id === value;
              return (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onChange(active ? null : { id: project.id, name: project.name })}
                >
                  <AppIcons.projects
                    className={cn(active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex-1 truncate">{project.name}</span>
                  {active ? (
                    <StatusIcons.success className="!size-3.5 text-primary" />
                  ) : (
                    <span className="font-mono text-caption text-muted-foreground">
                      {project.conversationCount}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* Pinned below the hairline so the list scrolls beneath it and starting
            a new project never falls off the bottom of a long one. */}
        <div className="shrink-0 border-t border-border/60 p-1.5">
          <DropdownMenuItem
            disabled={creating}
            onSelect={(event) => {
              // Hold the menu open through the create; `createAndPick` closes it
              // when it settles, whichever way it settles.
              event.preventDefault();
              void createAndPick();
            }}
          >
            {creating ? (
              <Loader2 className="animate-spin text-muted-foreground" />
            ) : (
              <Plus className="text-muted-foreground" />
            )}
            <span className="flex-1">New project</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
