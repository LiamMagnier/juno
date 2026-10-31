/**
 * A payment provider that issues pretend cards in memory, for development
 * and tests. It refuses to exist in production (`NODE_ENV=production`), and
 * the server only picks it when `AGENT_PAYMENTS_TEST_PROVIDER=1` is set
 * outside production (./config.ts). Nothing it issues can pay for anything.
 *
 * Its numbers are Stripe's documented test card prefix plus the payment's
 * sequence, so a leak test can look for exactly that string.
 */

import type { CardDetails, IssueCardInput, IssuedCard, PaymentProvider } from "./types";

export interface TestPaymentProvider extends PaymentProvider {
  /** Every card issued, for assertions. Never holds a number. */
  readonly issued: ReadonlyArray<IssueCardInput & { cardId: string; canceled: boolean }>;
  /** The number and CVC a card would reveal, for leak assertions. */
  secretsFor(cardId: string): CardDetails | null;
  /** How many times the details were revealed. */
  revealCount(): number;
}

export function createTestPaymentProvider(opts: { nodeEnv?: string } = {}): TestPaymentProvider {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") throw new Error("The test payment provider is not available in production.");
  const issued: Array<IssueCardInput & { cardId: string; canceled: boolean }> = [];
  const secrets = new Map<string, CardDetails>();
  let reveals = 0;

  return {
    name: "test",
    issued,
    secretsFor: (cardId) => secrets.get(cardId) ?? null,
    revealCount: () => reveals,

    async issueCard(input: IssueCardInput): Promise<IssuedCard> {
      const existing = issued.find((card) => card.paymentId === input.paymentId);
      const seq = existing ? issued.indexOf(existing) : issued.length;
      const cardId = existing?.cardId ?? `ic_test${String(seq + 1).padStart(6, "0")}`;
      if (!existing) {
        issued.push({ ...input, cardId, canceled: false });
        const number = `40000000${String(seq + 1).padStart(8, "0")}`;
        secrets.set(cardId, { number, cvc: String(700 + ((seq * 37) % 299)), expMonth: 12, expYear: 2031, name: "Test Agent" });
      }
      const card = secrets.get(cardId)!;
      return { cardId, last4: card.number.slice(-4), expMonth: card.expMonth, expYear: card.expYear };
    },

    async revealCard(cardId: string): Promise<CardDetails> {
      const card = secrets.get(cardId);
      const entry = issued.find((candidate) => candidate.cardId === cardId);
      if (!card || !entry || entry.canceled) throw new Error("The test card cannot be revealed.");
      reveals += 1;
      return { ...card };
    },

    async cancelCard(cardId: string): Promise<void> {
      const entry = issued.find((candidate) => candidate.cardId === cardId);
      if (entry) entry.canceled = true;
    },
  };
}
