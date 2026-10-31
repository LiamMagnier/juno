import type { ToolResult } from '../tools/types.js';
import type { WorkProvenance, WorkRiskLevel, WorkToolDefinition, WorkToolPreview } from './types.js';

/**
 * `computer_fill_login`: fill a login the person saved for this agent into
 * the sign-in form open in its computer's browser (docs/design/agents-v2/VAULT.md).
 *
 * This package never sees a value. The host's `fill` resolves the login,
 * checks the page's origin, decrypts and types over CDP, and hands back one
 * of its own fixed sentences; this definition only decides the approval:
 *
 * - a login the person has never approved asks at `sensitive` (every approval
 *   mode, Skip included, and never covered by "Always allow");
 * - one they approved before follows the run's approval mode at `command`.
 *   The action name carries the hard-floor token "login", so "Always allow"
 *   can never cover it either (`mayHoldStandingAllowance`);
 * - a call that will only be refused (no such login, the browser on another
 *   site) is `safe`: it raises no card, and the host refuses it without
 *   typing anything.
 *
 * The risk is read from the host's snapshot, which can be stale. So the host's
 * `fill` is told whether THIS call was put to the person (`approvedNow`), and
 * fills an unapproved login only when it was: a stale "approved" can never
 * skip the first card, and a stale "elsewhere" can never fill unasked.
 */

export const FILL_LOGIN_TOOL_NAME = 'computer_fill_login';
export const FILL_LOGIN_ACTION = 'work.computer.fill_login';

/** How the host sees one call, from its snapshot of the agent's logins and the browser's current URL. */
export type FillLoginCallState = 'unknown' | 'elsewhere' | 'approved' | 'unapproved';

export interface ComputerFillLoginDeps {
  /** The tool's description, written by the host (it lists the saved logins by label and site). */
  description: string;
  /** Synchronous: the session decides the risk before anything is awaited. */
  classify(login: string): FillLoginCallState;
  /** The saved login's own label and site for the card, or null when the call names none. */
  describe(login: string): { label: string; site: string } | null;
  /** Re-reads the snapshot (after every call, so the next call's risk is current). */
  refresh(): Promise<void>;
  fill(request: { login: string; approvedNow: boolean }): Promise<{ ok: boolean; output: string }>;
  /** The takeover and lease fence, as the other computer tools read it. */
  blockedReason?(): Promise<string | null> | string | null;
  isHealthy?(): boolean;
}

const PROVENANCE: WorkProvenance = {
  source: "the agent's computer",
  sourceKind: 'local_app',
  action: FILL_LOGIN_ACTION,
  // Every output is one of the host's own sentences around the person's label.
  trust: 'trusted',
};

function loginOf(input: Record<string, unknown>): string {
  return typeof input.login === 'string' ? input.login.trim().slice(0, 200) : '';
}

function quote(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f“”"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function fillLoginSummary(described: { label: string; site: string } | null): string {
  return described ? `Sign in with your saved login “${quote(described.label)}” on ${quote(described.site)}` : 'Fill a saved login';
}

export function computerFillLoginTool(deps: ComputerFillLoginDeps): WorkToolDefinition {
  /** Calls that were put to the person (and so, if they run, were approved). */
  const asked = new Set<string>();

  const riskFor = (input: Record<string, unknown>): WorkRiskLevel => {
    switch (deps.classify(loginOf(input))) {
      case 'unknown':
      case 'elsewhere':
        return 'safe';
      case 'approved':
        return 'command';
      default:
        return 'sensitive';
    }
  };

  return {
    kind: 'edit',
    tier: 'browser_dom',
    intents: ['login.fill'],
    intentFor: () => 'login.fill',
    actionFor: () => FILL_LOGIN_ACTION,
    riskFor,
    provenanceFor: () => PROVENANCE,
    ...(deps.isHealthy ? { isHealthy: () => deps.isHealthy!() } : {}),
    spec: {
      name: FILL_LOGIN_TOOL_NAME,
      description: deps.description,
      inputSchema: {
        type: 'object',
        properties: {
          login: {
            type: 'string',
            description: 'The label of the saved login to fill (or its site, when only one login is saved for it).',
          },
        },
        required: ['login'],
      },
    },
    summarize: (input) => fillLoginSummary(deps.describe(loginOf(input))),
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      const described = deps.describe(loginOf(input));
      if (ctx.forApproval) asked.add(ctx.callId);
      return {
        summary: fillLoginSummary(described),
        ...(described ? { detail: { login: quote(described.label), site: quote(described.site) } } : {}),
      };
    },
    async execute(input, ctx): Promise<ToolResult> {
      const approvedNow = ctx.callId ? asked.delete(ctx.callId) : false;
      const blocked = deps.blockedReason ? await deps.blockedReason() : null;
      if (blocked) return { output: blocked, isError: true };
      try {
        const result = await deps.fill({ login: loginOf(input), approvedNow });
        return result.ok ? { output: result.output } : { output: result.output, isError: true };
      } finally {
        await deps.refresh().catch(() => undefined);
      }
    },
  };
}
