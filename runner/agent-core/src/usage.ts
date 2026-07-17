import type { Usage } from './types.js';

/**
 * Reports Code-mode usage to the Juno backend so it counts against the same
 * account/plan as website chat. `reserve()` runs at each turn's start
 * (consumes one message from the monthly quota — the same unit the website
 * charges); `record()` runs at turn end (adds real token counts). BYOK
 * sessions get no reporter — that usage is on the user's own key.
 */
export interface UsageReporter {
  reserve(): Promise<{ allowed: boolean; message?: string }>;
  record(model: string, usage: Usage): Promise<void>;
  /** Give back a reserved message when a turn does no billable work. */
  refund(): Promise<void>;
}

export interface BackendUsageConfig {
  /** e.g. https://chat.liams.dev/api/agent (no trailing slash) */
  baseUrl: string;
  /** Cookie header carrying the signed-in session. */
  cookie: string;
}

/** POSTs to `<baseUrl>/usage`; see the backend route for the contract. */
export class BackendUsageReporter implements UsageReporter {
  constructor(private config: BackendUsageConfig) {}

  private async post(body: Record<string, unknown>): Promise<{ status: number; error?: string } | null> {
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: this.config.cookie },
        body: JSON.stringify(body),
      });
      const data = res.ok ? {} : ((await res.json().catch(() => ({}))) as { error?: string });
      return { status: res.status, error: data.error };
    } catch {
      return null; // network failure: fail open so a flaky report can't block work
    }
  }

  async reserve(): Promise<{ allowed: boolean; message?: string }> {
    const result = await this.post({ phase: 'start' });
    // Only a real quota rejection (402) blocks the turn. A transient 401/5xx or
    // a network failure must fail OPEN — never tell the user they're out of
    // quota because the accounting endpoint blipped.
    if (result && result.status === 402) {
      return { allowed: false, message: result.error ?? "You've reached your plan's usage limit." };
    }
    return { allowed: true };
  }

  async record(model: string, usage: Usage): Promise<void> {
    await this.post({
      phase: 'record',
      model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    });
  }

  async refund(): Promise<void> {
    await this.post({ phase: 'refund' });
  }
}
