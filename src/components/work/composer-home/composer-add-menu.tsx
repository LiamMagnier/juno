"use client";

import * as React from "react";
import Link from "next/link";
import { AudioLines, FileUp, Loader2, Plus, Wrench } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { composerIconButtonClass } from "@/components/ui/composer-shell";
import type { ConnectorStatus } from "@/components/connections/types";
import type { ComposerProjectsState } from "@/components/work/composer-home/use-composer-projects";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { AppIcons } from "@/lib/app-icons";
import type { ClientWorkSkill } from "@/lib/work/skills";
import { cn } from "@/lib/utils";

/*
 * The + on a Work composer: what you hand THIS task, as opposed to what the run
 * standing behind it is scoped to.
 *
 * Two sections, and each one is here because it changes what the run can
 * actually do rather than because Claude's composer has a menu in this spot:
 *
 *   - **Attach** puts documents in front of the agent. `attachedSources` in
 *     scripts/work-runner.ts reads `Attachment.extractedText`, which is why the
 *     caller's file picker offers no images — see `WORK_ACCEPT_ATTRIBUTE`.
 *   - **Skills** names the skill the run operates under. There is no session
 *     field for it: `applySkill` reads a leading `/slug` off the goal, so this
 *     section writes into the textarea. See `skill-invocation.ts`.
 *
 * Two more sections sit under a hairline, and both are here because the row
 * they left carries no permanent badges any more:
 *
 *   - **Project** files the task, and is offered only while it is in none. Once
 *     a project is chosen the chip on the row is the fact (`ProjectChip`).
 *   - **Apps** narrows which connected apps the task may reach. It spent a
 *     release as a chip on the row and read "Apps" on every task, chosen or
 *     not; the count on its trigger here is the trace a granted app needs.
 *
 * And a last row, **Talk it through**, for the spoken conversation: the
 * primary action is Send and nothing else, so voice enters from here.
 *
 * Every section is optional and entirely prop-driven — no fetching, no state
 * beyond which submenu is open. That is deliberate and it is the reuse story:
 * the composer at the bottom of a running task needs the same menu against
 * different state, and a component that loaded its own lists would be a second
 * answer to "which skills do I have" arriving at a second moment. The owning
 * surface loads once and passes down.
 *
 * It lives under `composer-home/` because that is the directory the home
 * composer owns. It is written to be lifted out the day the thread composer
 * adopts it, and nothing in it knows which composer it is in.
 */

/** Documents. Omit to leave the section out — an account with no storage has none. */
export interface ComposerAttachSection {
  onFiles: () => void;
  onLibrary: () => void;
}

/** The skill this task names, and the ones it could name. */
export interface ComposerSkillsSection {
  /** Null while the list is in flight. */
  skills: readonly ClientWorkSkill[] | null;
  failed: boolean;
  onRetry: () => void;
  /** The skill currently named at the front of the goal, matched to the library. */
  invokedSlug: string | null;
  /** Null takes the name back off. */
  onInvoke: (slug: string | null) => void;
}

/**
 * Which connected apps this task may reach.
 *
 * Back in the [+] after a spell as a chip on the row. The row is now the
 * standing facts of THIS task — the project it is filed in, how often it asks,
 * the model — and an "Apps" chip that read "Apps" on every task, chosen or
 * not, was a permanent badge. The count still shows: on the section trigger.
 */
export interface ComposerAppsSection {
  /** Null while the list is in flight. */
  connectors: readonly ConnectorStatus[] | null;
  failed: boolean;
  onRetry: () => void;
  selected: readonly string[];
  onToggle: (connectorId: string) => void;
}

/**
 * Filing the task in a project, offered here only while it is in none.
 *
 * Once a project is chosen the chip on the row is the fact and the way to
 * change it (`ProjectChip`); this section is how the reader gets there.
 */
export interface ComposerProjectSection {
  projects: ComposerProjectsState;
  onPick: (project: { id: string; name: string }) => void;
}

