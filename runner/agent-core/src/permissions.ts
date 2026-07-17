import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode, RiskLevel } from './types.js';
import type { ToolDefinition } from './tools/types.js';

/**
 * Deterministic sensitive-action detection. These always require confirmation,
 * even in full-access mode — matching the spec's non-negotiable safety gate.
 */
const SENSITIVE_COMMAND_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: 'recursive force delete' },
  { re: /\bsudo\b/, why: 'privilege escalation' },
  { re: /\bgit\s+push\b.*(--force|\s-f\b)/, why: 'git force-push' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'discards local changes' },
  { re: /\bgit\s+clean\b.*-[a-z]*f/, why: 'deletes untracked files' },
  { re: /\bchmod\s+(-R\s+)?777\b/, why: 'world-writable permissions' },
  { re: /\b(mkfs|diskutil\s+erase|dd\s+if=)/i, why: 'disk-level operation' },
  { re: /\b(shutdown|reboot|halt)\b/, why: 'system power control' },
  { re: /\bkillall\b/, why: 'mass process kill' },
  { re: /(curl|wget)[^|;&]*\|\s*(ba)?sh\b/, why: 'pipes remote content into a shell' },
  { re: /(^|[\s/])\.ssh\b|\.aws\b|\.gnupg\b/, why: 'touches credential directory' },
  { re: /\.env(\.[a-z]+)?\b.*(cat|cp|curl|scp|nc)\b|(cat|cp|curl|scp|nc)\b.*\.env(\.[a-z]+)?\b/, why: 'reads or ships env secrets' },
  { re: /security\s+(find|dump)-[a-z-]*keychain/i, why: 'keychain access' },
  { re: />\s*\/dev\/(sd|disk|rdisk)/, why: 'writes to raw device' },
];

export function classifySensitiveCommand(command: string): string | null {
  for (const { re, why } of SENSITIVE_COMMAND_PATTERNS) {
    if (re.test(command)) return why;
  }
  return null;
}

export function classifyRisk(tool: ToolDefinition, input: Record<string, unknown>): {
  risk: RiskLevel;
  reason: string;
} {
  if (tool.kind === 'read') return { risk: 'safe', reason: 'read-only' };
  if (tool.kind === 'edit') return { risk: 'edit', reason: 'modifies files' };
  const why = tool.spec.name === 'bash' ? classifySensitiveCommand(String(input.command ?? '')) : null;
  if (why) return { risk: 'sensitive', reason: why };
  return { risk: 'command', reason: 'runs a shell command' };
}

export interface ProjectPermissionRules {
  allow: string[];
  deny: string[];
}

export function loadProjectRules(cwd: string): ProjectPermissionRules {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.juno', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectPermissionRules>;
    return { allow: parsed.allow ?? [], deny: parsed.deny ?? [] };
  } catch {
    return { allow: [], deny: [] };
  }
}

export type PermissionOutcome = 'allow' | 'ask' | 'deny';

export class PermissionEngine {
  private alwaysAllowed = new Set<string>();
  private rules: ProjectPermissionRules;

  constructor(cwd: string) {
    this.rules = loadProjectRules(cwd);
  }

  grantAlways(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  decide(mode: PermissionMode, toolName: string, risk: RiskLevel): PermissionOutcome {
    if (this.rules.deny.includes(toolName)) return 'deny';
    // Sensitive actions always confirm — no mode and no allowlist bypasses this.
    if (risk === 'sensitive') return 'ask';
    if (mode === 'plan') return risk === 'safe' ? 'allow' : 'deny';
    if (risk === 'safe') return 'allow';
    if (this.rules.allow.includes(toolName) || this.alwaysAllowed.has(toolName)) return 'allow';
    switch (mode) {
      case 'ask':
        return 'ask';
      case 'auto-edit':
        return risk === 'edit' ? 'allow' : 'ask';
      case 'full':
        return 'allow';
    }
  }
}
