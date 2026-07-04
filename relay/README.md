# Juno voice relay

Standalone WebSocket service that powers Juno's realtime voice mode. Both
clients (web + iOS) open ONE WebSocket here; the relay holds the actual
provider session (OpenAI Realtime, Gemini Live, Qwen Omni Realtime, or the
MiniMax composed ASR→LLM→TTS pipeline) and streams audio both ways. Provider
API keys never leave this process.

> **Not deployable on Vercel serverless** — it needs long-lived WebSockets.
> Run it on Fly.io / Railway / Render / any container host, then set
> `NEXT_PUBLIC_VOICE_RELAY_URL=wss://<host>` on the Vercel project.

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
| `GOOGLE_API_KEY` | per provider | enables `gemini` |
| `DASHSCOPE_API_KEY` | per provider | enables `qwen` (international/Singapore endpoint) |
| `MINIMAX_API_KEY` | per provider | enables `minimax` (composed pipeline; TTS may also need a Group ID on some accounts) |
| `ALLOWED_ORIGINS` | prod | comma-separated browser origins (native apps send no Origin and always pass) |
| `RELAY_OPENAI_MODEL` | no | default `gpt-realtime-2` (`gpt-realtime-mini` = ~10x cheaper) |
| `RELAY_GEMINI_MODEL` | no | default `gemini-3.1-flash-live-preview` |
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
