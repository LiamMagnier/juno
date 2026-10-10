"use client";

/**
 * Skills in the Code composer (skills lane): the chip on the composer's row
 * and the selector it opens.
 *
 * Built as the model catalogue is: one 380-wide popover, a search field, rows
 * of name over description grouped under where they come from (Yours,
 * Installed on this Mac, Project), a check on the ones the thread runs under,
 * and a footer. While searching the groups go flat and each row says where
 * it came from. Choosing a row keeps it on the thread; `/name` in the field
 * runs a skill for one message (the composer's slash menu).
 */
import * as React from "react";
import Link from "next/link";
import { groupSkills, matchSkills, skillsChipLabel, type CodeSkillChoice } from "@/lib/code-v2/skills";
import type { CodeSkillsState } from "./use-code-skills";
import { ComposerPopover, DrawCheck, Glyph, Spinner } from "./primitives";

export function SkillsChip({ skills, open, onToggle }: { skills: CodeSkillsState; open: boolean; onToggle: () => void }) {
  const label = skillsChipLabel(skills.selected, skills.once);
  const active = skills.selected.length > 0 || !!skills.once;
  return (
    <button
      type="button"
      className="cv2-ctl"
      data-active={active || undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={active ? `Skills: ${label}` : "Skills"}
      title={active ? `Skills: ${label}` : "Run this thread under a skill, or type / and its name"}
      onPointerEnter={skills.load}
      onFocus={skills.load}
      onClick={() => {
        skills.load();
        onToggle();
      }}
    >
      <Glyph name="skills" size={14} />
      <span className="v cv2-trunc">{label}</span>
      <Glyph name="chevron-down" size={12} className="chev" />
    </button>
  );
}

export function SkillsPicker({
  skills,
  open,
  onClose,
  anchorRef,
  initialQuery = "",
}: {
  skills: CodeSkillsState;
  open: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Fixture: start filtered (the gallery). */
  initialQuery?: string;
}) {
  return (
    <ComposerPopover open={open} onClose={onClose} width={380} align="left" offset={0} label="Skills" anchorRef={anchorRef}>
      <SkillsPanel skills={skills} onClose={onClose} initialQuery={initialQuery} />
    </ComposerPopover>
  );
}

export function SkillsPanel({ skills, onClose, initialQuery = "" }: { skills: CodeSkillsState; onClose: () => void; initialQuery?: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  const [hi, setHi] = React.useState(0);
  const list = React.useMemo(() => skills.choices ?? [], [skills.choices]);
  const searching = query.trim().length > 0;
  const visible = React.useMemo(() => matchSkills(list, query), [list, query]);
  const selectedIds = React.useMemo(() => new Set(skills.selected.map((s) => s.id)), [skills.selected]);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setHi(0), [query]);
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!visible.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = visible[hi];
      if (choice) skills.toggle(choice);
    }
  };

  const row = (choice: CodeSkillChoice, index: number, labelled: boolean) => {
    const checked = selectedIds.has(choice.id);
    const armed = skills.once?.id === choice.id;
    return (
      <button
        key={choice.id}
        type="button"
        role="option"
        aria-selected={checked}
        data-active={index === hi}
        data-index={index}
        className="cv2-mrow cv2-skill-row"
        onMouseEnter={() => setHi(index)}
        onClick={() => skills.toggle(choice)}
        title={choice.path ?? choice.title}
      >
        <Glyph name="skills" size={14} className="cv2-skill-mark" />
        <span className="cv2-grow" style={{ minWidth: 0 }}>
          <span className="cv2-skill-top">
            <span className="nm cv2-trunc">{choice.title}</span>
            {armed && <span className="cv2-skill-note">next message</span>}
            {labelled && choice.originLabel && <span className="cv2-skill-origin cv2-trunc">{choice.originLabel}</span>}
          </span>
          {choice.description && <span className="l2 cv2-skill-desc">{choice.description}</span>}
        </span>
        <span className="ck" aria-hidden>
          {checked ? <DrawCheck /> : null}
        </span>
      </button>
    );
  };

  let index = -1;
  const body =
    skills.choices === null && !skills.failed ? (
      <div className="cv2-skill-empty">
        <Spinner size={14} />
        <span>Looking for skills</span>
      </div>
    ) : skills.failed && list.length === 0 ? (
      <div className="cv2-skill-empty">
        <span>Couldn’t load your skills</span>
        <button type="button" className="cv2-link" onClick={skills.reload}>
          Try again
        </button>
      </div>
    ) : list.length === 0 ? (
      <div className="cv2-skill-empty col">
        <span className="t">No skills yet</span>
        <span>
          {skills.localKind === "repo"
            ? "Add a folder with a SKILL.md to .claude/skills in this repository, or write one in Alevr."
            : "Add a folder with a SKILL.md to ~/.claude/skills on your Mac, or write one in Alevr."}
        </span>
      </div>
    ) : searching && visible.length === 0 ? (
      <div className="cv2-skill-empty">No skill matches “{query.trim()}”</div>
    ) : searching ? (
      visible.map((c) => row(c, ++index, true))
    ) : (
      groupSkills(visible).map((g) => (
        <div key={g.group} role="group" aria-label={g.title}>
          <div className="cv2-pgroup">
            <span className="t">{g.title}</span>
            <span className="u">{g.skills.length}</span>
          </div>
          {g.skills.map((c) => row(c, ++index, g.group !== "yours"))}
        </div>
      ))
    );

  return (
    <div className="cv2-skills" onKeyDown={onKeyDown}>
      <label className="cv2-pop-search">
        <Glyph name="search" size={14} />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" aria-label="Search skills" />
      </label>
      <div className="cv2-pop-body cv2-skills-list" role="listbox" aria-label="Skills" aria-multiselectable ref={listRef}>
        {body}
      </div>
      {skills.macUnavailable && (
        <div className="cv2-pop-foot cv2-skill-warn">
          {skills.localKind === "repo" ? "Couldn’t read this repository’s skills from GitHub." : "Your Mac’s skills appear when it is online."}
        </div>
      )}
      <div className="cv2-pop-foot">
        <Link href={skills.manageHref} className="cv2-link" onClick={onClose}>
          Manage skills…
        </Link>
        <span className="cv2-grow" />
        {(skills.selected.length > 0 || skills.once) && (
          <button type="button" className="cv2-link" onClick={skills.clear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
