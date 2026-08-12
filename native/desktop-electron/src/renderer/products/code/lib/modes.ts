/**
 * Ask / Plan / Code — and what they actually mean.
 *
 * These are not presets. Each maps onto a `PermissionMode` that the agent host
 * enforces in `runner/agent-core/src/permissions.ts`. That file is the
 * authority; the copy below is a faithful reading of `PermissionEngine.decide`,
 * which resolves as:
 *
 *     deny-list hit          -> deny        (project .juno/settings.json)
 *     risk === 'sensitive'   -> ask         (ALWAYS — before any mode is consulted)
 *     mode === 'plan'        -> safe ? allow : DENY
 *     risk === 'safe'        -> allow
 *     allow-list / always    -> allow
 *     mode === 'ask'         -> ask
 *     mode === 'auto-edit'   -> edit ? allow : ask
 *     mode === 'full'        -> allow
 *
 * Two consequences the UI must convey and does:
 *
 *  1. `plan` does not *ask* about a write — it REFUSES it. That is a stronger
 *     guarantee than "you'll get a prompt", and the selector says so.
 *  2. `sensitive` is checked before the mode switch, so no mode — including
 *     `full` — can auto-run a destructive command. "Full access" is therefore
 *     an escalation of convenience, not a removal of the safety gate, and the
 *     UI must not imply otherwise.
 *
 * `full` is deliberately NOT a fourth tab. Three modes is the user's mental
 * model; `full` is an explicit opt-in *within* Code, so the difference between
 * "edits apply, commands confirm" and "commands run too" is a decision the user
 * makes on purpose rather than one hidden inside a segmented control.
 */

import type { PermissionMode, RiskLevel } from './contract.js';

export type CodeMode = 'ask' | 'plan' | 'code';

/** What a mode does with one class of action, as the engine will decide it. */
export type CapabilityState = 'allowed' | 'confirm' | 'blocked';

export interface Capability {
  /** Which risk class this row describes. */
  risk: RiskLevel;
  label: string;
  state: CapabilityState;
}

export interface ModeDescriptor {
  id: CodeMode;
  label: string;
  /** One line, present tense, describing the guarantee. */
  headline: string;
  /** The `PermissionMode` sent over `code:set-mode`. */
  permissionMode: PermissionMode;
  /**
   * Can this mode reach the filesystem at all? False only for `plan`, where
   * writes are denied outright. In `ask` a write is *possible* but only after
   * you approve it — a distinction worth keeping, because telling a user that
   * Ask "cannot write" and then showing them a write approval is how a mode
   * indicator loses its credibility.
   */
  mutationPossible: boolean;
  /** Do edits land without a prompt? True for `auto-edit` and `full`. */
  mutatesUnattended: boolean;
  /** Do shell commands run without a prompt? True only for `full`. */
  runsCommandsUnattended: boolean;
  /** The short line shown next to the mode chip, e.g. "read-only". */
  guarantee: string;
  capabilities: Capability[];
}

const SENSITIVE_ALWAYS: Capability = {
  risk: 'sensitive',
  label: 'Destructive or credential-touching commands',
  state: 'confirm',
};

export const MODES: Record<CodeMode, ModeDescriptor> = {
  ask: {
    id: 'ask',
    label: 'Ask',
    headline: 'Reads freely. Every edit and command waits for you.',
    permissionMode: 'ask',
    mutationPossible: true,
    mutatesUnattended: false,
    runsCommandsUnattended: false,
    guarantee: 'nothing changes without your approval',
    capabilities: [
      { risk: 'safe', label: 'Read files, search, list', state: 'allowed' },
      { risk: 'edit', label: 'Create or modify files', state: 'confirm' },
      { risk: 'command', label: 'Run shell commands', state: 'confirm' },
      SENSITIVE_ALWAYS,
    ],
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    headline: 'Read-only. Writes are refused, not queued.',
    permissionMode: 'plan',
    mutationPossible: false,
    mutatesUnattended: false,
    runsCommandsUnattended: false,
    guarantee: 'read-only — the host refuses writes',
    capabilities: [
      { risk: 'safe', label: 'Read files, search, list', state: 'allowed' },
      { risk: 'edit', label: 'Create or modify files', state: 'blocked' },
      { risk: 'command', label: 'Run shell commands', state: 'blocked' },
      { ...SENSITIVE_ALWAYS, state: 'blocked' },
    ],
  },
  code: {
    id: 'code',
    label: 'Code',
    headline: 'Edits apply as it works. Commands still ask.',
    permissionMode: 'auto-edit',
    mutationPossible: true,
    mutatesUnattended: true,
    runsCommandsUnattended: false,
    guarantee: 'files change without asking',
    capabilities: [
      { risk: 'safe', label: 'Read files, search, list', state: 'allowed' },
      { risk: 'edit', label: 'Create or modify files', state: 'allowed' },
      { risk: 'command', label: 'Run shell commands', state: 'confirm' },
      SENSITIVE_ALWAYS,
    ],
  },
};

export const MODE_ORDER: readonly CodeMode[] = ['ask', 'plan', 'code'];

/** Code + full access. Kept separate so the escalation is never implicit. */
export const CODE_FULL_ACCESS: ModeDescriptor = {
  id: 'code',
  label: 'Code · full access',
  headline: 'Edits and commands run without asking. Destructive commands still confirm.',
  permissionMode: 'full',
  mutationPossible: true,
  mutatesUnattended: true,
  runsCommandsUnattended: true,
  guarantee: 'files change and commands run without asking',
  capabilities: [
    { risk: 'safe', label: 'Read files, search, list', state: 'allowed' },
    { risk: 'edit', label: 'Create or modify files', state: 'allowed' },
    { risk: 'command', label: 'Run shell commands', state: 'allowed' },
    SENSITIVE_ALWAYS,
  ],
};

/** The `PermissionMode` for a UI selection. `full` is only reachable via Code. */
export function permissionModeFor(mode: CodeMode, fullAccess: boolean): PermissionMode {
  if (mode === 'code' && fullAccess) return 'full';
  return MODES[mode].permissionMode;
}

/** The descriptor for a UI selection, including the full-access variant. */
export function descriptorFor(mode: CodeMode, fullAccess: boolean): ModeDescriptor {
  return mode === 'code' && fullAccess ? CODE_FULL_ACCESS : MODES[mode];
}

/** Inverse mapping, for `mode_changed` events the host initiates. */
export function fromPermissionMode(mode: PermissionMode): { mode: CodeMode; fullAccess: boolean } {
  switch (mode) {
    case 'plan':
      return { mode: 'plan', fullAccess: false };
    case 'ask':
      return { mode: 'ask', fullAccess: false };
    case 'auto-edit':
      return { mode: 'code', fullAccess: false };
    case 'full':
      return { mode: 'code', fullAccess: true };
  }
}

/**
 * Whether an action of this risk can proceed without a prompt in this mode.
 * Mirrors `PermissionEngine.decide` minus the project allow/deny lists, which
 * live on disk in the workspace and are not visible to the renderer. Used only
 * for explanatory copy — never to decide anything.
 */
export function outcomeFor(mode: PermissionMode, risk: RiskLevel): CapabilityState {
  if (risk === 'sensitive') return mode === 'plan' ? 'blocked' : 'confirm';
  if (mode === 'plan') return risk === 'safe' ? 'allowed' : 'blocked';
  if (risk === 'safe') return 'allowed';
  switch (mode) {
    case 'ask':
      return 'confirm';
    case 'auto-edit':
      return risk === 'edit' ? 'allowed' : 'confirm';
    case 'full':
      return 'allowed';
  }
}
