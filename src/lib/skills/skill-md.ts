/**
 * `SKILL.md` — the Agent Skills artefact, read into Juno's shape.
 *
 * The format is a folder with a `SKILL.md` at its head: YAML frontmatter
 * between `---` fences, then a Markdown body. Anthropic publishes it as an open
 * specification (agentskills.io) and OpenAI's Codex reads the same file, so this
 * one parser covers both ecosystems and most of what exists on GitHub. See
 * `docs/skills-audit.md` §1.1 for the field table this implements.
 *
 * TWO VOCABULARIES, ONE READER. The published spec permits exactly six keys —
 * `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`
 * — and its validator fails on anything else. Claude Code reads a much larger
 * superset on top (`disable-model-invocation`, `paths`, `context`, `model`,
 * `agent`, `effort`, `hooks`, …) and its own packaging script rejects THOSE when
 * a skill is packaged for distribution. A reader that enforces either list
 * cannot read skills written for the other, and the superset is where most
 * real skills live. So unknown keys are recorded and ignored rather than
 * refused: `ignoredKeys` is what the import preview shows the reader, so
 * "Juno dropped something" is visible instead of silent.
 *
 * NOT A YAML PARSER, DELIBERATELY. Frontmatter here is a flat map of scalars
 * plus one nested string map (`metadata`) and one list (`allowed-tools`). A
 * general YAML library would bring anchors, merge keys, tags and type coercion
 * into a code path whose input is a file downloaded from a stranger's
 * repository, to parse six keys. Everything below is bounded, produces strings,
 * and has no way to construct anything but a string, a string list or a string
 * map.
 *
 * Pure: no `server-only`, no I/O, no Prisma. The importer, the route and
 * `tests/skill-md.test.ts` all read it, and only one of those can open a
 * socket.
 */

import {
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_SLUG_CHARS,
  SKILL_SLUG_PATTERN,
} from "@/lib/work/skills";

/** The file at the head of a skill directory. The spec spells it in capitals. */
export const SKILL_MD_FILENAME = "SKILL.md";

/**
 * How much of a `SKILL.md` is read before it is refused outright.
 *
 * Above Juno's own instructions ceiling (`MAX_SKILL_INSTRUCTIONS_CHARS`, 50k)
 * so a file that is merely *long* is refused for being too long — with a
 * sentence naming the ceiling — rather than truncated into a skill that silently
 * does three quarters of what its author wrote. The margin exists so the
 * frontmatter and the fences do not push an otherwise-legal body over.
 */
export const MAX_SKILL_MD_CHARS = MAX_SKILL_INSTRUCTIONS_CHARS + 8_000;

/** Frontmatter is metadata. A file whose header runs past this is not one. */
export const MAX_FRONTMATTER_LINES = 200;
/** One frontmatter line. Long enough for a 1024-char description on one line. */
const MAX_FRONTMATTER_LINE_CHARS = 2_000;
/** `metadata` is a bag for a handful of keys, not a document. */
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_CHARS = 80;
const MAX_METADATA_VALUE_CHARS = 500;
/** Spec ceiling for `compatibility`. */
const MAX_COMPATIBILITY_CHARS = 500;
/** Spec ceiling for `license` — a name or a filename, never a licence text. */
const MAX_LICENSE_CHARS = 200;
/** `allowed-tools` is a list of tool names, and a long one is a red flag. */
const MAX_ALLOWED_TOOLS = 64;
const MAX_TOOL_NAME_CHARS = 120;

/**
 * The six keys the published specification defines.
 *
 * Kept as data rather than as a series of `if`s because the import preview
 * reports which of them a file used, and because the distinction between "a
 * spec field" and "a host extension" is the one the audit turns on.
 */
export const AGENT_SKILLS_SPEC_KEYS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

/**
 * Keys Claude Code adds and Juno understands well enough not to call them
 * unknown.
 *
 * Listing them is not the same as honouring them — nothing below acts on
 * `model` or `context`, and a Juno skill has no subagent to fork into. They are
 * named so the preview can say "this skill was written for Claude Code and
 * three of its settings do not apply here" instead of listing them beside a
 * genuine typo, which is what `ignoredKeys` would otherwise do.
 */