export function ComposerAddMenu({
  disabled = false,
  attach,
  skills,
  apps,
  project,
  onTalk,
}: {
  disabled?: boolean;
  attach?: ComposerAttachSection;
  skills?: ComposerSkillsSection;
  apps?: ComposerAppsSection;
  project?: ComposerProjectSection;
  /**
   * Opens a spoken conversation about the task. Its absence is the gate: a
   * deployment with no voice relay passes nothing and gets no row.
   */
  onTalk?: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  /*
   * A section is drawn only once it has something in it, and that rule is
   * inherited rather than invented: the Apps chip this menu once absorbed
   * refused to render for an account with no linked apps, on the grounds that a
   * control opening onto "you have none" offers a choice that does not exist.
   * The same is true one level in. A list still in flight is treated as empty
   * for the same reason it was there — a row that appears is better than a row
   * that changes what it says — and a list that failed to load is treated as
   * full, because "Juno could not find out" is a sentence somebody is owed and a
   * Retry to act on.
   */
  const showSkills = skills !== undefined && (skills.failed || (skills.skills?.length ?? 0) > 0);
  const showApps = apps !== undefined && (apps.failed || (apps.connectors?.length ?? 0) > 0);
  // The project section is drawn even for an account with none: "New project"
  // is the one thing a reader with no projects can usefully do here.
  const showProject = project !== undefined && (project.projects.failed || project.projects.projects !== null);
  const showContext = showSkills || showApps || showProject;

  // Nothing to add, so no plus. An account with no storage and no skills had no
  // + at all before this menu existed, and drawing one that opens onto a heading
  // and two absences would be a new way of saying nothing.
  if (!attach && !showContext && !onTalk) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label="Add to this task"
          className={cn(composerIconButtonClass, "group relative")}
        >
          <Plus
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-4 transition-transform duration-base ease-out-strong group-data-[state=open]:rotate-45 motion-reduce:transition-none"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-60">
        <DropdownMenuLabel className="font-mono text-label">Add to this task</DropdownMenuLabel>

        {attach && (
          <>
            {/* Two rows rather than a submenu. The chat composer nests its
                equivalent because its + also holds canvas, projects and tools;
                here the parent would hold two children and cost a click that
                buys nothing. "Files" and not "Attach", because Photos is gone
                on this path and an "Attach" heading over a list with no images
                in it reads as a list that failed to load. */}
            <DropdownMenuItem onSelect={attach.onFiles}>
              <FileUp className="text-muted-foreground" />
              <span className="flex-1">Files</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={attach.onLibrary}>
              <AppIcons.library className="text-muted-foreground" />
              <span className="flex-1">From your library</span>
            </DropdownMenuItem>
          </>
        )}

        {/* One rule instead of a rule per pair: the hairline separates the
            documents this task is handed from the standing context it runs
            under, and it is drawn only when both halves are actually present. */}
        {attach && showContext && <DropdownMenuSeparator />}
        {showProject && project && <ProjectSubmenu section={project} />}
        {showApps && apps && <AppsSubmenu section={apps} />}
        {showSkills && skills && <SkillsSubmenu section={skills} />}

        {onTalk && (
          <>
            {(attach || showContext) && <DropdownMenuSeparator />}
            {/* The spoken conversation, reached from here now that the primary
                action is Send and nothing else. What a spoken line does is
                unchanged: it lands in the field, and nothing starts. */}
            <DropdownMenuItem onSelect={onTalk}>
              <AudioLines className="text-muted-foreground" />
              <span className="flex-1">Talk it through</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Filing the task. The list is the composer's (`useComposerProjects`), so the
 * chip that appears once something is picked names the same project.
 */
function ProjectSubmenu({ section }: { section: ComposerProjectSection }) {
  const { projects, onPick } = section;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <AppIcons.projects className="text-muted-foreground" />
        <span className="flex-1">Project</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(22rem,60vh)] w-60 flex-col p-0">
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
          ) : (projects.projects ?? []).length === 0 ? (
            <p className="px-2 py-3 text-caption leading-relaxed text-muted-foreground">
              No projects yet. A project carries its own instructions and files into every task
              filed in it.
            </p>
          ) : (
            (projects.projects ?? []).map((item) => (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => onPick({ id: item.id, name: item.name })}
              >
                <AppIcons.projects className="text-muted-foreground" />
                <span className="flex-1 truncate">{item.name}</span>
                <span className="font-mono text-caption text-muted-foreground">
                  {item.conversationCount}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </ScrollFade>
        <div className="shrink-0 border-t border-border/60 p-1.5">
          <DropdownMenuItem
            disabled={projects.creating}
            onSelect={(event) => {
              event.preventDefault();
              void projects.create().then((made) => {
                if (made !== null) onPick(made);
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
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Which connected apps this task may reach, all off by default.
 *
 * A linked app is an account-wide fact — the mailbox stays connected whether
 * or not this errand needs it — and a task that inherited every one of them
 * would be handed a mailbox, a repository and a calendar to do something that
 * needed none of the three. Nothing here links, unlinks or re-authorises
 * anything: it narrows one task inside what the account already permits, which
 * is why the footer sends the reader to /connections rather than offering to
 * connect an app from a composer. `evaluateConnector` refuses everything left
 * off with `not_selected_for_task`.
 */
function AppsSubmenu({ section }: { section: ComposerAppsSection }) {
  const { connectors, failed, onRetry, selected, onToggle } = section;
  const count = (connectors ?? []).filter((connector) => selected.includes(connector.id)).length;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <AppIcons.connections className={cn(count > 0 ? "text-primary" : "text-muted-foreground")} />
        <span className="flex-1">Apps</span>
        {count > 0 && (
          <span className="mr-1 font-mono text-caption tabular-nums text-primary">{count}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(22rem,60vh)] w-72 flex-col p-0">
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your connected apps. This task will reach none of them until it can.
              </p>
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (connectors ?? []).map((connector) => {
              const active = selected.includes(connector.id);
              return (
                <DropdownMenuItem
                  key={connector.id}
                  role="menuitemcheckbox"
                  aria-checked={active}
                  // Held open on select: turning two apps on is one decision, and
                  // a menu that closed after the first would make the reader
                  // reopen it to finish the sentence they were in the middle of.
                  onSelect={(event) => {
                    event.preventDefault();
                    onToggle(connector.id);
                  }}
                >
                  <AppIcons.connections
                    className={cn(active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex-1 truncate">{connector.label}</span>
                  <Switch checked={active} tabIndex={-1} aria-hidden className="pointer-events-none" />
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <p className="text-caption leading-relaxed text-muted-foreground">
            Off means this task cannot reach it. Your connections are unchanged —{" "}
            <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
              manage them
            </Link>
            .
          </p>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The skill this task runs under.
 *
 * A single choice rather than a set, because the runtime only has one: a goal
 * carries at most one leading `/slug`, `applySkill` resolves exactly one skill
 * per run, and a menu of switches would promise a stack of instructions the run
 * has no way to apply. Picking the one already named takes it back off, which
 * is the only way to undo the choice without editing the goal by hand.
 */
function SkillsSubmenu({ section }: { section: ComposerSkillsSection }) {
  const { skills, failed, onRetry, invokedSlug, onInvoke } = section;
  const chosen = (skills ?? []).find((skill) => skill.slug === invokedSlug) ?? null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Wrench className={cn(chosen ? "text-primary" : "text-muted-foreground")} />
        <span className="flex-1">Skill</span>
        {chosen && (
          <span className="mr-1 max-w-[7rem] truncate font-mono text-caption text-primary">
            /{chosen.slug}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(22rem,60vh)] w-64 flex-col p-0">
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your skills. This is empty because the request failed, not because you
                have none.
              </p>
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            // No loading state and no empty state: the caller does not draw this
            // row until the list has arrived with something in it.
            (skills ?? []).map((skill) => {
              const active = skill.slug === invokedSlug;
              return (
                <DropdownMenuItem
                  key={skill.id}
                  onSelect={() => onInvoke(active ? null : skill.slug)}
                >
                  <Wrench className={cn(active ? "text-primary" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{skill.name}</span>
                    <span className="block truncate font-mono text-micro text-muted-foreground">
                      /{skill.slug}
                    </span>
                  </span>
                  {active && <StatusIcons.success className="!size-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* What picking one actually does, said where the decision is made. The
            reader is about to watch text appear in their own textarea, and a
            menu that did that without warning would read as a bug. */}
        <div className="shrink-0 space-y-1 border-t border-border/60 px-3 py-2">
          <p className="text-caption leading-relaxed text-muted-foreground">
            Picking one writes its name at the front of the task, where you can edit or delete it.
          </p>
          <Link
            href="/work/skills"
            className="inline-block text-caption underline underline-offset-2 hover:text-foreground"
          >
            Manage skills
          </Link>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

