# Juno realtime voice

True speech-to-speech voice mode across four providers, on web and iOS, via a
backend relay (`relay/`). Clients speak ONE WebSocket protocol; the relay holds
the provider session and every API key.

```
web / iOS ──(one WS: PCM16 up @16k, PCM16 down @24k, JSON events)──▶ relay
                                                    relay ──▶ OpenAI Realtime (WS)
                                                    relay ──▶ Gemini Live (WS, auto-reconnect via resumption handles)
                                                    relay ──▶ Qwen Omni Realtime (WS, OpenAI-Realtime dialect)
                                                    relay ──▶ MiniMax composed (client STT → M-series LLM → T2A WS TTS)
```

MiniMax has no public speech-to-speech API (verified 2026-07-04) — its adapter
is an honest cascaded pipeline and is labeled `trueS2S: false`; the client's
on-device speech recognition supplies the user transcript for it.

## Deploying

1. Deploy `relay/` (Dockerfile included) to any long-lived-connection host
   (Fly.io/Railway/Render — NOT Vercel serverless). Set `AUTH_SECRET` to the
   same value as the Vercel project, plus the provider keys you want enabled
   and `ALLOWED_ORIGINS=https://juno-zeta-navy.vercel.app`.
2. Set `NEXT_PUBLIC_VOICE_RELAY_URL=wss://<relay-host>` on Vercel and redeploy.
   The web voice button then opens realtime voice (legacy voice mode remains
   the fallback when unset).
3. iOS: set the production case of `BackendConfiguration.voiceRelayURL` in
   JunoApp (currently nil = feature hidden).

Local dev: `cd relay && RELAY_ENABLE_MOCK=1 npm run dev`, set
`NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8787` in `.env.local`. The `mock`
provider needs no API keys and exercises the full pipeline.

## Provider account prerequisites (state as of 2026-07-04)

| Provider | Needs | Status on this account |
|---|---|---|
| OpenAI | active quota | ❌ quota exhausted (429) |
| Gemini | a CLASSIC AI Studio API key (`AIza…`) — the current `AQ.…`-format key only works on the OpenAI-compat surface, which ALSO breaks the existing Gemini web-search path | ❌ mint at aistudio.google.com/apikey → set `GEMINI_LIVE_API_KEY` (relay) and consider replacing `GOOGLE_API_KEY` |
| Qwen | valid DashScope intl key + Model Studio activated (Singapore) | ❌ current key rejected even for chat |
| MiniMax | token plan credit (LLM + TTS) | ❌ "Token Plan usage limit reached" |

Every provider failure surfaces as a clean in-UI error; the relay never
crashes on a provider issue.

## GDPR note — Qwen

Selecting Qwen sends user AUDIO to Alibaba Cloud: stored in the Singapore
region, inference possibly on other non-China international nodes. Legally
workable under Alibaba's GDPR Addendum (SCCs, Art. 46), but it must be listed
in the privacy policy / records of processing, and a consent notice when the
user picks Qwen is recommended. EU-only processing would require self-hosting
Qwen3-Omni-30B-A3B (Apache-2.0, ~80–145 GB VRAM via vLLM-Omni).

## Session limits

Relay enforces per-provider ceilings and tells clients (`session.closed`,
reason `session-limit`): OpenAI 60 min, Gemini 15 min (relay transparently
rides Gemini's ~10-min connection cycling via resumption handles), Qwen 120
min (per-model turn caps apply upstream), MiniMax 120 min.
