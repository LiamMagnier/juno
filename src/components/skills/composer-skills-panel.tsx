"use client";

import * as React from "react";
import { Plus, Search } from "@/components/ui/icons";
import { PlusMenuRow, PlusMenuSeparator } from "@/components/chat/composer-plus-menu";
import { MenuEmpty, MenuLabel, MenuScrollEdges, MenuSearch, MenuSkeleton } from "@/components/chat/composer-menu";
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
 * The composer's "Run a skill" flyout.
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
            <SkillSourceAvatar owner={skill.sourceOwner} size="xs" />
          ) : undefined
        }
        icon={skill.sourceOwner ? undefined : AppIcons.skills}
        // Name over description: every row here has both, and side by side
        // on one line a long description squeezed the name to a letter.
        description={skill.description || undefined}
        stacked
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
        <MenuSearch value={query} onChange={setQuery} placeholder="Filter skills" label="Filter skills" />
      ) : null}
      <div className="cmenu-scroll max-h-72 min-h-0 overflow-y-auto overscroll-contain">
        <MenuScrollEdges />
        {/* `skills === null` rather than a loading flag: the read starts when
            this flyout opens, so for its first frame nothing is loading AND
            nothing has loaded, and the empty branch would flash "Write or
            import a skill" at somebody who has twelve. */}
        {skills === null && !failed ? (
          <MenuSkeleton rows={3} />
        ) : failed && skills === null ? (
          <MenuEmpty
            icon={AppIcons.skills}
            title="Couldn’t load your skills"
            action={
              <button type="button" onClick={onRetry} className="cmenu-empty__action">
                Try again
              </button>
            }
          />
        ) : list.length === 0 ? (
          <MenuEmpty
            icon={AppIcons.skills}
            title="No skills yet"
            hint="A skill teaches a method once, for every chat after."
          />
        ) : visible.length === 0 ? (
          <MenuEmpty icon={Search} title={`No skills match “${query.trim()}”`} />
        ) : grouped ? (
          groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <div translate={group.yours ? undefined : "no"}>
                <MenuLabel>{group.label}</MenuLabel>
              </div>
              {group.skills.map((skill) => row(skill, false))}
            </div>
          ))
        ) : (
          visible.map((skill) => row(skill, needle.length > 0))
        )}
      </div>
      <PlusMenuSeparator />
      <PlusMenuRow icon={list.length === 0 ? Plus : AppIcons.skills} onSelect={onManage}>
        {list.length === 0 ? "Write or import a skill" : "Manage skills"}
      </PlusMenuRow>
    </>
  );
}
