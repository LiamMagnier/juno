/**
 * Which iMessage provider this server uses: Sendblue when all four
 * `CHANNEL_SENDBLUE_*` variables are set, otherwise none, and then every
 * channel route answers as if the feature did not exist (docs/design/agents-v2/
 * ENABLE_IMESSAGE.md). The Mac relay and the test fake are never chosen here.
 */

import { env, isIMessageConfigured } from "@/lib/env";
import { createSendblueProvider } from "@/lib/channels/sendblue";
import type { ChannelProvider } from "@/lib/channels/types";

export function channelProvider(): ChannelProvider | null {
  if (!isIMessageConfigured()) return null;
  const s = env.channels.sendblue;
  return createSendblueProvider({ apiKeyId: s.apiKeyId, apiSecretKey: s.apiSecretKey, fromNumber: s.fromNumber });
}