export const HOST_EXTENSION_KEYS = [
  "disable-model-invocation",
  "user-invocable",
  "paths",
  "context",
  "agent",
  "model",
  "effort",
  "shell",
  "hooks",
  "when_to_use",
  "argument-hint",
  "arguments",
  "background",
  "version",
] as const;

export type SkillMdRefusal =
  /** No `---` fence at the top. A plain Markdown file is not a skill. */
  | "no_frontmatter"
  /** The opening fence is never closed. */
  | "unterminated_frontmatter"
  /** Frontmatter parsed, but `name` is absent or empty. */
  | "missing_name"
  /** `name` is present but is not a slug the rest of Juno can carry. */
  | "invalid_name"
  /** Frontmatter parsed, but `description` is absent or empty. */
  | "missing_description"
  /** Nothing below the closing fence. A skill with no method is not a skill. */
  | "empty_body"
  /** The file is larger than `MAX_SKILL_MD_CHARS`. */
  | "too_large";

export interface ParsedSkillMd {
  /** The `name` field, which is also the slug. Lowercase, hyphenated. */
  name: string;
  /**
   * What it does AND when to use it — the spec is explicit that both halves
   * belong here, because this is the only text an agent matches a request
   * against before deciding to load the body.
   */
  description: string;
  /** The Markdown body: everything below the closing fence, trimmed. */
  instructions: string;
  license: string | null;
  compatibility: string | null;
  /** The spec's string→string bag, bounded and with every value stringified. */
  metadata: Record<string, string>;
  /**
   * `allowed-tools`, read as a REQUEST.
   *
   * The spec calls this experimental and the hosts treat it as a narrowing
   * convenience inside a session the user already authorised. Juno maps it onto
   * `requestedTools`, which its resolver intersects with what the turn already
   * had — so the field cannot widen anything here even though its name says
   * "allowed". The rename is load-bearing; see `work/skills.ts`.
   */
  allowedTools: string[];
  /** Spec keys this file actually used. For the preview, not for behaviour. */
  specKeys: string[];
  /** Recognised host extensions present and not acted on. */
  hostKeys: string[];
  /** Keys in neither list. Shown to the reader rather than swallowed. */
  ignoredKeys: string[];
}

export type SkillMdResult =
  | { ok: true; skill: ParsedSkillMd }
  | { ok: false; reason: SkillMdRefusal };

/** One sentence per refusal, written for the person who pasted the URL. */
export const SKILL_MD_REFUSAL_MESSAGES: Record<SkillMdRefusal, string> = {
  no_frontmatter:
    "This file has no YAML frontmatter, so it is a Markdown file rather than a skill. A skill starts with a --- fence and a name and description inside it.",
  unterminated_frontmatter:
    "This file opens a --- fence and never closes it, so there is no way to tell where the metadata stops and the instructions start.",
  missing_name: "This skill has no name in its frontmatter, which is the one thing it is invoked by.",
  invalid_name: `A skill name has to be lowercase letters, numbers and hyphens, and at most ${MAX_SKILL_SLUG_CHARS} characters — that is what gets typed after a slash.`,
  missing_description:
    "This skill has no description. The description is what Juno reads when deciding whether a skill fits, so a skill without one can never be offered.",
  empty_body: "This skill has metadata but no instructions below it, so there is nothing for it to tell Juno to do.",
  too_large: `This skill is larger than ${MAX_SKILL_MD_CHARS.toLocaleString("en")} characters. Instructions that long belong in files the skill points at rather than in the skill itself.`,
};

/**
 * Strips one layer of YAML quoting.
 *
 * Only the two forms a frontmatter scalar is ever written in, and no escape
 * processing beyond `\"` inside a double-quoted string: a parser that
 * interpreted `\u` or `\x` here would be reconstructing arbitrary characters
 * from a downloaded file for no gain, since every value below is bounded,
 * stringified and either matched against a pattern or shown to a person.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Everything before an unquoted `#`. YAML's comment rule, minus the corners. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A `#` only opens a comment at the start of a line or after whitespace —
    // otherwise `https://example.com/#anchor` loses its fragment and a colour
    // in a description becomes a truncated sentence.
    if (char === "#" && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index);
  }
  return raw;
}

type ScalarEntry = { kind: "scalar"; value: string };
type ListEntry = { kind: "list"; value: string[] };
type MapEntry = { kind: "map"; value: Record<string, string> };
type FrontmatterEntry = ScalarEntry | ListEntry | MapEntry;

/**
 * Splits `SKILL.md` into its frontmatter block and its body.
 *
 * The opening fence must be the first non-empty line — a `---` that turns up in
 * the middle of a document is a horizontal rule, and treating it as a fence is
 * how a parser decides a paragraph is metadata. A UTF-8 BOM is stripped first,
 * because a file saved by a Windows editor otherwise fails on a character the
 * reader cannot see.
 */
