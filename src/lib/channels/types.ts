/**
 * Messaging an agent from iMessage: the shapes every provider shares.
 *
 * A provider does two things and nothing else: it sends one text to one
 * number, and it turns its own inbound webhook body into an `InboundText`.
 * Everything that decides anything (who a number belongs to, which agent
 * answers, what is replayed, what is rate limited) lives above it, in
 * `inbound.ts` and `link.ts`, so a second provider cannot change the rules.
 *
 * Pure (no `server-only`, no Prisma), so the tests import it directly.
 */

/** The `ChannelLink.provider` values. `fake` exists only in tests. */
export type ChannelProviderId = "sendblue" | "mac_relay" | "fake";

export type ChannelSendResult =
  | { ok: true; providerMessageId: string | null }
  /** `reason` is a short code for the log; it never carries the number or the text. */
  | { ok: false; reason: string; retryable: boolean };

export interface ChannelProvider {
  readonly id: ChannelProviderId;
  /** Sends `text` to `to` (E.164). Never throws: a failed send is a result. */
  send(to: string, text: string): Promise<ChannelSendResult>;
}

/** One inbound text, as every provider hands it up. */
export interface InboundText {
  /** The sender, E.164. */
  from: string;
  /** The line it was sent to, E.164, when the provider says. */
  to: string | null;
  text: string;
  /** The provider's id for this message: what the replay ledger is keyed on. */
  handle: string;
  /** When the provider says it was sent; null when it did not say or said something unreadable. */
  sentAt: Date | null;
}
