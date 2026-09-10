"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ModelSelector } from "@/components/chat/model-selector";
import { WorkPermissionChip } from "@/components/work/composer-home/permission-chip";
import { COMPOSER_CHIP_CLASS } from "@/components/work/composer-home/composer-chip";
import type { ComposerProjectsState } from "@/components/work/composer-home/use-composer-projects";
import type { WorkThreadContextState } from "@/components/work/composer/use-work-thread-context";
import { AppIcons } from "@/lib/app-icons";
import { REASONING_TIERS, type ReasoningEffort, clampReasoningEffort } from "@/lib/model-metrics";
import { resolveModel, type ModelId } from "@/lib/models";
import { isWorkCapableModel } from "@/lib/work/models";
import { cn } from "@/lib/utils";

/*
 * The controls beside the box at the bottom of a running task: which model, how
 * often it asks, and where it is filed.
 *
 * These used to exist only on the home composer, which meant every one of them
 * was a decision that could be made once and never revisited — a task started on
 * the wrong model, or on Skip, could only be corrected by starting a different
 * task. The three here write through `PATCH /sessions/[id]/context` and are the
 * same three controls wearing the same components, so a reader who has set a
 * model on the home composer has already learned this one.
 *
 * ── They are exported as two groups, not one ───────────────────────────────
 *
 * They used to be one flex-wrap row, and the composer put it in the same row as
 * the mic and the send button. That is the ranking error `ComposerShell` was
 * written to fix: "which project this task belongs to" and "send" sat at
 * identical weight, and the row rewrapped under the reader's hand as the run
 * context changed. So the model — which is spent on the next attempt, like the
 * message itself — stays inline, and the two that describe the standing state of
 * the task go below the hairline, where the home composer now keeps the same
 * pair.
 *
 * ── The line underneath is the point ───────────────────────────────────────
 *
 * A run's model, effort and permission policy bind when its agent loop is
 * constructed, so changing them while it runs does not reach it. That is stated
 * before the change, as a standing line under the row, and again after it in the
 * server's own words — see `useWorkThreadContext`. Neither sentence is
 * decoration: the failure this whole path is built to avoid is a control that
 * animates into its new state while the attempt carries on exactly as before.
 *
 * Everything is held while a change is in flight rather than left live. One
 * request at a time is what makes the rollback on failure exact: with two
 * overlapping, restoring "the values from before" restores the wrong ones.
 */

/** The stored effort, if it is one this build knows. Anything else is Instant. */
function asEffort(raw: string | null): ReasoningEffort {
  return raw !== null && (REASONING_TIERS as readonly string[]).includes(raw)
    ? (raw as ReasoningEffort)
    : null;
}

/**
 * The inline half: which model this task's next attempt runs on.
 *
 * Alone in here because it is the only one of the three that belongs to the
 * message being written rather than to the task. The thinking effort has no
 * separate button on this surface — it is the slider inside the picker's own
 * panel — which is deliberate: a running task's composer is a narrow strip and a
 * second fixed-width control for a value the picker already shows would cost the
 * model name its room on a phone.
 */
export function WorkThreadModelControl({ context }: { context: WorkThreadContextState }) {
  const held = context.saving;
  const resolved = resolveModel(context.model);
  /*
   * The effort this model would honour, not the one the session happens to hold.
   *
   * The same clamp the home composer applies for the same reason: a session
   * created on a flagship at Max and moved onto a model that stops at High would
   * otherwise show a tier the picker below it does not list.
   */
  const effort: ReasoningEffort = React.useMemo(() => {
    const stored = asEffort(context.reasoningEffort);
    return resolved ? clampReasoningEffort(resolved, stored) : stored;
  }, [context.reasoningEffort, resolved]);

  const changeModel = React.useCallback(
    (next: ModelId) => {
      const info = resolveModel(next);
      const clamped = info ? clampReasoningEffort(info, effort) : effort;
      // Sent together when the model change drops the tier, because they are
      // one decision: a second request would produce a second note under the
      // row about a change the reader did not make.
      context.change({
        model: next,
        ...(clamped === effort ? {} : { reasoningEffort: clamped }),
      });
    },
    [context, effort]
  );

  return (
    // Only the models the Work runner can drive. A plan-locked one stays in the
    // list wearing its lock and sending the reader to /upgrade — the picker's
    // own behaviour, and the reason this is that component rather than a smaller
    // one written for a strip.
    <div className={cn("min-w-0 shrink-0", held && "pointer-events-none opacity-60")}>
      <ModelSelector value={context.model} onChange={changeModel} filter={isWorkCapableModel} />
    </div>
  );
}

