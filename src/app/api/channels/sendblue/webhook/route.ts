import { NextResponse, after } from "next/server";
import { env } from "@/lib/env";
import { channelProvider } from "@/lib/channels/config";
import { answerInbound } from "@/lib/channels/inbound";
import { SENDBLUE_SECRET_HEADER } from "@/lib/channels/sendblue";
import { answerDeps, inboundDeps } from "@/lib/channels/store";
import { authenticateSendblueWebhook, handleSendblueWebhook, MAX_WEBHOOK_BYTES } from "@/lib/channels/webhook";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sendblue's receive webhook (docs/design/agents-v2/ENABLE_IMESSAGE.md).
 *
 * No session: the request is authenticated by the shared secret Sendblue
 * sends in `sb-signing-secret`, compared in constant time, before the body is
 * read. Then the gate in src/lib/channels/inbound.ts (line, date window, rate
 * per number, replay ledger, verified link) runs before the answer. The
 * agent's answer is written after the response, so a slow model never makes
 * Sendblue retry a text the ledger has already claimed.
 */
export async function POST(req: Request) {
  const provider = channelProvider();
  const secret = req.headers.get(SENDBLUE_SECRET_HEADER);
  const config = provider ? { webhookSecret: env.channels.sendblue.webhookSecret } : null;
  const refused = authenticateSendblueWebhook(secret, config);
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  try {
    const outcome = await handleSendblueWebhook({ secret, rawBody: await req.text() }, config, inboundDeps());
    if (outcome.status === 200 && outcome.admitted && provider) {
      const admitted = outcome.admitted;
      after(async () => {
        try {
          await answerInbound(admitted, answerDeps(provider));
        } catch (error) {
          console.error("[channels] answering a text failed", { error: error instanceof Error ? error.message : String(error) });
        }
      });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    // A ledger or lookup outage: 500, so Sendblue retries, and the retry is
    // still caught by the ledger if the first attempt got that far.
    console.error("[channels] inbound text failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "inbound_failed" }, { status: 500 });
  }
}
