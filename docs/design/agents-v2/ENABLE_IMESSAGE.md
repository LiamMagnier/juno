# Turning on "message your agent from iMessage"

The owner's runbook, October 2026. Every step comes from the code as it is:
`src/lib/env.ts` (`env.channels.sendblue`, `isIMessageConfigured`), `src/lib/channels/`
and the four routes under `src/app/api/channels/`. Background:
`docs/design/agents-rework/FEATURES-STATUS.md` §2.

**Today it is off.** None of the four `CHANNEL_SENDBLUE_*` variables is set, so:

- Settings › Devices draws no iMessage group (`GET /api/channels/imessage` answers
  `{ "configured": false, "link": null }`);
- `POST /api/channels/imessage/link`, `/verify`, `DELETE /api/channels/imessage` and the
  webhook `POST /api/channels/sendblue/webhook` answer `404`;
- no approval is ever texted, and `notifyUser` does not even load the channel code.

All four variables or nothing: with any one empty the feature stays off.

---

## 1. What a person gets

- In Settings › Devices › iMessage they enter their number. A six-digit code arrives by
  iMessage from your Sendblue line; they type it back. Only an HMAC of the code is kept,
  for ten minutes and five tries.
- From then on they text the line. `@Scout what is on today?` reaches Scout; a text with
  no @Name reaches their first active agent. The agent answers by text, with no tools, and
  both turns appear in that agent's thread in the app.
- When something waits on their approval, the line texts "Scout is waiting for you. Open
  it here: <link>". A reply by text never approves or answers anything; only the card in
  the app does.
- Texts from a number nobody has linked get no reply at all.

## 2. The Sendblue account

1. Sign up at sendblue.co and choose a plan with an iMessage line. Sendblue assigns the
   line's number; that is `CHANNEL_SENDBLUE_FROM_NUMBER`, in E.164 (`+14155550100`).
2. Dashboard, API settings: copy the **API key id** and the **API secret key**. They sign
   every send (`sb-api-key-id` and `sb-api-secret-key` headers on
   `POST https://api.sendblue.co/api/send-message`,
   docs.sendblue.com/api/resources/messages/methods/send/).
3. Generate the webhook secret on your own machine. It is never shown again, so keep it
   only in the env:

   ```bash
   openssl rand -hex 32
   ```

## 3. The env vars

Add all four to the production environment (the `PROD_ENV` secret the deploy writes to
`.env`), then redeploy. Never commit or log them.

| Name | Value |
|---|---|
| `CHANNEL_SENDBLUE_API_KEY_ID` | the API key id from step 2.2 |
| `CHANNEL_SENDBLUE_API_SECRET_KEY` | the API secret key from step 2.2 |
| `CHANNEL_SENDBLUE_FROM_NUMBER` | the line's number, E.164 |
| `CHANNEL_SENDBLUE_WEBHOOK_SECRET` | the secret from step 2.3 |

`NEXT_PUBLIC_APP_URL` must already be the public origin: approval texts and the "open it
here" links are built from it, and a link off that origin is never sent.

No migration is needed: `ChannelLink` and `ChannelInbound` shipped in
`prisma/migrations/20260927160000_agents_rooms_channels_payments`.

## 4. The webhook

In the Sendblue dashboard, Webhooks, add a **receive** webhook:

- URL: `https://<your public origin>/api/channels/sendblue/webhook`
- Secret: the value of `CHANNEL_SENDBLUE_WEBHOOK_SECRET`. Sendblue sends it verbatim in
  the `sb-signing-secret` header (docs.sendblue.com/guides/chat-sdk-adapter/); the route
  compares it in constant time before it reads the body, and answers `401` otherwise.

Only the receive webhook is needed. Delivery-status webhooks are not used.

What the route then does with a text, in order (`src/lib/channels/inbound.ts`):

1. drops a text addressed to any other line than `CHANNEL_SENDBLUE_FROM_NUMBER`;
2. drops a text whose `date_sent` is more than 5 minutes from the server's clock, either
   way (so a captured request cannot be replayed later; keep the server on NTP);
3. counts the sender against 20 texts per 10 minutes per number, known or not;
4. claims the `message_handle`, hashed, in `ChannelInbound`; a second delivery is dropped;
5. ignores, with no reply, any number that is not a verified link.

Every one of those answers `200 { "ok": true }`, so Sendblue does not retry and nobody can
tell from the answer whether a number is linked. The agent's reply is written after the
response.

## 5. How to check it

1. **Off still off.** Before setting anything, `curl -s -o /dev/null -w '%{http_code}\n'
   -X POST https://<origin>/api/channels/sendblue/webhook` prints `404`.
2. **The secret is checked.** After the deploy, the same request prints `401`. With the
   header and an empty body it prints `200`:

   ```bash
   curl -s -X POST https://<origin>/api/channels/sendblue/webhook \
     -H "sb-signing-secret: $CHANNEL_SENDBLUE_WEBHOOK_SECRET" \
     -H 'content-type: application/json' -d '{}'
   # {"ok":true}
   ```

   Run that from your own machine with the secret in your shell, never in a shared log.
3. **Link a number.** Sign in, open Settings › Devices. The iMessage group is there. Enter
   your number; the code arrives by iMessage within a few seconds. Type it; the row reads
   "Ending in" and your last four digits, and a confirmation text arrives.
4. **Text an agent.** Text the line `@<agent name> hello`. The answer arrives by text, and
   both turns are in that agent's thread in the app. The agent's log shows "Answered a text
   from iMessage".
5. **Approvals.** Start a task that needs your approval. The approval text arrives with a
   link; reply "yes". Nothing is approved: the card in the app still waits.
6. **Strangers.** Text the line from a phone that is not linked. Nothing comes back.
7. **Unlink.** Settings › Devices › iMessage › Unlink. Texts from the number reach nobody
   from then on.

If a send fails, the server logs `[channels] approval text not sent` or the link form says
"The code could not be sent", with a reason code (`http_401`: the key pair is wrong;
`http_429`: Sendblue's rate limit), never the number or the text.

## 6. Turning it off

Empty any one of the four variables and redeploy. Links stay in the database (the
numbers encrypted) and come back if you turn it on again; to remove them, people unlink in
Settings, and account deletion cascades.

## 7. What is not built

- **The Mac relay** (`src/lib/channels/mac-relay.ts`): texting from the person's own
  Apple ID through their Mac. Its protocol is written down in that file; the provider is a
  stub that refuses to send, and nothing selects it.
- The native apps do not link a number yet; a number linked on the web works for every
  client, because texts land in the agent's ordinary thread.
- Choosing the default agent for texts without an @Name: the API takes
  `defaultAgentId` on `POST /api/channels/imessage/link`; Settings does not offer it yet,
  so the first active agent answers.
