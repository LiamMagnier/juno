"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight, MoreHorizontal } from "@/components/ui/icons";
import { Collapse } from "@/components/ui/collapse";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GitHubMark } from "@/components/connections/connector-logos";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { sourceLabel, type LibrarySkill, type LibrarySource } from "@/lib/skills/library-contract";
import { staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";
import {
  SkillRow,
  skillLibraryLeadClass,
  skillLibraryRowClass,
  skillLibraryTailClass,
} from "@/components/skills/skill-row";
import { sourceAttention, sourceCounts, sourceHasUpdate } from "@/components/skills/skill-library-model";

/** The DOM id a group is scrolled to after an install lands in it. */
export function skillSourceAnchor(sourceId: string): string {
  return `skill-source-${sourceId}`;
}

/**
 * One installed repository: a folder row, and its skills inside it.
 *
 * THE SOURCE IS WHAT YOU INSTALL, UPDATE AND REMOVE; THE SKILL IS WHAT YOU
 * SWITCH ON AND CALL. So the verbs split the same way the rows do: the group
 * carries the master switch and the overflow menu (Check for updates, View on
 * GitHub, Remove), and each child carries only its own switch. The master
 * switch never rewrites the children — a source switched off hides every skill
 * in it from chat without touching their own switches, which is why turning it
 * back on restores exactly the set that was on before.
 *
 * THE WHOLE ROW DISCLOSES. The name is the disclosure button, stretched over
 * the row the way a skill row's link is, so a press anywhere that is not a
 * control opens the folder; the switch, the menu and the update marker are
 * raised above it.
 *
 * MOTION. The folder unfolds through `Collapse` (grid rows, the symmetric
 * curve) while the caret turns a quarter on the same curve. The children rise
 * into place on the FIRST open only, dealt 30ms apart and capped: the first
 * open is a reveal, and every open after it is the reader returning to a list
 * they have already seen, which should simply be there. Nothing loops; the
 * update marker is a static dot.
 */
export function SkillSourceGroup({
  source,
  skills,
  expanded,
  onExpandedChange,
  onToggleSource,
  onToggleSkill,
  onCheckUpdates,
  onRemove,
  skillHref,
  highlight = false,
  className,
  style,
}: {
  source: LibrarySource;
  /** The children to draw: every skill, or the ones a search left. */
  skills: LibrarySkill[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onToggleSource: (enabled: boolean) => void;
  onToggleSkill: (skill: LibrarySkill, enabled: boolean) => void;
  onCheckUpdates: () => void;
  onRemove: () => void;
  skillHref: (skill: LibrarySkill) => string;
  /** Just installed into: the row holds the selected tone once and lets it go. */
  highlight?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduce = useReducedMotion() ?? false;
  const label = sourceLabel(source);
  const { total, on } = sourceCounts(source);
  const update = sourceHasUpdate(source);
  const attention = sourceAttention(source);
  const bodyId = `${skillSourceAnchor(source.id)}-skills`;

  // Whether the children have been revealed once already. Read during render
  // and written after it, so the render that first opens the folder still
  // sees `false` and deals the rows in.
  const revealed = React.useRef(false);
  const firstReveal = expanded && !revealed.current;
  React.useEffect(() => {
    if (expanded) revealed.current = true;
  }, [expanded]);

  return (
    <div
      role="listitem"
      id={skillSourceAnchor(source.id)}
      className={cn("relative isolate scroll-mt-24", className)}
      style={style}
    >
      {highlight ? (
        // The change the reader did not directly cause: where their new skills
        // went. The selected tone, held for a beat and then let go on the
        // emphasis rung, once. Opacity only, under the row's own content.
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-selected"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ ...transition.emphasis, delay: reduce ? 0.6 : 0.9 }}
        />
      ) : null}

      <div className={skillLibraryRowClass}>
        <span className={cn(skillLibraryLeadClass, "transition-opacity duration-fast ease-out-soft", !source.enabled && "opacity-60")}>
          <SkillSourceAvatar owner={source.owner} size="md" />
        </span>

        <div className={cn("min-w-0 flex-1 transition-opacity duration-fast ease-out-soft", !source.enabled && "opacity-60")}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => onExpandedChange(!expanded)}
            className="block max-w-full truncate text-left text-body font-medium leading-snug text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
          >
            <span translate="no">{label}</span>
          </button>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-ui text-muted-foreground">
            {/* The counts are one unit, so a narrow row wraps between them and
                the update marker, never inside them. */}
            <span className="inline-flex items-center gap-x-1.5 whitespace-nowrap">
              <span>
                <span className="tabular-nums">{total}</span> {total === 1 ? "skill" : "skills"}
              </span>
              <span aria-hidden="true">·</span>
              {source.enabled ? (
                <span>
                  <span className="tabular-nums">{on}</span> on
                </span>
              ) : (
                <span>Off</span>
              )}
            </span>
            {update ? (
              // Static: a dot that pulses would be a loop with no live state
              // behind it. It is a real button, raised above the row's
              // disclosure, because it is also the shortest way to the update.
              // No "·" before it: its own dot is the separator, so on a narrow
              // row that wraps it to a line of its own nothing dangles at the
              // end of the line above.
              <button
                type="button"
                onClick={onCheckUpdates}
                className="relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-xs font-medium text-primary-ink underline-offset-2 hover:underline"
              >
                Update available
              </button>
            ) : null}
          </p>
        </div>

        {attention ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label="A skill in this source needs attention"
                className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full text-warning-foreground"
              >
                <StatusIcons.warning className="size-4" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">A skill in this source needs attention</TooltipContent>
          </Tooltip>
        ) : null}

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={`More for ${label}`}
                  title=""
                  className="relative z-10 -my-1"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onCheckUpdates}>
              <ActionIcons.refresh aria-hidden="true" />
              Check for updates
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                <GitHubMark className="size-4 shrink-0" />
                View on GitHub
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <ActionIcons.delete aria-hidden="true" />
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="relative z-10 flex shrink-0" onClick={(event) => event.stopPropagation()}>
          <Switch checked={source.enabled} onCheckedChange={onToggleSource} aria-label={label} />
        </span>

        <span aria-hidden="true" className={skillLibraryTailClass}>
          <ChevronRight
            motion="none"
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
              expanded && "rotate-90"
            )}
          />
        </span>
      </div>

      <Collapse open={expanded}>
        {/* A half step of the tonal fill under the children: the folder's
            inside, read without a second box or a tree line. */}
        <div
          id={bodyId}
          role="list"
          aria-label={label}
          className="divide-y divide-border/70 border-t border-border/70 bg-secondary/40"
        >
          {skills.map((skill, index) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              href={skillHref(skill)}
              onToggle={(enabled) => onToggleSkill(skill, enabled)}
              inheritedOff={!source.enabled}
              glyph={false}
              indent
              className={firstReveal ? "motion-safe:animate-rise-in [animation-fill-mode:backwards]" : undefined}
              style={firstReveal ? staggerDelay(index, "tight") : undefined}
            />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
