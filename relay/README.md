# Juno voice relay

Standalone WebSocket service that powers Juno's realtime voice mode. Both
clients (web + iOS) open ONE WebSocket here; the relay holds the actual
provider session (OpenAI Realtime, Gemini Live, Qwen Omni Realtime, or the
MiniMax composed ASR→LLM→TTS pipeline) and streams audio both ways. Provider
API keys never leave this process.

> **Not deployable on Vercel serverless** — it needs long-lived WebSockets.
> In production it runs on the same GCP VM as the web app: `deploy/deploy.sh`
> builds it and PM2 runs it as `juno-voice-relay` on :8787, with nginx
> proxying `wss://chat.liams.dev/voice-relay` (see `deploy/`). The web build
> needs `NEXT_PUBLIC_VOICE_RELAY_URL=wss://chat.liams.dev/voice-relay`
> (BUILD-time inlined — requires a rebuild) and `VOICE_RELAY_URL` set to the
> same value. Fly.io / Railway / Render (`render.yaml`) work as alternatives.

## Run

```bash
cd relay
npm install
AUTH_SECRET=... GOOGLE_API_KEY=... npm run dev   # ws://localhost:8787
```

For local dev against the Next.js app, just reuse the repo's `.env` values and
set `NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8787` in `.env.local`.

## Environment

| Var | Required | Notes |
|---|---|---|
| `AUTH_SECRET` | yes | MUST equal the Juno backend's `AUTH_SECRET` (verifies the short-lived tokens minted by `/api/voice/relay-token`). |
| `OPENAI_API_KEY` | per provider | enables `openai` |
| `GEMINI_LIVE_API_KEY` | per provider | enables `gemini`. A classic `AIza…` key is used directly; a newer `AQ.…` key is not accepted as a query key by the Live socket, so the relay exchanges it for a short-lived token and connects with that. Falls back to `GOOGLE_API_KEY`. Run `npm run gemini:live-auth` to see which paths a given key can actually open. |
| `GOOGLE_API_KEY` | per provider | fallback for `gemini` when `GEMINI_LIVE_API_KEY` is unset |
| `DASHSCOPE_API_KEY` | per provider | enables `qwen` (international/Singapore endpoint) |
| `MINIMAX_API_KEY` | per provider | enables `minimax` (composed pipeline; TTS may also need a Group ID on some accounts) |
| `ALLOWED_ORIGINS` | prod | comma-separated browser origins; an empty value rejects browser origins (native apps send no Origin and pass) |
| `RELAY_MAX_SESSION_SEC` | no | relay-wide hard cap for one voice call, default 3600 seconds; never exceeds a provider's own cap and survives provider switches |
| `RELAY_OPENAI_MODEL` | no | default `gpt-live-1`. GPT-Live is per-account: an account without it accepts the upgrade and then drops the socket with no close frame (close 1006), so the relay tries GPT-Live, falls back to the Realtime protocol on failure, and says so on `session.ready`. A `gpt-realtime*` id here skips the attempt entirely. |
| `RELAY_OPENAI_BACKEND_MODEL` | no | default `gpt-5.6-luna` — the Responses model GPT-Live delegates reasoning and tools to. Billed separately from the voice layer. |
| `RELAY_OPENAI_LIVE_URL` | no | override the GPT-Live WebSocket endpoint (tests) |
| `RELAY_GEMINI_MODEL` | no | default `gemini-3.8-live` — used when thinking is OFF. Live model ids get retired; if `gemini` fails to start, the error names the model and quotes the server's close reason, so set a current id here. |
| `RELAY_GEMINI_THINKING_MODEL` | no | default `gemini-3.8-live-extended-thinking` — used when thinking is ON. |
| `RELAY_GEMINI_LIVE_URL` | no | override the Live API WebSocket endpoint (regional endpoints, tests) |
| `RELAY_GEMINI_REST_URL` | no | override the host the ephemeral-token exchange calls (tests) |
| `RELAY_QWEN_MODEL` | no | default `qwen3.5-omni-flash-realtime` |
| `RELAY_QWEN_REALTIME_URL` | no | default `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime` |
| `RELAY_MINIMAX_MODEL` / `RELAY_MINIMAX_TTS_MODEL` | no | defaults `MiniMax-M2.7-highspeed` / `speech-2.6-turbo` |

`GET /healthz` reports which providers are configured.

## Wire protocol

See `src/protocol.ts` (mirrored in the web app at `src/lib/voice-relay-protocol.ts`
and in JunoApp at `Juno/Voice/Realtime/VoiceRelayProtocol.swift` — change all
three together). Binary frames: mic PCM16LE mono 16 kHz up, model speech
PCM16LE mono 24 kHz down. JSON text frames for everything else.

## Live smoke test

```bash
npm run smoke -- gemini     # or qwen | minimax | openai
```

Starts the server in-process, connects a fake client, speaks a WAV of silence +
a text turn, and asserts audio frames and transcripts come back.

## GDPR note (Qwen)

The `qwen` provider sends user audio to Alibaba Cloud (Singapore region;
inference may run on non-China international nodes). Covered by Alibaba's GDPR
Addendum/SCCs, but disclose it in your privacy policy and consider a consent
notice when users select Qwen. See docs/voice.md in the repo root.
