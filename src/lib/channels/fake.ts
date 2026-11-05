/**
 * A provider for tests: it records what would have been sent and can be told
 * to fail. Never selected by configuration (`channelProvider()` knows nothing
 * of it), so it cannot reach production by an env var.
 */

import type { ChannelProvider, ChannelSendResult } from "@/lib/channels/types";

export interface FakeChannelProvider extends ChannelProvider {
  readonly sent: { to: string; text: string }[];
  /** The next sends fail with this result until it is cleared. */
  failWith: Extract<ChannelSendResult, { ok: false }> | null;
}

export function createFakeChannelProvider(): FakeChannelProvider {
  const sent: { to: string; text: string }[] = [];
  const provider: FakeChannelProvider = {
    id: "fake",
    sent,
    failWith: null,
    async send(to: string, text: string): Promise<ChannelSendResult> {
      if (provider.failWith) return provider.failWith;
      sent.push({ to, text });
      return { ok: true, providerMessageId: `fake-${sent.length}` };
    },
  };
  return provider;
}
