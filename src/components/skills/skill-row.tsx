"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";
import {
  skillAttention,
  skillOriginBadge,
  type SkillRowData,
} from "@/components/skills/skill-library-model";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The row recipe every line of the library shares: text on the page, a hairline
 * between rows (the list draws it), the tonal hover fill across the whole
 * line, and the trailing column the switches line up in.
 *
 * Full-bleed and square rather than a rounded chip inside a well, because the
 * rows sit on hairlines: a rounded fill under a straight rule reads as two
 * shapes fighting over one edge.
 */
export const skillLibraryRowClass =
  "group/row relative flex min-h-16 items-center gap-3 px-3 py-3 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none sm:px-4";

/**
 * A skill inside a source starts where the source's NAME starts: the row's
 * inset, plus the 28px avatar column, plus the 12px gap after it.
 */
export const skillLibraryIndentClass = "pl-[3.25rem] sm:pl-14";

/** The 28px leading column: the skill glyph, or a source's avatar. */
export const skillLibraryLeadClass = "grid size-7 shrink-0 place-items-center";

/**
 * The trailing slot after the switch. On a skill row it holds the chevron that
 * says the row opens; on a group row, the disclosure caret. Same width on both,
 * so every switch on the page sits in one column.
 */
export const skillLibraryTailClass = "grid size-4 shrink-0 place-items-center";

const ATTENTION_COPY = {
  blocked: `Blocked by ${PRODUCT_NAME}’s safety check`,
  consent: "Needs your approval before it can run",
} as const;

/**
 * One skill in the library: name, one line of what it is for, its switch.
 *
 * THE WHOLE ROW OPENS IT, AND THE SWITCH STILL WORKS. The name is a real link
 * stretched over the row by a pseudo-element, rather than an `onClick` on a
 * `div`, so the row can be middle-clicked, opened in a new tab and announced
 * as a link; the switch and the warning glyph are raised above the stretch
 * (`relative z-10`) so pressing them never navigates. `stopPropagation` on the
 * switch as well, because a row nested inside a group also sits inside the
 * group's own click target.
 *
 * Origin is said as quiet text beside the description: Yours, Installed, or
 * Untrusted when the account has not vouched for the instructions. The slash
 * name and the version live on the skill's page; the one fact that earns a
 * glyph here is that the skill cannot run as things stand (blocked, or
 * waiting for consent).
 *
 * `inheritedOff` is a source switched off above it: the row keeps its own
 * state, dims with the group, and its switch waits for the source to come
 * back on, so turning the source on restores exactly what was on before.
 */
export function SkillRow({
  skill,
  href,
  onToggle,
  inheritedOff = false,
  glyph = true,
  indent = false,
  className,
  style,
}: {
  skill: SkillRowData;
  href: string;
  onToggle: (enabled: boolean) => void;
  inheritedOff?: boolean;
  /** The skill glyph in the leading column. Off inside a source, where the group's avatar already says what these are. */
  glyph?: boolean;
  /** Inside a source: the text starts under the group's name, not under its avatar. */
  indent?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const attention = skillAttention(skill);
  const blocked = attention === "blocked";
  const origin = skillOriginBadge(skill);
  return (
    <div
      role="listitem"
      className={cn(skillLibraryRowClass, indent && skillLibraryIndentClass, className)}
      style={style}
    >
      {glyph && !indent ? (
        // The same 28px tile a source's avatar sits in, so the leading column
        // reads as one column down both sections.
        <span aria-hidden="true" className={cn(skillLibraryLeadClass, "rounded-md bg-secondary")}>
          <AppIcons.skills
            motion="none"
            className="size-4 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/row:text-foreground"
          />
        </span>
      ) : null}

      <div
        className={cn(
          "min-w-0 flex-1 transition-opacity duration-fast ease-out-soft",
          (inheritedOff || !skill.enabled) && "opacity-60"
        )}
      >
        <Link
          href={href}
          className="block truncate text-body font-medium leading-snug text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          {skill.name}
        </Link>
        <p className="mt-0.5 flex min-w-0 items-center gap-x-2 text-ui text-muted-foreground">
          {skill.description ? <span className="truncate">{skill.description}</span> : null}
          <span
            className={cn(
              "shrink-0 text-caption",
              origin.caution ? "font-medium text-warning-foreground" : undefined
            )}
          >
            {origin.label}
          </span>
        </p>
      </div>

      {attention ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={ATTENTION_COPY[attention]}
              className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full text-warning-foreground"
            >
              <StatusIcons.warning className="size-4" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{ATTENTION_COPY[attention]}</TooltipContent>
        </Tooltip>
      ) : null}

      <span className="relative z-10 flex shrink-0" onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={skill.enabled && !blocked}
          disabled={blocked || inheritedOff}
          onCheckedChange={onToggle}
          aria-label={skill.name}
        />
      </span>

      <span aria-hidden="true" className={skillLibraryTailClass}>
        <ChevronRight
          motion="none"
          className="size-4 -translate-x-0.5 text-muted-foreground opacity-0 transition-[opacity,transform] duration-fast ease-out-soft group-hover/row:translate-x-0 group-hover/row:opacity-100 group-focus-within/row:translate-x-0 group-focus-within/row:opacity-100 motion-reduce:translate-x-0 coarse:opacity-100"
        />
      </span>
    </div>
  );
}
