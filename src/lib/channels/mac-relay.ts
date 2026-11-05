/**
 * The Mac relay: iMessage through the person's own Mac instead of a hosted
 * line. A stub. Nothing selects it yet (`channelProvider()` only ever returns
 * Sendblue), and its `send` refuses, so turning it on is a deliberate change
 * here and in the Mac app, never an env var.
 *
 * Why it exists: a hosted line is a number of its own that the person texts.
 * The relay lets them text their agents from the conversation with their own
 * Apple ID, on a Mac that is signed in to Messages, with no third party
 * holding the texts.
 *
 * The protocol, for whoever builds the Mac half:
 *
 *   Who. The Mac app's signed-in device session (the native bearer the Work
 *   host already uses). One relay per account; a second Mac that registers
 *   replaces the first. The server never learns the Mac's Apple ID password or
 *   reads Messages itself.
 *
 *   Inbound. The Mac watches Messages for texts from the account's verified
 *   `ChannelLink` number to itself and posts each one to
 *   `POST /api/channels/mac-relay/inbound` as
 *     { "handle": <Messages GUID>, "from": <E.164>, "text": <string>,
 *       "sentAt": <ISO 8601> }
 *   The server runs exactly the gate the Sendblue webhook runs (`admitInbound`
 *   in inbound.ts): the handle into the replay ledger, the `sentAt` window,
 *   the per-number rate limit, and the link lookup, which must also belong to
 *   the bearer's own account. Anything else is answered 200 and dropped.
 *
 *   Outbound. The server queues `{ "id", "to", "text" }` for the account; the
 *   Mac claims them with `GET /api/channels/mac-relay/outbox` (long poll, at
 *   most 30 s), sends each with Messages, and acknowledges with
 *   `POST /api/channels/mac-relay/outbox/<id>/ack` and `{ "ok": <bool> }`.
 *   An unacknowledged text is offered again for ten minutes, then dropped and
 *   logged; it is never sent from anywhere else.
 *
 *   Never. The Mac does not approve anything on a text's say-so, does not
 *   send to any number but the link's, and does not keep the texts after the
 *   acknowledgement.
 *
 * Pure, so the tests import it directly.
 */

import type { ChannelProvider, ChannelSendResult } from "@/lib/channels/types";

export function createMacRelayProvider(): ChannelProvider {
  return {
    id: "mac_relay",
    async send(): Promise<ChannelSendResult> {
      return { ok: false, reason: "mac_relay_not_available", retryable: false };
    },
  };
}
