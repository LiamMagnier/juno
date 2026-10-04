import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionMode, RiskLevel } from './types.js';
import type { ToolDefinition } from './tools/types.js';
import { assertContainedPath } from './tools/fs.js';
import {
  PermissionRule,
  PermissionRuleSet,
  patternsCanVouch,
  type PermissionRuleDecision,
  type PermissionRuleSubject,
} from './permission-rules.js';

export {
  PermissionRule,
  PermissionRuleSet,
  ShellSegments,
  patternsCanVouch,
  type PermissionRuleDecision,
  type PermissionRuleSubject,
} from './permission-rules.js';

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

// MARK: - The ladder

/**
 * The Mac's five risk tiers (`ActionRisk` in PermissionModel.swift), which the
 * ladder is written against. This engine's four map onto them; `critical` has
 * no producer here yet and is ruled on all the same, so the shared fixture can
 * hold the whole ladder.
 */
export type ActionRisk = 'read' | 'write' | 'execute' | 'critical' | 'destructive';

export function actionRiskOf(risk: RiskLevel): ActionRisk {
  switch (risk) {
    case 'safe':
      return 'read';
    case 'edit':
      return 'write';
    case 'command':
      return 'execute';
    case 'sensitive':
      return 'destructive';
  }
}

export type PermissionOutcome = 'allow' | 'ask' | 'deny';

/**
 * The mode ladder, as `PermissionPolicy.ruling` has it.
 *
 * Plan refuses rather than asks, and comes first for that reason: below the
 * destructive rule, a read-only session would offer an approval prompt for the
 * most dangerous class of action, and answering it would carry the action out.
 * Everywhere else `destructive` asks, in every mode, Full Access included.
 */
export function ladderRuling(mode: PermissionMode, risk: ActionRisk): PermissionOutcome {
  if (mode === 'plan') return risk === 'read' ? 'allow' : 'deny';
  if (risk === 'destructive') return 'ask';
  switch (mode) {
    case 'ask':
      return risk === 'read' ? 'allow' : 'ask';
    case 'auto-edit':
      return risk === 'read' || risk === 'write' ? 'allow' : 'ask';
    case 'full':
      return 'allow';
  }
}

/**
 * The ladder with the rules applied on top (`PermissionCoordinator.ruling`).
 *
 * - A deny rule refuses, whatever the mode.
 * - An ask rule prompts, even in Full Access — but cannot turn a plan
 *   session's refusal into an offer.
 * - An allow rule proceeds without asking, but never past the ladder's own
 *   refusal and never silences a destructive action.
 */
export function permissionRuling(
  mode: PermissionMode,
  risk: ActionRisk,
  rule: PermissionRuleDecision | null,
): PermissionOutcome {
  const ladder = ladderRuling(mode, risk);
  if (rule === null) return ladder;
  if (rule.decision === 'deny') return 'deny';
  if (ladder === 'deny') return 'deny';
  if (rule.decision === 'ask') return 'ask';
  return risk === 'destructive' ? 'ask' : 'allow';
}

// MARK: - Subjects

/**
 * What a rule sees of one invocation of this engine's tools: the command a
 * `bash` call runs, the workspace-relative path a file tool touches.
 *
 * Relative to the canonical workspace root, because that is how a reader
 * writes `Edit(src/**)` — and because the model is free to spell one file
 * `src/a.ts`, `./src/a.ts` or `/tmp/work/src/a.ts`, and a deny rule that held
 * for only one spelling would hold for none.
 */