function splitFrontmatter(source: string): { header: string[]; body: string } | SkillMdRefusal {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || lines[start].trim() !== "---") return "no_frontmatter";

  for (let index = start + 1; index < lines.length; index++) {
    if (index - start > MAX_FRONTMATTER_LINES) return "unterminated_frontmatter";
    const line = lines[index].trim();
    // `...` closes a YAML document too, and a handful of generators emit it.
    if (line === "---" || line === "...") {
      return { header: lines.slice(start + 1, index), body: lines.slice(index + 1).join("\n") };
    }
  }
  return "unterminated_frontmatter";
}

/**
 * Reads the frontmatter block into entries.
 *
 * Handles the four shapes that occur in the wild and nothing else:
 *
 *   key: value                      → scalar
 *   key: value                      → scalar, continued by more-indented lines
 *     continued here                  (YAML plain-scalar folding, joined by a space)
 *   key: >-  /  key: |              → block scalar, folded or kept
 *   key:                            → list, when the next lines are `- item`
 *     - item                          or a map, when they are `sub: value`
 *   key: [a, b]                     → inline list
 *
 * Indentation decides which, exactly as YAML does. Anything it cannot place is
 * dropped rather than guessed at: the key then shows up in `ignoredKeys`, which
 * the preview shows, and a reader who can see "Juno did not understand
 * `paths`" is better off than one handed a value invented for them.
 */
function parseFrontmatter(header: string[]): Record<string, FrontmatterEntry> {
  const entries: Record<string, FrontmatterEntry> = {};
  let index = 0;

  while (index < header.length) {
    const raw = header[index];
    if (raw.length > MAX_FRONTMATTER_LINE_CHARS) {
      index++;
      continue;
    }
    const line = stripComment(raw);
    if (line.trim() === "") {
      index++;
      continue;
    }
    // Only top-level keys start an entry; an indented line here has no parent
    // and is a continuation the branches below have already consumed.
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/.exec(line);
    if (!match || /^\s/.test(line)) {
      index++;
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const rest = match[2];
    index++;

    // key: |   /   key: >-   — a block scalar, ended by dedenting.
    const block = /^\s*([|>])([+-]?)\s*$/.exec(rest);
    if (block) {
      const kept: string[] = [];
      let indent: number | null = null;
      while (index < header.length) {
        const next = header[index];
        if (next.trim() === "") {
          kept.push("");
          index++;
          continue;
        }
        const leading = next.length - next.trimStart().length;
        if (indent === null) {
          if (leading === 0) break;
          indent = leading;
        } else if (leading < indent) {
          break;
        }
        kept.push(next.slice(indent ?? 0));
        index++;
      }
      const joined = block[1] === "|" ? kept.join("\n") : kept.join(" ").replace(/\s+/g, " ");
      entries[key] = { kind: "scalar", value: joined.trim() };
      continue;
    }

    // key: [a, b] — an inline list.
    const inline = /^\s*\[(.*)\]\s*$/.exec(rest);
    if (inline) {
      entries[key] = {
        kind: "list",
        value: inline[1]
          .split(",")
          .map((item) => unquote(item))
          .filter(Boolean),
      };
      continue;
    }

    if (rest.trim() !== "") {
      // key: value, possibly continued by more-indented plain lines. YAML folds
      // those into the scalar with a space, which is how a 900-character
      // description is written without one 900-character line.
      const parts = [unquote(rest)];
      while (index < header.length) {
        const next = stripComment(header[index]);
        if (next.trim() === "" || !/^\s/.test(next)) break;
        // A more-indented line that is itself `key: value` belongs to a nested
        // map, not to this scalar. Stopping here keeps `metadata:` written on
        // the same line as its first pair from swallowing the rest.
        if (/^\s+[A-Za-z_][A-Za-z0-9_.-]*\s*:/.test(next)) break;
        parts.push(next.trim());
        index++;
      }
      entries[key] = { kind: "scalar", value: parts.join(" ").trim() };
      continue;
    }

    // key:  — followed by either `- item` lines or `sub: value` lines.
    const list: string[] = [];
    const map: Record<string, string> = {};
    while (index < header.length) {
      const next = stripComment(header[index]);
      if (next.trim() === "") {
        index++;
        continue;
      }
      if (!/^\s/.test(next)) break;
      const item = /^\s*-\s*(.*)$/.exec(next);
      if (item) {
        if (list.length < MAX_ALLOWED_TOOLS) list.push(unquote(item[1]));
        index++;
        continue;
      }
      const pair = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/.exec(next);
      if (pair) {
        if (Object.keys(map).length < MAX_METADATA_ENTRIES) {
          map[pair[1].trim().slice(0, MAX_METADATA_KEY_CHARS)] = unquote(pair[2]).slice(
            0,
            MAX_METADATA_VALUE_CHARS
          );
        }
        index++;
        continue;
      }
      break;
    }
    if (list.length > 0) entries[key] = { kind: "list", value: list };
    else if (Object.keys(map).length > 0) entries[key] = { kind: "map", value: map };
    // A key with neither is a key with no value. Left out, so it reads as
    // absent rather than as an empty string somebody meant.
    continue;
  }

  return entries;
}

function scalarOf(entry: FrontmatterEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.kind === "scalar") return entry.value.trim() || null;
  // A list or map where a scalar belongs is a malformed file, not an invitation
  // to join it into a sentence.
  return null;
}

