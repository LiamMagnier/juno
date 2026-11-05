/**
 * Named custom agents for spawn_agent / delegate_tasks (the `agent` field).
 *
 * A custom agent is a Markdown file whose front matter names it and whose body
 * is the brief it works under: the format Claude Code established for
 * `.claude/agents/*.md`, which Codex, Cursor and the Mac engine
 * (`CustomAgentDiscovery.swift`) read as well. This is the same feature for
 * the TypeScript engine, so a cloud run and the Mac's env server offer a
 * repository's agents exactly like the native engine does.
 *
 *   project  <root>/.alevr/agents, <root>/.juno/agents, <root>/.claude/agents
 *   user     <home>/agents (the Alevr home, `$JUNO_HOME`), when there is one
 *
 * A same-named agent resolves to the nearest one (project before user, then
 * .alevr before .juno before .claude).
 *
 * Front matter read: `name`, `description`, `tools` (comma-separated or a
 * YAML list; Claude Code names map to ours), `model` (`inherit` = none),
 * `mode` (`read_only` narrows; anything else leaves the call's), `maxSteps`.
 *
 * An agent file is discovered, never trusted. Its body is context for the
 * child, in the same sense a CLAUDE.md is: it becomes the child's persona,
 * framed as the agent's own instructions, after Alevr's. It cannot raise a
 * permission mode, unlock a role's write ceiling, skip an approval or add a
 * tool the session does not already have.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from '../skills/skill-parse.js';
import { projectRootOf } from './instructions.js';

export const PROJECT_AGENT_DIRS = ['.alevr/agents', '.juno/agents', '.claude/agents'] as const;
/** A larger file is not an agent definition. */
export const AGENT_FILE_MAX_BYTES = 64 * 1024;
/** The body becomes a persona; past this it is cut. */
export const AGENT_INSTRUCTIONS_MAX = 12_000;
/** Safety cap on one listing. */
export const AGENT_LIST_MAX = 64;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface CustomAgent {
  /** What the `agent` field calls it: lowercased, spaces as hyphens. */
  name: string;
  description: string;
  instructions: string;
  /** Where it was read from: repository-relative, or `~agents/<file>` for the home tier. */
  path: string;
  scope: 'project' | 'user';
  /** Tool names after mapping; undefined = every tool the role allows. */
  tools?: string[];
  model?: string;
  readOnly: boolean;
  maxSteps?: number;
}

/** Our tools for one name an agent file lists. Claude Code's names map; any other is taken as ours (or an MCP tool's). */
export function engineToolNames(name: string): string[] {
  switch (name.trim()) {
    case 'Read':
      return ['read_file'];
    case 'Write':
      return ['write_file'];
    case 'Edit':
    case 'MultiEdit':
      return ['edit_file', 'edit_files'];
    case 'Bash':
      return ['bash', 'bash_output', 'kill_job'];
    case 'Glob':
    case 'LS':
      return ['glob'];
    case 'Grep':
      return ['grep'];
    case 'WebFetch':
      return ['web_fetch'];
    case 'WebSearch':
      return ['web_search'];
    default:
      return [name.trim()];
  }
}