/**
 * The standing half: where this task is filed (once it is), and how often it
 * stops to ask.
 *
 * Both survive the send. Both are still true of the message after this one, and
 * of the attempt after that. The home composer keeps the identical pair in the
 * identical place, wearing the identical chips.
 *
 * The spinner is here rather than beside whichever control was used because
 * `useWorkThreadContext` permits exactly one change in flight at a time: a
 * single indicator for the strip states that fact, where one per chip would
 * imply they could be saving independently.
 */
export function WorkThreadRunContext({
  context,
  projects,
}: {
  context: WorkThreadContextState;
  projects: ComposerProjectsState;
}) {
  const held = context.saving;
  return (
    <>
      {/* Only once the task is in a project. Filing an unfiled task is a row in
          the [+] (`WorkThreadAddPanel`'s project section); a chip reading
          "Project" on every task was a permanent badge. */}
      {context.projectId !== null && (
        <ThreadProjectChip
          value={context.projectId}
          projects={projects}
          onChange={(projectId) => context.change({ projectId })}
          disabled={held}
        />
      )}

      <WorkPermissionChip
        value={context.permissionPolicy}
        onChange={(policy) => context.change({ permissionPolicy: policy })}
        disabled={held}
      />

      {held && (
        <Loader2
          className="ml-0.5 size-3 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      )}
    </>
  );
}

/**
 * The one quiet line: what a change here will do, then what it did.
 *
 * Drawn separately from the row so the composer can keep it on its own line at
 * every width — a caveat that wrapped in beside the chips would be read as a
 * label for whichever one it landed next to.
 *
 * It sits BELOW the composer now rather than inside it, and that follows from
 * the strip it comments on. The utility tier is one row of controls that does
 * not scroll and does not wrap; a sentence in there would either wrap the tier
 * or be truncated to nothing. Under the shell it also lands where every other
 * "what will actually happen" line in Work lives, which is where a reader has
 * learned to look for one.
 */
export function WorkThreadControlsNote({
  context,
  live,
}: {
  context: WorkThreadContextState;
  live: boolean;
}) {
  // Before any change, the standing rule; after one, the server's answer for
  // the field that changed. With nothing running there is no attempt to miss,
  // so the standing caveat would be a warning about nothing.
  const line =
    context.note ??
    (live ? "Changes here apply to the next attempt, not the one running." : null);
  if (line === null) return null;
  return (
    <p
      aria-live="polite"
      className="px-1.5 pt-1.5 font-mono text-micro leading-relaxed text-muted-foreground"
    >
      {line}
    </p>
  );
}

/**
 * Where this task is filed, once it is filed somewhere.
 *
 * The list is the composer's (`useComposerProjects`), shared with the [+]
 * panel's project section, so the chip cannot name a project the section did
 * not offer. A task filed in a project whose name has not arrived says so
 * rather than reading as unfiled.
 *
 * No "New project" row, unlike the home composer's. Filing a running task into a
 * project that was created for it in the same gesture is two decisions dressed
 * as one.
 */
function ThreadProjectChip({
  value,
  projects: list,
  onChange,
  disabled,
}: {
  value: string;
  projects: ComposerProjectsState;
  onChange: (projectId: string | null) => void;
  disabled: boolean;
}) {
  const { projects, failed, reload } = list;
  const selected = projects?.find((project) => project.id === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Project: ${selected?.name ?? "in a project"}. Change it`}
          className={COMPOSER_CHIP_CLASS}
        >
          <AppIcons.projects className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">
            {/* A task filed in a project whose name has not arrived says so
                rather than reading as unfiled. */}
            {selected?.name ?? "In a project"}
          </span>
          <ChevronDown
            className="size-3 shrink-0 transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
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
              <Button variant="outline" size="sm" onClick={reload} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (projects ?? []).map((project) => {
              const active = project.id === value;
              return (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onChange(active ? null : project.id)}
                >
                  <AppIcons.projects
                    className={cn(active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex-1 truncate">{project.name}</span>
                  {active && <StatusIcons.success className="!size-3.5 text-primary" />}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
