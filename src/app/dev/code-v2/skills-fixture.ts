"use client";

/**
 * The gallery's skills (skills lane): the owner's real kinds of skills, as a
 * Mac with Claude Code skills, a plugin, a Codex skill and a project skill
 * would list them, plus two of the account's. Live enough to click: the chip,
 * the selector's checks, a typed `/name`.
 */
import * as React from "react";
import type { CodeSkillsState } from "@/components/code/v2/use-code-skills";
import type { LocalSkillSummary } from "@/lib/code-v2/contracts";
import { choiceFromAccount, choiceFromLocal, orderSkills, type CodeSkillChoice } from "@/lib/code-v2/skills";

const HOME = "/Users/liam";

const LOCAL: LocalSkillSummary[] = [
  { name: "design-taste-frontend", description: "Anti-slop frontend skill for landing pages, portfolios and redesigns. Reads the brief, infers the direction, ships interfaces that do not look templated.", source: "user", origin: "claude", path: `${HOME}/.claude/skills/design-taste-frontend/SKILL.md` },
  { name: "high-end-visual-design", description: "Designs like a high-end agency: the fonts, spacing, shadows and motion that make a site feel expensive.", source: "user", origin: "claude", path: `${HOME}/.claude/skills/high-end-visual-design/SKILL.md` },
  { name: "swiftui-design-skill", description: "SwiftUI visual design for iOS and macOS: direction, layout, type, colour and review.", source: "user", origin: "claude", path: `${HOME}/.claude/skills/swiftui-design-skill/SKILL.md` },
  { name: "minimalist-ui", description: "Clean editorial interfaces: warm monochrome, typographic contrast, flat bento grids.", source: "user", origin: "claude", path: `${HOME}/.claude/skills/minimalist-ui/SKILL.md` },
  { name: "impeccable", description: "Design, redesign, critique, audit and polish a frontend interface, from hierarchy to motion.", source: "plugin", origin: "claude", plugin: "impeccable", path: `${HOME}/.claude/plugins/cache/impeccable/impeccable/4.3.1/skills/impeccable/SKILL.md` },
  { name: "figma-use", description: "Read and write Figma files through the Figma plugin's tools.", source: "plugin", origin: "claude", plugin: "figma", path: `${HOME}/.claude/plugins/cache/claude-plugins-official/figma/2.2.127/skills/figma-use/SKILL.md` },
  { name: "release-notes", description: "Draft release notes from merged pull requests since the last tag.", source: "user", origin: "codex", path: `${HOME}/.codex/skills/release-notes/SKILL.md` },
  { name: "storefront-conventions", description: "How this repo names components, writes tests and handles money.", source: "project", origin: "alevr", path: "/Users/liam/code/storefront/.alevr/skills/storefront-conventions/SKILL.md" },
];

const ACCOUNT = [
  { id: "sk_tidy", slug: "tidy-commits", name: "Tidy commits", description: "Squash fixups and write one message per change before a pull request.", sourceLabel: null },
  { id: "sk_review", slug: "pr-review", name: "PR review", description: "Review a pull request the way the team does: risk first, then tests, then style.", sourceLabel: "anthropics/skills" },
];

export const FIXTURE_SKILLS: CodeSkillChoice[] = orderSkills([...ACCOUNT.map(choiceFromAccount), ...LOCAL.map(choiceFromLocal)]);

export function useFixtureSkills(initial?: { selected?: string[]; once?: string; empty?: boolean; loading?: boolean }): CodeSkillsState {
  const choices = initial?.loading ? null : initial?.empty ? [] : FIXTURE_SKILLS;
  const [ids, setIds] = React.useState<string[]>(() => (initial?.selected ?? []).map((name) => FIXTURE_SKILLS.find((s) => s.name === name)?.id ?? "").filter(Boolean));
  const [once, setOnce] = React.useState<CodeSkillChoice | null>(() => FIXTURE_SKILLS.find((s) => s.name === initial?.once) ?? null);
  const selected = React.useMemo(() => ids.map((id) => FIXTURE_SKILLS.find((s) => s.id === id)!).filter(Boolean), [ids]);
  return {
    choices,
    loading: !!initial?.loading,
    failed: false,
    selected,
    once,
    macUnavailable: false,
    load: () => undefined,
    reload: () => undefined,
    toggle: (c) => setIds((x) => (x.includes(c.id) ? x.filter((i) => i !== c.id) : [...x, c.id])),
    arm: setOnce,
    clear: () => {
      setIds([]);
      setOnce(null);
    },
    take: async () => {
      setOnce(null);
      return undefined;
    },
    manageHref: "/skills",
  };
}
