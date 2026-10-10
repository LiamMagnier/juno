/**
 * SKILL.md parsing (skills lane): the pure half of skill-files.ts, with no
 * imports, so the hosted web can read a repository's skills by the same rules.
 *
 * SHARED, BYTE FOR BYTE. This file lives in runner/agent-core/src/skills/
 * (the source), runner/env-server/src/skills/ and src/lib/code-v2/;
 * scripts/check-code-v2-contracts.mjs fails when a copy differs (`--write`
 * copies it from agent-core).
 */

/** A project's skills folders, nearest first: the precedence within the project tier. */
export const PROJECT_SKILL_DIRS: readonly { dir: string; origin: "alevr" | "juno" | "claude" }[] = [
  { dir: ".alevr/skills", origin: "alevr" },
  { dir: ".juno/skills", origin: "juno" },
  { dir: ".claude/skills", origin: "claude" },
];

/** Front matter is read from the head of the file; a SKILL.md larger than this is not a skill. */
export const SKILL_MAX_BYTES = 256 * 1024;
/** What a listing reads per file: enough for any front matter. */
export const HEAD_BYTES = 16 * 1024;
/** Descriptions past this are cut; the selector shows two lines. */
export const SKILL_DESCRIPTION_MAX = 500;
/** A safety cap on one listing. */
export const SKILL_LIST_MAX = 500;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
}

/** The value of one front-matter scalar, unquoted. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, " ") : inner.replace(/''/g, "'");
  }
  return v;
}

/**
 * Splits a SKILL.md into its front matter's `name` and `description` and its
 * body. Reads the YAML subset skills use: `key: value`, quoted values, and
 * block scalars (`>` / `|`, with indented continuation lines). Without front
 * matter the first line of prose stands in for the description.
 */
export function parseSkillFile(text: string): ParsedSkill {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const fields: Record<string, string> = {};
  let body = normalized;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (close > 0) {
      for (let i = 1; i < close; i++) {
        const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!);
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        let value = match[2]!;
        if (/^[>|][-+]?\s*$/.test(value)) {
          const parts: string[] = [];
          while (i + 1 < close && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
            i++;
            parts.push(lines[i]!.trim());
          }
          value = value.startsWith("|") ? parts.join("\n").trim() : parts.filter(Boolean).join(" ");
        } else {
          value = unquote(value);
          // A plain scalar may continue on more-indented lines.
          while (i + 1 < close && /^\s+\S/.test(lines[i + 1]!) && !/^\s*[A-Za-z_][\w-]*\s*:/.test(lines[i + 1]!)) {
            i++;
            value += " " + lines[i]!.trim();
          }
        }
        if (!(key in fields)) fields[key] = value;
      }
      body = lines.slice(close + 1).join("\n");
    }
  }
  body = body.trim();
  let description: string | undefined = fields.description?.trim();
  if (!description) {
    description = body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"));
  }
  const name = fields.name?.trim();
  return {
    name: name || undefined,
    description: description ? description.replace(/\s+/g, " ").slice(0, SKILL_DESCRIPTION_MAX) : undefined,
    body,
  };
}

/** The `/name` a skill answers to: its front matter's name, else its folder's. */
export function skillName(parsed: ParsedSkill, folder: string): string | null {
  for (const candidate of [parsed.name, folder]) {
    const name = candidate?.trim().toLowerCase().replace(/\s+/g, "-");
    if (name && NAME_RE.test(name)) return name;
  }
  return null;
}