export function ruleSubjectFor(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRuleSubject | null {
  switch (toolName) {
    case 'bash':
      return typeof input.command === 'string' ? { command: input.command } : null;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return typeof input.path === 'string' ? { path: workspaceRelative(cwd, input.path) } : null;
    default:
      return null;
  }
}

function workspaceRelative(cwd: string, candidate: string): string {
  try {
    const canonical = assertContainedPath({ cwd }, candidate);
    return path.relative(fs.realpathSync(cwd), canonical).split(path.sep).join('/');
  } catch {
    // Outside the workspace, or unreadable: the tool itself refuses such a
    // path, so the spelling the model used is as good a subject as any.
    return candidate;
  }
}

// MARK: - Settings files

/** Where a settings file sits, which decides how far it may be trusted. */
export type SettingsOrigin = 'user' | 'project' | 'local';

export interface SettingsLayer {
  origin: SettingsOrigin;
  /** Rules as written in the file. */
  rules: PermissionRuleSet;
  /** The reader approved this project file as it now reads. */
  approved: boolean;
}

/**
 * The rules a session runs with, from its settings layers, lowest first
 * (the permission half of `ResolvedCodeSettings.resolve`).
 *
 * **Trust.** A project's files are not the reader's: `.juno/settings.json`
 * arrives with a clone and `.juno/settings.local.json` lives in the folder the
 * agent edits. Until the reader approves one, it may only narrow — its ask and
 * deny rules apply, its allow rules do not. The reader's own file always
 * applies whole.
 */
export function resolveRuleLayers(layers: readonly SettingsLayer[]): PermissionRuleSet {
  let resolved = PermissionRuleSet.empty;
  for (const layer of layers) {
    const mayLoosen = layer.origin === 'user' || layer.approved;
    resolved = resolved.merging(
      new PermissionRuleSet({
        allow: mayLoosen ? layer.rules.allow : [],
        ask: layer.rules.ask,
        deny: layer.rules.deny,
      }),
    );
  }
  return resolved;
}

/**
 * One settings file's rules.
 *
 * `permissions.{allow,ask,deny}` is the schema the Mac reads (CodeSettings.swift).
 * The top-level `allow` / `deny` lists of tool names are this engine's older
 * schema, still read so a repository written for it keeps its denials — a bare
 * tool name is a rule of its own in the grammar. One bad entry is skipped, not
 * the file.
 */
export function parseSettingsRules(raw: unknown): PermissionRuleSet {
  if (raw === null || typeof raw !== 'object') return PermissionRuleSet.empty;
  const file = raw as Record<string, unknown>;
  const permissions =
    file.permissions !== null && typeof file.permissions === 'object'
      ? (file.permissions as Record<string, unknown>)
      : {};
  const rules = (value: unknown): PermissionRule[] =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const rule = typeof entry === 'string' ? PermissionRule.parse(entry) : null;
          return rule ? [rule] : [];
        })
      : [];
  return new PermissionRuleSet({
    allow: [...rules(permissions.allow), ...rules(file.allow)],
    ask: rules(permissions.ask),
    deny: [...rules(permissions.deny), ...rules(file.deny)],
  });
}

function readSettingsFile(file: string): PermissionRuleSet | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSettingsRules(JSON.parse(text));
  } catch {
    return PermissionRuleSet.empty;
  }
}

export interface PermissionEngineOptions {
  /**
   * Whether this session's host has had the reader approve the project's own
   * settings files, so their allow rules may widen what the agent does.
   *
   * False unless a host says otherwise, and the cloud runner never does: a
   * cloud run's mode is a control its submitter chose, and a repository must
   * not be able to raise it — only to ask more or refuse.
   */
  trustProjectSettings?: boolean;
  /** The reader's own settings file. Defaults to `$JUNO_HOME/settings.json`;
   *  null reads none. */
  userSettingsFile?: string | null;
}

/** Every settings layer that applies to a session in `cwd`, lowest first. */
export function loadSettingsLayers(cwd: string, options: PermissionEngineOptions = {}): SettingsLayer[] {
  const layers: SettingsLayer[] = [];
  const userFile =
    options.userSettingsFile === undefined
      ? path.join(process.env.JUNO_HOME ?? path.join(os.homedir(), '.juno'), 'settings.json')
      : options.userSettingsFile;
  const approved = options.trustProjectSettings === true;
  const candidates: Array<{ origin: SettingsOrigin; file: string | null }> = [
    { origin: 'user', file: userFile },
    { origin: 'project', file: path.join(cwd, '.juno', 'settings.json') },
    { origin: 'local', file: path.join(cwd, '.juno', 'settings.local.json') },
  ];
  for (const { origin, file } of candidates) {
    if (file === null) continue;
    const rules = readSettingsFile(file);
    if (rules) layers.push({ origin, rules, approved: origin === 'user' || approved });
  }
  return layers;
}