/**
 * `allowed-tools`, in either shape the hosts write it.
 *
 * Claude Code writes a space-separated string with parenthesised argument
 * patterns — `Bash(git add *) Read` — and the spec's own examples use a YAML
 * list. Both arrive here. The pattern half is kept verbatim on the name: Juno
 * matches tool names by exact string equality against the grant, so a tool
 * called `Bash(git add *)` simply never matches anything and is reported as
 * withheld, which is the correct outcome for a declaration Juno cannot honour.
 * Rewriting it to `Bash` would be inventing a broader request than was made.
 */
function parseAllowedTools(entry: FrontmatterEntry | undefined): string[] {
  if (!entry) return [];
  const raw =
    entry.kind === "list"
      ? entry.value
      : entry.kind === "scalar"
        ? splitToolString(entry.value)
        : [];
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const name of raw) {
    const trimmed = name.trim().slice(0, MAX_TOOL_NAME_CHARS);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tools.push(trimmed);
    if (tools.length >= MAX_ALLOWED_TOOLS) break;
  }
  return tools;
}

/** Splits on whitespace that is not inside parentheses: `Bash(git add *) Read`. */
function splitToolString(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function mapOf(entry: FrontmatterEntry | undefined): Record<string, string> {
  if (!entry || entry.kind !== "map") return {};
  return entry.value;
}

/**
 * Reads one `SKILL.md`.
 *
 * Never throws and never partially succeeds: either every required field is
 * present and legal, or the caller gets a refusal with a sentence it can show.
 * The name is checked against Juno's own slug pattern rather than against the
 * spec's looser prose, because the value becomes a `WorkSkill.slug` and what is
 * typed after a slash has to round-trip.
 */
export function parseSkillMd(source: string): SkillMdResult {
  if (source.length > MAX_SKILL_MD_CHARS) return { ok: false, reason: "too_large" };

  const split = splitFrontmatter(source);
  if (typeof split === "string") return { ok: false, reason: split };

  const entries = parseFrontmatter(split.header);

  const name = scalarOf(entries.name);
  if (!name) return { ok: false, reason: "missing_name" };
  const slug = name.trim().toLowerCase();
  if (!SKILL_SLUG_PATTERN.test(slug) || slug.length > MAX_SKILL_SLUG_CHARS) {
    return { ok: false, reason: "invalid_name" };
  }

  const description = scalarOf(entries.description);
  if (!description) return { ok: false, reason: "missing_description" };

  const instructions = split.body.trim();
  if (!instructions) return { ok: false, reason: "empty_body" };
  if (instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS) return { ok: false, reason: "too_large" };

  const spec = new Set<string>(AGENT_SKILLS_SPEC_KEYS);
  const host = new Set<string>(HOST_EXTENSION_KEYS);
  const present = Object.keys(entries);

  return {
    ok: true,
    skill: {
      name: slug,
      description: description.slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      instructions,
      license: scalarOf(entries.license)?.slice(0, MAX_LICENSE_CHARS) ?? null,
      compatibility: scalarOf(entries.compatibility)?.slice(0, MAX_COMPATIBILITY_CHARS) ?? null,
      metadata: mapOf(entries.metadata),
      allowedTools: parseAllowedTools(entries["allowed-tools"]),
      specKeys: present.filter((key) => spec.has(key)),
      hostKeys: present.filter((key) => host.has(key)),
      ignoredKeys: present.filter((key) => !spec.has(key) && !host.has(key)),
    },
  };
}

/**
 * One YAML scalar, written so `parseSkillMd` can read it back.
 *
 * Bare when it is a plain word or path; JSON-string otherwise. JSON double
 * quotes are a subset of YAML double quotes, so this is the whole of the
 * writer's escaping and there is no second quoting rule to drift from the
 * reader's `unquote`.
 */
function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0 && /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(trimmed) && !trimmed.includes(": ")) {
    return trimmed;
  }
  return JSON.stringify(value);
}

