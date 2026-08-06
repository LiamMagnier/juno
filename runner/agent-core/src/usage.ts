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
  private reservationId: string | null = null;

  constructor(private config: BackendUsageConfig) {}

  private async post(body: Record<string, unknown>): Promise<{
    status: number;
    error?: string;
    data?: Record<string, unknown>;
  } | null> {
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: this.config.cookie },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        status: res.status,
        error: typeof data.error === 'string' ? data.error : undefined,
        data,
      };
    } catch {
      return null;
    }
  }

  async reserve(): Promise<{ allowed: boolean; message?: string }> {
    const result = await this.post({ phase: 'start' });
    if (result && result.status === 402) {
      return { allowed: false, message: result.error ?? "You've reached your plan's usage limit." };
    }
    const reservationId = result?.data?.reservationId;
    if (!result || result.status < 200 || result.status >= 300 || typeof reservationId !== 'string' || !reservationId) {
      return { allowed: false, message: result?.error ?? 'Juno could not verify Code usage for this account.' };
    }
    this.reservationId = reservationId;
    return { allowed: true };
  }

  async record(model: string, usage: Usage): Promise<void> {
    if (!this.reservationId) return;
    await this.post({
      phase: 'record',
      reservationId: this.reservationId,
      model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    });
  }

  async refund(): Promise<void> {
    if (!this.reservationId) return;
    await this.post({ phase: 'refund', reservationId: this.reservationId });
  }
}