/**
 * The rules a session in `cwd` runs with: the reader's own file, then the
 * project's two, with the project's allow rules left out unless trusted.
 */
export function loadProjectRules(cwd: string, options: PermissionEngineOptions = {}): PermissionRuleSet {
  return resolveRuleLayers(loadSettingsLayers(cwd, options));
}

// MARK: - Engine

export class PermissionEngine {
  private rules: PermissionRuleSet;

  constructor(cwd: string, options: PermissionEngineOptions = {}, resolved?: PermissionRuleSet) {
    this.rules = resolved ?? loadProjectRules(cwd, options);
  }

  /** An engine over rules already resolved — a child agent inherits its
   *  parent's, "Always allow" answers included. */
  static withRules(rules: PermissionRuleSet): PermissionEngine {
    return new PermissionEngine('', {}, rules);
  }

  get ruleSet(): PermissionRuleSet {
    return this.rules;
  }

  /**
   * "Always allow" for the rest of the session: the narrowest rule that covers
   * what the reader saw (`Bash(npm run *)` for `npm run build`), not every use
   * of the tool. Returns the rule saved, or null when no saved rule could ever
   * apply — a command line whose substitutions a pattern cannot see into is
   * approved once.
   */
  grantAlways(toolName: string, subject: PermissionRuleSubject | null = null): PermissionRule | null {
    if (!patternsCanVouch(subject)) return null;
    const rule = PermissionRuleSet.suggestedRule(toolName, subject);
    this.rules = this.rules.merging(new PermissionRuleSet({ allow: [rule] }));
    return rule;
  }

  decide(
    mode: PermissionMode,
    toolName: string,
    risk: RiskLevel,
    subject: PermissionRuleSubject | null = null,
  ): PermissionOutcome {
    return permissionRuling(mode, actionRiskOf(risk), this.rules.evaluate(toolName, subject));
  }

  /** Why `decide` refused, in a sentence for the transcript. */
  denialReason(
    mode: PermissionMode,
    toolName: string,
    subject: PermissionRuleSubject | null = null,
  ): string {
    const rule = this.rules.evaluate(toolName, subject);
    if (rule?.decision === 'deny') return `Denied: blocked by the permission rule ${rule.rule.toString()}.`;
    if (mode === 'plan') return 'Denied: plan mode only allows read-only tools.';
    return 'Denied by the permission rules.';
  }
}

// MARK: - Nobody attached

/**
 * The answer an UNATTENDED Code run gives its own approval requests
 * (scripts/cloud-code-runner.mjs): no person is there, so the mode decides.
 *
 * Full Access allows what the ladder sent up — except a `sensitive` action,
 * which the shared floor (BRIEF §6, contracts/permissions/permission-taxonomy.v1.json)
 * says asks a person under every mode. With nobody to ask, the only honest
 * answer is no: a force-push, `git reset --hard` or `curl | sh` never runs
 * silently because the composer said "Full access". Every narrower mode denies,
 * as before.
 */
export function unattendedApprovalAnswer(mode: PermissionMode, risk: RiskLevel): 'allow' | 'deny' {
  if (risk === 'sensitive') return 'deny';
  return mode === 'full' ? 'allow' : 'deny';
}

/**
 * Whether an "allow_always" answer may become a session rule for this risk
 * ("Allow for this task" in the shared vocabulary). Never for a sensitive
 * action: that tier is pinned to "Allow once" (BRIEF §6).
 */
export function mayGrantAlways(risk: RiskLevel): boolean {
  return risk !== 'sensitive';
}
