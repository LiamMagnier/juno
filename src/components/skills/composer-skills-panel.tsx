"use client";

import * as React from "react";
import { Search } from "@/components/ui/icons";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { PlusMenuRow, PlusMenuSeparator } from "@/components/chat/composer-plus-menu";
import { YOURS_SOURCE_LABEL, type ChatSkill } from "@/components/chat/use-chat-skills";
import { AppIcons } from "@/lib/app-icons";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";

/** Past this many skills the flyout grows a filter field. */
const FILTER_THRESHOLD = 8;

function matches(skill: ChatSkill, query: string): boolean {
  return (
    skill.slug.includes(query) ||
    skill.name.toLowerCase().includes(query) ||
    skill.description.toLowerCase().includes(query) ||
    (skill.sourceLabel?.toLowerCase().includes(query) ?? false)
  );
}

/** The skills in order, cut into runs that share a source. */
function bySource(skills: ChatSkill[]): { key: string; label: string; yours: boolean; skills: ChatSkill[] }[] {
  const groups: { key: string; label: string; yours: boolean; skills: ChatSkill[] }[] = [];
  for (const skill of skills) {
    const key = skill.yours ? "yours" : (skill.sourceLabel ?? "other");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.skills.push(skill);
    else groups.push({ key, label: skill.yours ? YOURS_SOURCE_LABEL : (skill.sourceLabel ?? ""), yours: skill.yours, skills: [skill] });
  }
  return groups;
}

/**
 * The composer's "Use a skill" flyout.
 *
 * GROUPED WHILE BROWSING, FLAT WHILE SEARCHING. With nothing typed, the skills
 * sit under their source (yours first, then each repository), the way the
 * library page files them, so a reader who installed three repositories finds
 * one by where it came from. Once a filter is typed the headings would only
 * split a short answer, so the rows go flat and each carries its source as a
 * trailing label instead. The filter appears once there are more skills than
 * fit at a glance.
 *
 * Picking a row arms it for this message and picking the armed one clears it:
 * a message runs under one skill, so these are radio rows, not checkboxes.
 * Installed skills lead with their repository owner's avatar, yours with the
 * skill glyph, so the two read apart even in the flat list.
 *
 * Key events stay in the filter field, as in the connectors flyout beside it,
 * except the ones that move through the menu: the menu's typeahead must not
 * fight the field for every letter.
 */
export function ComposerSkillsPanel({
  skills,
  failed,
  onRetry,
  armedSlug,
  onPick,
  onManage,
  initialQuery = "",
}: {
  /** Null until the first read lands. */
  skills: ChatSkill[] | null;
  failed: boolean;
  onRetry: () => void;
  armedSlug: string | null;
  onPick: (slug: string) => void;
  onManage: () => void;
  /** Fixture: start filtered (the dev gallery). */
  initialQuery?: string;
}) {
  const [query, setQuery] = React.useState(initialQuery);
  const needle = query.trim().toLowerCase();
  const list = skills ?? [];
  const visible = needle ? list.filter((skill) => matches(skill, needle)) : list;
  // Only worth a heading when there is more than one source to tell apart.
  const groups = needle ? null : bySource(visible);
  const grouped = groups !== null && groups.length > 1;

  const row = (skill: ChatSkill, labelled: boolean) => {
    const armed = armedSlug === skill.slug;
    return (
      <PlusMenuRow
        key={skill.id}
        selected={armed}
        leading={
          skill.sourceOwner ? (
            <SkillSourceAvatar owner={skill.sourceOwner} size="xs" className="mt-0.5" />
          ) : undefined
        }
        icon={skill.sourceOwner ? undefined : AppIcons.skills}
        description={skill.description || undefined}
        // The source rides the trailing slot in the flat list. The armed row
        // keeps its tick there instead: which one is armed matters more.
        note={labelled && !armed ? (skill.yours ? YOURS_SOURCE_LABEL : (skill.sourceLabel ?? undefined)) : undefined}
        onSelect={() => onPick(skill.slug)}
      >
        {skill.name}
      </PlusMenuRow>
    );
  };

  return (
    <>
      {list.length > FILTER_THRESHOLD ? (
        <div className="px-0.5 pb-1.5 pt-0.5">
          <label className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (!["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)) event.stopPropagation();
              }}
              placeholder="Filter skills…"
              aria-label="Filter skills"
              autoFocus
              className="surface-inset h-8 w-full rounded-control border border-input pl-8 pr-2 text-ui outline-none transition-[border-color] duration-fast ease-out-soft placeholder:text-muted-foreground focus:border-foreground/60"
            />
          </label>
        </div>
      ) : null}
      <div className="max-h-72 overflow-y-auto overscroll-contain">
        {/* `skills === null` rather than a loading flag: the read starts when
            this flyout opens, so for its first frame nothing is loading AND
            nothing has loaded, and the empty branch would flash "Write or
            import a skill" at somebody who has twelve. */}
        {skills === null && !failed ? (
          <div className="flex flex-col gap-1 p-1">
            {[0, 1, 2].map((placeholder) => (
              <span key={placeholder} className="skeleton h-9 rounded-control" />
            ))}
          </div>
        ) : failed && skills === null ? (
          <div className="px-2.5 py-3 text-center">
            <p className="text-caption text-muted-foreground">Couldn’t load your skills.</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 text-caption font-medium text-primary underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : list.length === 0 ? (
          <PlusMenuRow icon={AppIcons.skills} onSelect={onManage}>
            Write or import a skill
          </PlusMenuRow>
        ) : visible.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted-foreground">
            No skills match “{query.trim()}”.
          </p>
        ) : grouped ? (
          groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <DropdownMenuLabel translate={group.yours ? undefined : "no"}>{group.label}</DropdownMenuLabel>
              {group.skills.map((skill) => row(skill, false))}
            </div>
          ))
        ) : (
          visible.map((skill) => row(skill, needle.length > 0))
        )}
      </div>
      <PlusMenuSeparator />
      <PlusMenuRow icon={AppIcons.skills} onSelect={onManage}>
        Manage skills
      </PlusMenuRow>
    </>
  );
}
