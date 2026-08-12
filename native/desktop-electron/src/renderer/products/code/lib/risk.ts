/**
 * How each `RiskLevel` presents, and what we are allowed to say about it.
 *
 * The classification itself is made in the agent host
 * (`permissions.ts#classifyRisk`) and arrives on the event. The renderer never
 * re-derives it. In particular the sensitive-command regex table is NOT
 * duplicated here: a second copy of a security classifier is a second copy that
 * can drift, and the one that matters is the one the host enforces. What the
 * renderer contributes is the *explanation*, phrased from the level the host
 * already decided.
 */

import type { RiskLevel } from './contract.js';

export interface RiskPresentation {
  level: RiskLevel;
  label: string;
  /** Why the agent is being stopped here, in the user's terms. */
  why: string;
  /** Border/label treatment. Coral is emphasis, destructive is danger. */
  tone: 'neutral' | 'notice' | 'danger';
  /**
   * Whether the affirmative button may hold initial focus. False for
   * `sensitive`: the destructive path must never be one Return keypress away.
   */
  affirmativeMayAutofocus: boolean;
}

const PRESENTATIONS: Record<RiskLevel, RiskPresentation> = {
  safe: {
    level: 'safe',
    label: 'Read-only',
    why: 'Reads from the workspace. Nothing is modified.',
    tone: 'neutral',
    affirmativeMayAutofocus: true,
  },
  edit: {
    level: 'edit',
    label: 'File change',
    why: 'Writes to your working tree. Uncommitted changes in the target file are overwritten.',
    tone: 'notice',
    affirmativeMayAutofocus: true,
  },
  command: {
    level: 'command',
    label: 'Shell command',
    why: 'Runs a command in your workspace with your user account and your environment.',
    tone: 'notice',
    affirmativeMayAutofocus: true,
  },
  sensitive: {
    level: 'sensitive',
    label: 'Destructive',
    why:
      'The agent host flagged this as destructive, irreversible, or credential-touching. ' +
      'Actions at this level are confirmed in every mode — full access does not skip them.',
    tone: 'danger',
    affirmativeMayAutofocus: false,
  },
};

export function riskPresentation(level: RiskLevel): RiskPresentation {
  return PRESENTATIONS[level];
}
