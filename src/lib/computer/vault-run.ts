/**
 * The Work runner's side of the credential vault (docs/design/agents-v2/VAULT.md):
 * the snapshot `computer_fill_login` decides its approval from, and the fill
 * it runs. Built only when the vault is on and the agent has a saved login.
 *
 * The person's and the agent's ids come from the run (the server's record of
 * whose task it is), never from the model. The model's only input is a label.
 *
 * No `server-only` import and no static import of the store: the runner
 * passes the store's functions in, so this file is unit-tested on its own.
 */

import {
  fillLoginToolDescription,
  originHost,
  originMatches,
  resolveVaultEntry,
  type VaultEntry,
} from "./vault-policy";
import { createVaultFiller, type LoginPagePort, type OpenedLogin, type VaultFillAuditReason } from "./vault-fill";

/** Mirrors agent-core's `FillLoginCallState`. */
export type FillLoginCallState = "unknown" | "elsewhere" | "approved" | "unapproved";

export interface VaultRunStore {
  entries(userId: string, agentId: string): Promise<VaultEntry[]>;
  open(userId: string, agentId: string, id: string): Promise<OpenedLogin | null>;
  recordFill(input: { userId: string; agentId: string; id: string; approvedNow: boolean }): Promise<void>;
}

export interface VaultRunPort {
  description: string;
  classify(login: string): FillLoginCallState;
  describe(login: string): { label: string; site: string } | null;
  refresh(): Promise<void>;
  fill(request: { login: string; approvedNow: boolean }): Promise<{ ok: boolean; output: string }>;
  /** Removes what the vault typed in this run from text bound for the model. */
  scrubText(text: string): string;
}

/** The browser tool's outcome shape (src/lib/work/browser.ts), structurally. */
type ScrubbableOutcome =
  | { ok: false; message: string }
  | { ok: true; page: { url: string; title: string; html: string; elements: Array<{ label: string }> } };

/**
 * A `browser` result with everything the vault typed in this run removed:
 * a site that echoes the username, or mirrors a field into an attribute,
 * cannot hand it to the model through a page read.
 */
export function scrubBrowserOutcome<T extends ScrubbableOutcome>(outcome: T, scrubText: (text: string) => string): T {
  if (!outcome.ok) return { ...outcome, message: scrubText(outcome.message) };
  return {
    ...outcome,
    page: {
      ...outcome.page,
      url: scrubText(outcome.page.url),
      title: scrubText(outcome.page.title),
      html: scrubText(outcome.page.html),
      elements: outcome.page.elements.map((element) => ({ ...element, label: scrubText(element.label) })),
    },
  };
}

/** How one call looks from a snapshot and the browser's URL. Pure. */
export function classifyFillLogin(entries: readonly VaultEntry[], login: string, currentUrl: string): FillLoginCallState {
  const resolved = resolveVaultEntry(entries, login);
  if (!resolved.ok) return "unknown";
  if (!originMatches(currentUrl, resolved.entry.origin)) return "elsewhere";
  return resolved.entry.approved ? "approved" : "unapproved";
}

export async function createVaultRunPort(input: {
  userId: string;
  agentId: string;
  store: VaultRunStore;
  /** The computer's browser page, once the computer is started. */
  page(): LoginPagePort | null;
  /** The computer browser's current URL, synchronously (the session decides risk before awaiting). */
  currentUrl(): string;
  fence(): Promise<string | null>;
  audit?(event: { kind: "login_filled" | "login_refused"; reason?: VaultFillAuditReason }): void;
}): Promise<VaultRunPort | null> {
  const { userId, agentId, store } = input;
  let entries = await store.entries(userId, agentId);
  if (entries.length === 0) return null;

  const filler = createVaultFiller({
    entries: async () => (entries = await store.entries(userId, agentId)),
    open: (id) => store.open(userId, agentId, id),
    recordFill: (id, approvedNow) => store.recordFill({ userId, agentId, id, approvedNow }),
    page: input.page,
    fence: input.fence,
    audit: input.audit ? (event) => input.audit!({ kind: event.kind, ...(event.reason ? { reason: event.reason } : {}) }) : undefined,
  });

  return {
    description: fillLoginToolDescription(entries),
    classify: (login) => classifyFillLogin(entries, login, input.currentUrl()),
    describe(login) {
      const resolved = resolveVaultEntry(entries, login);
      return resolved.ok ? { label: resolved.entry.label, site: originHost(resolved.entry.origin) } : null;
    },
    async refresh() {
      entries = await store.entries(userId, agentId);
    },
    fill: ({ login, approvedNow }) => filler.fill({ ref: login, approvedNow }),
    scrubText: filler.scrubText,
  };
}
