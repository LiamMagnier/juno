/**
 * `fillPaymentCard(agentId, cardRef)`: types an approved card's details into
 * the agent's own computer browser, and nowhere else.
 *
 * The details are revealed by the provider here, handed to the filler, and
 * dropped. They are never returned, logged, stored or put in an event: what
 * comes back is which kinds of field were filled, and sentences written here.
 *
 * Where to type is a registration point (`registerPaymentCardFiller`). The
 * computer layer registers the real one (./computer-fill.ts: the agent's
 * Chromium over CDP, found server-side from `(userId, agentId)`); tests
 * register a fake. When no filler can reach a computer, or the page in front
 * has no card fields, the card is held (status `held`) and the person is told;
 * a held card can be filled once later, and is cancelled at its expiry either
 * way.
 *
 * Order matters and is pinned by tests/payments.test.ts:
 *   1. the filler finds the card fields (no secret involved yet);
 *   2. the payment is claimed (`issued | held` → `filled`), so two fills can
 *      never type one card into two pages;
 *   3. only then are the details revealed and typed;
 *   4. a fill that fails puts the claim back (`filled` → `held`).
 */

import type { CardFieldKind } from "./card-fields";
import { scrubCardDetails } from "./policy";
import type { PaymentStore } from "./store";
import type { CardDetails, PaymentProvider } from "./types";

export type FillerUnavailable = { ok: false; reason: "no_computer" | "asleep" | "taken_over" | "unsupported"; message: string };

export interface CardFiller {
  /** Finds the card fields on the page in front. Never sees a card. */
  locate(): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Types the details. Returns which kinds it filled, never the values. */
  fill(details: CardDetails): Promise<{ ok: true; filled: CardFieldKind[] } | { ok: false; message: string }>;
  close(): Promise<void>;
}

export type CardFillerResolver = (input: { userId: string; agentId: string }) => Promise<{ ok: true; filler: CardFiller } | FillerUnavailable>;

let registered: CardFillerResolver | null = null;

/** The computer layer (or a test) says how to reach an agent's browser. */
export function registerPaymentCardFiller(resolver: CardFillerResolver | null): void {
  registered = resolver;
}

export function registeredPaymentCardFiller(): CardFillerResolver | null {
  return registered;
}

export type FillOutcome =
  | { kind: "filled"; filled: CardFieldKind[]; message: string }
  | { kind: "held"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "refused"; message: string };

export const FILL_COPY = {
  filled: "The card is typed into the checkout on the agent's computer. Nothing has been paid until the merchant's own pay button is pressed.",
  noComputer: "The card is ready, but this agent has no computer turned on to type it into. Turn the computer on, open the checkout there, then ask the agent to fill the card.",
  noFields: "The card is ready, but the page open on the agent's computer has no card fields. Open the checkout there, then ask the agent to fill the card.",
  failed: "The card is ready, but it could not be typed into the page. Check the checkout on the agent's computer, then ask the agent to fill the card again.",
  expired: "This card expired before it was used, so it was cancelled. Nothing was paid.",
  notFillable: "This card was already typed in, used or cancelled, so it cannot be filled again.",
  notFound: "There is no card ready for this agent with that reference.",
  revealFailed: "The card details could not be fetched from the card provider. Nothing was typed.",
} as const;

export async function fillPaymentCard(
  agentId: string,
  cardRef: string,
  ctx: {
    userId: string;
    store: PaymentStore;
    provider: PaymentProvider;
    resolver?: CardFillerResolver | null;
    now?: () => Date;
  },
): Promise<FillOutcome> {
  const now = ctx.now ?? (() => new Date());
  const payment = await ctx.store.find(ctx.userId, cardRef);
  // The agent and the account both come from the server, never the model:
  // a reference to another agent's card is the same as no card.
  if (!payment || payment.agentId !== agentId || !payment.providerCardId) return { kind: "refused", message: FILL_COPY.notFound };
  if (payment.status !== "issued" && payment.status !== "held") return { kind: "refused", message: FILL_COPY.notFillable };
  if (!payment.expiresAt || payment.expiresAt.getTime() <= now().getTime()) {
    if (await ctx.store.transition(ctx.userId, payment.id, ["issued", "held"], { status: "expired" })) {
      await ctx.provider.cancelCard(payment.providerCardId).catch(() => undefined);
    }
    return { kind: "expired", message: FILL_COPY.expired };
  }

  const hold = async (message: string): Promise<FillOutcome> => {
    await ctx.store.transition(ctx.userId, payment.id, ["issued"], { status: "held" });
    return { kind: "held", message };
  };

  const resolver = ctx.resolver === undefined ? registered : ctx.resolver;
  if (!resolver) return hold(FILL_COPY.noComputer);
  const reached = await resolver({ userId: ctx.userId, agentId }).catch(
    (): FillerUnavailable => ({ ok: false, reason: "no_computer", message: FILL_COPY.noComputer }),
  );
  if (!reached.ok) return hold(reached.message);
  const filler = reached.filler;
  try {
    const located = await filler.locate().catch(() => ({ ok: false as const, message: FILL_COPY.noFields }));
    if (!located.ok) return await hold(located.message);

    if (!(await ctx.store.transition(ctx.userId, payment.id, ["issued", "held"], { status: "filled" }))) {
      return { kind: "refused", message: FILL_COPY.notFillable };
    }

    const details = await ctx.provider.revealCard(payment.providerCardId).catch(() => null);
    if (!details) {
      await ctx.store.transition(ctx.userId, payment.id, ["filled"], { status: "held" });
      return { kind: "held", message: FILL_COPY.revealFailed };
    }
    let typed: Awaited<ReturnType<CardFiller["fill"]>>;
    try {
      typed = await filler.fill(details);
    } catch {
      typed = { ok: false, message: FILL_COPY.failed };
    }
    // Whatever the filler said about the page is scrubbed of the card before it travels on.
    const scrubbed = typed.ok ? typed : { ok: false as const, message: scrubCardDetails(typed.message, details) };
    if (!scrubbed.ok) {
      await ctx.store.transition(ctx.userId, payment.id, ["filled"], { status: "held" });
      return { kind: "held", message: scrubbed.message };
    }
    return { kind: "filled", filled: scrubbed.filled, message: FILL_COPY.filled };
  } finally {
    await filler.close().catch(() => undefined);
  }
}
