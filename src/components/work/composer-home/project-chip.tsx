"use client";

import * as React from "react";
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
import type { ComposerProjectsState } from "@/components/work/composer-home/use-composer-projects";
import { cn } from "@/lib/utils";

/*
 * The project a task is filed in, as a chip on the composer's row.
 *
 * Drawn ONLY once a project is chosen. Filing an unfiled task lives in the
 * [+] menu (`ComposerAddMenu`'s project section), so the row carries no
 * permanent "Choose project" placeholder: a chip that names nothing is a badge,
 * and the row is for the standing facts of this task rather than for every
 * question it could be asked. Once a project is named the chip is the fact,
 * and opening it is how the reader changes or clears it.
 *
 * The list itself comes from `useComposerProjects`, owned by the composer and
 * shared with the [+], so the chip and the menu cannot disagree about which
 * projects exist.
 */
export function ProjectChip({
  value,
  projects,
  onChange,
  disabled,
}: {
  value: { id: string; name: string } | null;
  projects: ComposerProjectsState;
  /** Null unfiles the task. The name travels with the id for the voice briefing. */
  onChange: (project: { id: string; name: string } | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  if (value === null) return null;

  const name = projects.projects?.find((project) => project.id === value.id)?.name ?? value.name;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Project: ${name}. Change it`}
          className={COMPOSER_CHIP_CLASS}
        >
          <AppIcons.projects className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{name}</span>
          <ChevronDown
            className="size-3 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      {/* `side="top"`: the chip sits on the composer's bottom edge, and a menu
          opening downward would push the list over the task list below. */}
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex max-h-[min(22rem,60vh)] w-60 flex-col p-0"
      >
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {projects.failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t load your projects. This is empty because the request failed, not because
                you have none.
              </p>
              <Button variant="outline" size="sm" onClick={projects.reload} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (projects.projects ?? []).map((project) => {
              const active = project.id === value.id;
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
            disabled={projects.creating}
            onSelect={(event) => {
              // Hold the menu open through the create; it closes when the
              // create settles, whichever way it settles.
              event.preventDefault();
              void projects.create().then((made) => {
                if (made !== null) onChange(made);
                setOpen(false);
              });
            }}
          >
            {projects.creating ? (
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
