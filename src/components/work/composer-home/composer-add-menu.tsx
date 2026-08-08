"use client";

import * as React from "react";
import Link from "next/link";
import { Check, FileUp, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import type { ConnectorStatus } from "@/components/connections/types";
import { AppIcons } from "@/lib/app-icons";
import type { ClientWorkSkill } from "@/lib/work/skills";
import { cn } from "@/lib/utils";

/*
 * The + on a Work composer: everything you can hand a task that is not the
 * sentence describing it.
 *
 * Three sections, and each one is here because it changes what the run can
 * actually do rather than because Claude's composer has a menu in this spot:
 *
 *   - **Attach** puts documents in front of the agent. `attachedSources` in
 *     scripts/work-runner.ts reads `Attachment.extractedText`, which is why the
 *     caller's file picker offers no images — see `WORK_ACCEPT_ATTRIBUTE`.
 *   - **Skills** names the skill the run operates under. There is no session
 *     field for it: `applySkill` reads a leading `/slug` off the goal, so this
 *     section writes into the textarea. See `skill-invocation.ts`.
 *   - **Apps** narrows which of the account's connected apps the task may
 *     reach. `evaluateConnector` refuses everything left off with
 *     `not_selected_for_task`.
 *
 * Every section is optional and entirely prop-driven — no fetching, no state
 * beyond which submenu is open. That is deliberate and it is the reuse story:
 * the composer at the bottom of a running task needs the same menu with the
 * same three sections against different state, and a component that loaded its
 * own lists would be a second answer to "is Gmail linked" arriving at a second
 * moment. The owning surface loads once and passes down, exactly as
 * `useConnectedApps` already does for the three things on the home composer
 * that need it.
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

/** Which connected apps this task may reach. */
export interface ComposerAppsSection {
  /** Null while the list is in flight. */
  connectors: readonly ConnectorStatus[] | null;
  failed: boolean;
  onRetry: () => void;
  selected: readonly string[];
  onToggle: (connectorId: string) => void;
}

export function ComposerAddMenu({
  disabled = false,
  attach,
  skills,
  apps,
}: {
  disabled?: boolean;
  attach?: ComposerAttachSection;
  skills?: ComposerSkillsSection;
  apps?: ComposerAppsSection;
}) {
  const [open, setOpen] = React.useState(false);

  /*
   * A section is drawn only once it has something in it, and that rule is
   * inherited rather than invented: the Apps chip this menu absorbed refused to
   * render for an account with no linked apps, on the grounds that a control
   * opening onto "you have none" offers a choice that does not exist. The same
   * is true one level in. A list still in flight is treated as empty for the
   * same reason it was there — a row that appears is better than a row that
   * changes what it says — and a list that failed to load is treated as full,
   * because "Juno could not find out" is a sentence somebody is owed and a
   * Retry to act on.
   */
  const showSkills = skills !== undefined && (skills.failed || (skills.skills?.length ?? 0) > 0);
  const showApps = apps !== undefined && (apps.failed || (apps.connectors?.length ?? 0) > 0);

  const selectedApps = (apps?.connectors ?? []).filter((connector) =>
    apps?.selected.includes(connector.id)
  );
  // Only what the reader chose gets a dot, and only apps qualify. An attachment
  // already shows as a chip above the textarea and a named skill is visible in
  // the goal itself, so a dot for either would mark something the reader can
  // already see. A granted app is the one choice in here with no other trace on
  // the surface until the run disclosure resolves.
  const marked = selectedApps.length > 0;

  // Nothing to add, so no plus. An account with no storage, no skills and no
  // connected apps had no + at all before this menu existed, and drawing one
  // that opens onto a heading and three absences would be a new way of saying
  // nothing.
  if (!attach && !showSkills && !showApps) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={
            marked
              ? `Add to this task — ${selectedApps
                  .map((connector) => connector.label)
                  .join(", ")} switched on`
              : "Add to this task"
          }
          className={cn(
            "composer-add-button group relative shrink-0 rounded-[11px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
            open && "bg-accent"
          )}
        >
          <Plus
            aria-hidden="true"
            strokeWidth={1.75}
            className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
          />
          {marked && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card motion-safe:animate-fade-in"
            />
          )}
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

        {/* One rule instead of a rule per pair: the hairline separates "things
            you give this task" from "things you let it reach", and it is drawn
            only when both halves are actually present. */}
        {attach && (showSkills || showApps) && <DropdownMenuSeparator />}
        {showSkills && skills && <SkillsSubmenu section={skills} />}
        {showApps && apps && <AppsSubmenu section={apps} />}
      </DropdownMenuContent>
    </DropdownMenu>
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
        <Sparkles className={cn(chosen ? "text-primary" : "text-muted-foreground")} />
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
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
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
                  <Sparkles className={cn(active ? "text-primary" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{skill.name}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                      /{skill.slug}
                    </span>
                  </span>
                  {active && <Check className="!size-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* What picking one actually does, said where the decision is made. The
            reader is about to watch text appear in their own textarea, and a
            menu that did that without warning would read as a bug. */}
        <div className="shrink-0 space-y-1 border-t border-border/60 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Picking one writes its name at the front of the task, where you can edit or delete it.
          </p>
          <Link
            href="/work/skills"
            className="inline-block text-[12px] underline underline-offset-2 hover:text-foreground"
          >
            Manage skills
          </Link>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Which connected apps this task may reach.
 *
 * Off by default, all of them, and that is the design rather than a cautious
 * setting somebody relaxes later. A linked app is an account-wide fact — the
 * mailbox stays connected whether or not this errand needs it — and a task that
 * inherited every one of them would be handed a mailbox, a repository and a
 * calendar to do something that needed none of the three.
 *
 * Nothing here links, unlinks or re-authorises anything. It narrows one task
 * inside what the account already permits, which is why the footer sends the
 * reader to /connections rather than offering to connect an app from a
 * composer.
 */
function AppsSubmenu({ section }: { section: ComposerAppsSection }) {
  const { connectors, failed, onRetry, selected, onToggle } = section;
  const count = (connectors ?? []).filter((connector) => selected.includes(connector.id)).length;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <AppIcons.connections
          className={cn(count > 0 ? "text-primary" : "text-muted-foreground")}
        />
        <span className="flex-1">Apps</span>
        {count > 0 && <span className="mr-1 font-mono text-caption text-primary">{count}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(22rem,60vh)] w-72 flex-col p-0">
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your connected apps. This task will reach none of them until it can.
              </p>
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            // Same as the skills list above: the caller does not draw this row
            // until there is something in it, so there is nothing to say here
            // about loading or about an account with no apps.
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
                  <Switch
                    checked={active}
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none"
                  />
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* The rule, said once, where the decision is made. Neither sentence is
            decoration: the first is why an app being linked is not enough on its
            own, and the second is what stops a reader reading this as a switch
            that disconnects things. */}
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Off means this task cannot reach it. Your connections are unchanged —{" "}
            <Link
              href="/connections"
              className="underline underline-offset-2 hover:text-foreground"
            >
              manage them
            </Link>
            .
          </p>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