/** What `serializeSkillMd` writes. The parse half's fields, minus the bookkeeping. */
export interface SkillMdExport {
  /** Slash name. */
  name: string;
  description: string;
  instructions: string;
  license?: string | null;
  compatibility?: string | null;
  metadata?: Record<string, string>;
  allowedTools?: readonly string[];
}

/**
 * Writes a `SKILL.md` from Juno's shape.
 *
 * The inverse of `parseSkillMd` for the six spec keys: name, description and
 * the body always; license, compatibility, metadata and allowed-tools only
 * when they hold something. Host extensions and ignored keys are not
 * reconstructed — Juno does not act on them, and inventing `context: fork` on
 * the way out would claim a setting the export cannot honour.
 */
export function serializeSkillMd(skill: SkillMdExport): string {
  const lines: string[] = [
    "---",
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
  ];
  if (skill.license) lines.push(`license: ${yamlScalar(skill.license)}`);
  if (skill.compatibility) lines.push(`compatibility: ${yamlScalar(skill.compatibility)}`);
  const tools = skill.allowedTools ?? [];
  if (tools.length > 0) {
    lines.push("allowed-tools:");
    for (const tool of tools) lines.push(`  - ${yamlScalar(tool)}`);
  }
  const metadata = Object.entries(skill.metadata ?? {});
  if (metadata.length > 0) {
    lines.push("metadata:");
    for (const [key, value] of metadata) lines.push(`  ${key}: ${yamlScalar(value)}`);
  }
  lines.push("---", "", skill.instructions.trim(), "");
  return lines.join("\n");
}

/**
 * A display name for a skill whose `name` is a slug.
 *
 * The spec has one field where Juno has two — `WorkSkill.name` is prose shown in
 * a list and `slug` is what gets typed — so an import has to produce a title
 * from a hyphenated identifier. Title-casing `pdf-processing` into "Pdf
 * Processing" is worse than it looks on the acronyms that make up half of these
 * names, so words already carrying a capital are left alone and the rest get
 * their first letter raised: `pdf-processing` → "Pdf processing", `mcp-server`
 * → "Mcp server". The reader edits it afterwards if it matters; what must not
 * happen is a list of rows whose titles are all lowercase slugs.
 */
export function titleFromSkillName(name: string): string {
  const words = name.split("-").filter(Boolean);
  if (words.length === 0) return name.slice(0, MAX_SKILL_NAME_CHARS);
  const [first, ...rest] = words;
  const head = /[A-Z]/.test(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ").slice(0, MAX_SKILL_NAME_CHARS);
}
