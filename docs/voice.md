# Juno voice

## Read-aloud and dictation (NOT the realtime relay)

These are separate from the speech-to-speech relay documented below, and they
degrade **silently**: with no `TTS_PROVIDER` / `STT_PROVIDER` set, the client
falls back to the browser's Web Speech API — the OS voice, which reads French
with an English accent and transcribes non-English dictation badly.

| Feature    | Route             | Model (default)     | Fallback when unset      |
| ---------- | ----------------- | ------------------- | ------------------------ |
| Read aloud | `/api/voice/tts`  | `gpt-4o-mini-tts`   | `window.speechSynthesis` |
| Dictation  | `/api/voice/stt`  | `gpt-4o-transcribe` | Web Speech recognition   |

Set `OPENAI_API_KEY`, `STT_PROVIDER=openai`, `TTS_PROVIDER=openai` to enable
both. Overrides: `STT_MODEL`, `TTS_MODEL`, `TTS_VOICE`.

Notes:

- Dictation records audio with `MediaRecorder` **alongside** Web Speech: Web
  Speech drives only the live preview, and the final transcript is always
  re-transcribed server-side. It sends the browser locale as a `language` hint,
  which is the single biggest accuracy win for French.
- `gpt-4o-transcribe` falls back to `whisper-1` automatically if the account
  rejects it.
- TTS passes an `instructions` string telling the model to read in the text's own
  language (only the `gpt-4o*-tts` line accepts `instructions`).
- The bootstrap exposes `features.serverStt` / `features.serverTts` so the UI can
  tell whether it is about to use a real model or the OS voice.

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

The relay ships WITH the web app on the GCP VM — `deploy/deploy.sh` builds
`relay/` (`npm ci` + `npm run build`) and runs it under PM2 as
`juno-voice-relay` on :8787 (`deploy/ecosystem.config.js` feeds it
`AUTH_SECRET`, provider keys and `RELAY_*` vars parsed from the repo `.env`,
plus `ALLOWED_ORIGINS=https://chat.liams.dev,http://localhost:3000`). Nginx
proxies `wss://chat.liams.dev/voice-relay` to it with WebSocket upgrade
headers and a 2h read timeout (`deploy/nginx.conf.template`); check it with
`curl https://chat.liams.dev/voice-relay/healthz`.

The production web build needs BOTH of these in the VM's `.env`:

1. `NEXT_PUBLIC_VOICE_RELAY_URL=wss://chat.liams.dev/voice-relay` — inlined at
   BUILD time into the client bundle (gates the voice button), so changing it
   requires `npm run build` / a redeploy, not just a PM2 restart.
2. `VOICE_RELAY_URL=wss://chat.liams.dev/voice-relay` — runtime fallback read
   by `/api/voice/relay-token`, which also polls the relay's `/healthz` to
   report per-provider availability to the client.

Gemini Live needs a CLASSIC AI Studio key (`AIza…`, mint at
aistudio.google.com/apikey) in `GEMINI_LIVE_API_KEY` — the newer `AQ.…`-format
keys are rejected by the Live API.

iOS: set the production case of `BackendConfiguration.voiceRelayURL` in
JunoApp (currently nil = feature hidden). Render deployment (`render.yaml`)
remains available as an alternative host.

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