/** The raw front matter fields `parseSkillFile` does not keep (tools lists, model, mode, maxSteps). */
function frontMatterFields(text: string): Record<string, string | string[]> {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const fields: Record<string, string | string[]> = {};
  if (lines[0]?.trim() !== '---') return fields;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close < 0) return fields;
  for (let i = 1; i < close; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (key in fields) continue;
    let value = match[2]!.trim();
    if (value === '') {
      // A YAML block list: "- item" lines.
      const items: string[] = [];
      while (i + 1 < close && /^\s*-\s+\S/.test(lines[i + 1]!)) {
        i++;
        items.push(lines[i]!.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      }
      if (items.length > 0) fields[key] = items;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    value = value.replace(/^["']|["']$/g, '');
    fields[key] = value;
  }
  return fields;
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : value.split(',');
  return items.map((item) => item.trim()).filter(Boolean);
}

function agentName(candidate: string | undefined): string | null {
  const name = candidate?.trim().toLowerCase().replace(/\s+/g, '-');
  return name && NAME_RE.test(name) ? name : null;
}

/** Parses one agent file; null when it is not one (no usable name, no body). */
export function parseAgentFile(text: string, file: string, display: string, scope: CustomAgent['scope']): CustomAgent | null {
  const parsed = parseSkillFile(text);
  const fields = frontMatterFields(text);
  const name = agentName(parsed.name) ?? agentName(path.basename(file, path.extname(file)));
  if (!name || !parsed.body.trim()) return null;
  const tools = asList(fields.tools);
  const mapped = tools ? [...new Set(tools.flatMap(engineToolNames))] : undefined;
  const model = typeof fields.model === 'string' && fields.model && fields.model !== 'inherit' ? fields.model : undefined;
  const mode = typeof fields.mode === 'string' ? fields.mode.toLowerCase().replace(/-/g, '_') : '';
  const stepsRaw = typeof fields.maxsteps === 'string' ? Number.parseInt(fields.maxsteps, 10) : Number.NaN;
  return {
    name,
    description: parsed.description ?? `Custom agent from ${display}`,
    instructions: parsed.body.trim().slice(0, AGENT_INSTRUCTIONS_MAX),
    path: display,
    scope,
    ...(mapped && mapped.length > 0 ? { tools: mapped } : {}),
    ...(model ? { model } : {}),
    readOnly: mode === 'read_only' || mode === 'readonly',
    ...(Number.isFinite(stepsRaw) && stepsRaw > 0 ? { maxSteps: Math.min(stepsRaw, 200) } : {}),
  };
}

function readAgentDir(dir: string, displayBase: string, scope: CustomAgent['scope'], into: Map<string, CustomAgent>, root: string | null): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((entry) => entry.endsWith('.md')).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (into.size >= AGENT_LIST_MAX) return;
    const file = path.join(dir, entry);
    try {
      const real = fs.realpathSync(file);
      // A project agent never pulls a file in from outside the repository through a symlink.
      if (root && path.relative(root, real).startsWith('..')) continue;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > AGENT_FILE_MAX_BYTES) continue;
      const agent = parseAgentFile(fs.readFileSync(real, 'utf8'), file, `${displayBase}/${entry}`, scope);
      if (agent && !into.has(agent.name)) into.set(agent.name, agent);
    } catch {
      // Unreadable: not an agent.
    }
  }
}

/**
 * The agents a session at `cwd` can name, nearest first, sorted by name so the
 * prompt section stays byte-stable while nobody edits the files.
 */
export function loadCustomAgents(cwd: string, homeDir?: string | null): CustomAgent[] {
  const found = new Map<string, CustomAgent>();
  const root = projectRootOf(cwd);
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // keep the resolved path
  }
  for (const dir of PROJECT_AGENT_DIRS) readAgentDir(path.join(root, dir), dir, 'project', found, realRoot);
  if (homeDir) readAgentDir(path.join(homeDir, 'agents'), '~agents', 'user', found, null);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The prompt lines that tell the coordinator which named agents exist; empty when none. */
export function renderCustomAgents(agents: readonly CustomAgent[]): string {
  if (agents.length === 0) return '';
  const lines = agents.map((agent) => {
    const traits = [agent.readOnly ? 'read-only' : null, agent.model ? `model ${agent.model}` : null].filter(Boolean);
    return `- ${agent.name}: ${agent.description.replace(/\s+/g, ' ').slice(0, 300)}${traits.length ? ` (${traits.join(', ')})` : ''}`;
  });
  return `\nNamed agents from this repository (pass agent: "<name>" to spawn_agent or a delegate_tasks entry; the agent's own brief is added to your prompt, and it never widens permissions):\n${lines.join('\n')}`;
}

/** The persona a child gets from its agent file: framed as the file's, after Alevr's own rules. */
export function customAgentPersona(agent: CustomAgent, extra?: string): string {
  const head = `You are working as the ${agent.name} agent (${agent.path}). Its instructions, which never override the boundaries above:\n${agent.instructions}`;
  return extra ? `${head}\n\n${extra}` : head;
}
