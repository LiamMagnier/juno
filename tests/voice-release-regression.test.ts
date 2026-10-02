import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const relayVerifier = readFileSync(new URL("../scripts/verify-voice-relay.mjs", import.meta.url), "utf8");
const tokenRoute = readFileSync(new URL("../src/app/api/voice/relay-token/route.ts", import.meta.url), "utf8");
const contextRoute = readFileSync(new URL("../src/app/api/voice/context/route.ts", import.meta.url), "utf8");
const transcriptRoute = readFileSync(new URL("../src/app/api/voice/transcript/route.ts", import.meta.url), "utf8");
const accessPolicy = readFileSync(new URL("../src/lib/voice-access-policy.ts", import.meta.url), "utf8");
const nativeComposer = readFileSync(new URL("../native/iOS/JunoMobile/App/JunoMobileComposer.swift", import.meta.url), "utf8");
const nativeAttachmentModel = readFileSync(
  new URL("../native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeComposerAttachmentModel.swift", import.meta.url),
  "utf8",
);
const productionSmoke = readFileSync(new URL("../scripts/production-smoke.mjs", import.meta.url), "utf8");
const voiceHook = readFileSync(new URL("../src/hooks/use-realtime-voice.ts", import.meta.url), "utf8");
const chatView = readFileSync(new URL("../src/components/chat/chat-view.tsx", import.meta.url), "utf8");
const chatComposer = readFileSync(new URL("../src/components/chat/composer.tsx", import.meta.url), "utf8");
const geminiLive = readFileSync(new URL("../relay/src/providers/gemini-live.ts", import.meta.url), "utf8");
const gptLive = readFileSync(new URL("../relay/src/providers/gpt-live.ts", import.meta.url), "utf8");
const relayRegistry = readFileSync(new URL("../relay/src/providers/registry.ts", import.meta.url), "utf8");
const relaySession = readFileSync(new URL("../relay/src/session.ts", import.meta.url), "utf8");
const openaiVoice = readFileSync(new URL("../relay/src/providers/openai-voice.ts", import.meta.url), "utf8");
const voiceBar = readFileSync(new URL("../src/components/voice/realtime-voice.tsx", import.meta.url), "utf8");

test("voice relay verifier resolves ws from the standalone relay package", () => {
  assert.match(relayVerifier, /createRequire\(new URL\(["']\.\.\/relay\/package\.json["']/);
  assert.match(relayVerifier, /relayRequire\(["']ws["']\)/);
  assert.doesNotMatch(relayVerifier, /import\s+\{\s*WebSocket\s*\}\s+from\s+["']ws["']/);
});

test("voice relay verifier loads the immutable release env before checking auth", () => {
  assert.match(relayVerifier, /loadEnv\(path\.join\(ROOT, ["']\.env["']\)\)/);
  assert.match(relayVerifier, /const env = \{ \.\.\.fileEnv, \.\.\.process\.env \}/);
  assert.match(relayVerifier, /AUTH_SECRET/);
  assert.match(relayVerifier, /verifyWebSocketHandshake/);
});

test("owner voice access bypasses plan and spend gates without bypassing authentication", () => {
  const userLookup = tokenRoute.indexOf("const user = await getCurrentUser()");
  const policyLookup = tokenRoute.indexOf("evaluateVoiceAccess(user, \"relay-token\")");
  assert.ok(userLookup >= 0, "voice route must still require an authenticated user");
  assert.ok(policyLookup > userLookup, "canonical access policy must run only after authentication");
  assert.match(accessPolicy, /const owner = isOwnerEmail\(user\.email\)/);
  assert.match(accessPolicy, /if \(!owner && !PLANS\[plan\]\.voice\)/);
  assert.match(accessPolicy, /if \(owner\) return \{ allowed: true, owner, plan \}/);
  assert.match(accessPolicy, /surface === ["']relay-token["']/);
  assert.match(accessPolicy, /checkBudget\(user\.id, plan\)/);
});

test("every user-authenticated Voice route uses the canonical access policy", () => {
  assert.match(tokenRoute, /evaluateVoiceAccess\(user, ["']relay-token["']\)/);
  assert.match(contextRoute, /evaluateVoiceAccess\(user, ["']context["']\)/);
  assert.match(transcriptRoute, /evaluateVoiceAccess\(user, ["']transcript["']\)/);
});

test("voice token route derives the canonical same-origin relay when explicit env is absent", () => {
  assert.match(tokenRoute, /NEXT_PUBLIC_VOICE_RELAY_URL/);
  assert.match(tokenRoute, /VOICE_RELAY_URL/);
  assert.match(tokenRoute, /NEXT_PUBLIC_APP_URL/);
  assert.match(tokenRoute, /url\.pathname = ["']\/voice-relay["']/);
  assert.match(tokenRoute, /https:["']\) url\.protocol = ["']wss:/);
});

test("production chat smoke does not confuse a non-voice smoke plan with dead relay infrastructure", () => {
  assert.match(productionSmoke, /JUNO_SMOKE_REQUIRE_VOICE_TOKEN/);
  assert.match(productionSmoke, /voiceTokenResponse\.status === 403/);
  assert.match(productionSmoke, /smoke account is not Voice-enabled/);
  assert.match(productionSmoke, /voice relay-token returned a non-WebSocket URL/);
});

test("voice document context remains owner-scoped and honest about parser state", () => {
  assert.match(contextRoute, /userId:\s*user\.id/);
  assert.match(contextRoute, /messageId:\s*null/);
  assert.match(contextRoute, /deletedAt:\s*null/);
  assert.match(contextRoute, /retrieveAttachmentKnowledge/);
  assert.match(contextRoute, /buildAttachmentContext/);
  assert.match(contextRoute, /VOICE_ATTACHMENT_LIMIT/);
  assert.match(contextRoute, /pendingFiles/);
  assert.match(contextRoute, /unavailableFiles/);
});

test("voice transcript accepts only the durable image/file attachment kinds", () => {
  assert.match(transcriptRoute, /kind:\s*\{\s*in:\s*\[\s*["']IMAGE["']\s*,\s*["']FILE["']\s*\]/);
  assert.match(transcriptRoute, /messageId:\s*null/);
  assert.match(transcriptRoute, /AttachmentConflictError/);
  assert.match(transcriptRoute, /prisma\.\$transaction/);
});

test("mobile Voice keeps Files independent from vision and preserves library image identity", () => {
  assert.match(nativeComposer, /open\(\.files\)/);
  assert.match(nativeComposer, /!voiceCanSeeImages/);
  assert.match(nativeComposer, /!\$0\.isImage/);
  assert.match(nativeComposer, /voiceImageData\(for:/);
  assert.match(nativeAttachmentModel, /public let isImage: Bool/);
  assert.match(nativeAttachmentModel, /public func voiceImageData\(for attachmentID: UUID\)/);
});

test("web Voice keeps Files independent from vision and never puts bytes on the socket", () => {
  // Documents resolve through the authenticated route and ride with the turn
  // as bounded text, so they do not need a provider that can see.
  assert.match(voiceHook, /fetch\("\/api\/voice\/context"/);
  assert.match(voiceHook, /attachmentIds: selected\.map\(/);
  assert.match(voiceHook, /\.\.\.\(context \? \{ context \} : \{\}\)/);
  // The vision gate is scoped to images alone. A file must never be refused
  // for want of a camera.
  assert.match(voiceHook, /if \(images\.length > 0 && !capsRef\.current\?\.videoInput\)/);
  assert.doesNotMatch(voiceHook, /attachments\.some\(\(attachment\) => attachment\.kind !== "IMAGE"\)/);
  // The composer no longer turns documents away before the hook sees them.
  assert.doesNotMatch(chatView, /not document attachments yet/);
  // ...nor before the composer will even hold one: the voice sheet offers the
  // same attach row as chat, and only photos narrow with the provider.
  assert.match(chatComposer, /voiceActive && !voiceCanSeeImages/);
  assert.match(chatComposer, /voiceCanSeeImages \? "Add photos and files" : "Add files"/);
  assert.doesNotMatch(chatComposer, /Voice mode accepts image attachments only/);
  assert.doesNotMatch(chatComposer, /Voice mode accepts images from your library only/);
  // One per-turn cap, shared with the route and the relay rather than retyped.
  assert.match(chatComposer, /VOICE_ATTACHMENT_LIMIT/);
  assert.doesNotMatch(chatComposer, /MAX_VOICE_IMAGES/);
});

test("web Voice reports a file whose text was not available instead of answering around it", () => {
  assert.match(voiceHook, /availability === "pending"/);
  assert.match(voiceHook, /availability === "unavailable"/);
  assert.match(chatView, /result\.pendingFiles\?\.length/);
  assert.match(chatView, /result\.unavailableFiles\?\.length/);
});

test("a Gemini setup the Live API closes on reports the server's reason", () => {
  // The setup wait must settle on the close frame, not only on setupComplete
  // and a timer — otherwise every cause prints the same "timed out".
  assert.match(geminiLive, /ws\.on\("close", onSetupClose\)/);
  assert.match(geminiLive, /ws\.on\("error", onSetupError\)/);
  assert.match(geminiLive, /refused the session setup for model/);
  assert.match(geminiLive, /RELAY_GEMINI_MODEL/);
});

test("voice runs the current live models, with thinking as the model choice it is", () => {
  // Gemini exposes reasoning as a SEPARATE MODEL, not a parameter, so the
  // switch has to pick an id — a thinkingConfig field would silently do nothing.
  assert.match(geminiLive, /"gemini-3\.8-live"/);
  assert.match(geminiLive, /"gemini-3\.8-live-extended-thinking"/);
  assert.doesNotMatch(geminiLive, /gemini-3\.1-flash-live-preview/);
  // GPT-Live-1 is a different protocol on a different URL: a session.start
  // handshake, not the Realtime session.update the qwen dialect still uses.
  assert.match(gptLive, /wss:\/\/api\.openai\.com\/v1\/live\/sessions/);
  assert.match(gptLive, /"session\.start"/);
  assert.match(gptLive, /"session\.input_audio\.append"/);
  assert.match(gptLive, /"session\.output_audio\.delta"/);
  assert.match(relayRegistry, /new OpenAiVoiceSession\(openaiDialect, \{ thinking \}\)/);
  assert.match(openaiVoice, /new GptLiveSession\(\{ thinking: this\.thinking \}\)/);
});

test("a provider with no reasoning variant is never told it has one", () => {
  // The relay reports the EFFECTIVE state, so a client asking for thinking on
  // MiniMax is answered with the truth rather than its own request echoed.
  assert.match(relaySession, /const effectiveThinking = thinking && factory\.capabilities\.thinkingChoice/);
  assert.match(relaySession, /thinking: effectiveThinking/);
  assert.match(relayRegistry, /thinkingChoice: false/);
  // And the row only exists where the choice does.
  assert.match(voiceBar, /voice\.capabilities\?\.thinkingChoice && \(/);
});

test("a voice session that could not honour the request says so without ending the call", () => {
  // GPT-Live is per-account and refuses by dropping the socket, so the openai
  // provider tries it and falls back rather than leaving voice broken.
  assert.match(openaiVoice, /await live\.connect\(seed, events\)/);
  assert.match(openaiVoice, /new OpenAiShapedRealtimeSession\(this\.dialect\)/);
  // A fallback reasons nowhere the caller asked it to; reporting the request
  // back would leave the menu showing a mode nothing runs.
  assert.match(openaiVoice, /thinking: this\.fellBack \? false : this\.thinking/);
  // The note rides on session.ready, NOT on error — an error ends the call.
  assert.match(relaySession, /established\.notice \? \{ notice: established\.notice \}/);
  // A notice shows only when there is no error, and never ends the call.
  assert.match(voiceBar, /if \(voice\.error\) \{[\s\S]*?\}\s*if \(voice\.notice\)/);
  assert.match(voiceBar, /role="status"/);
});

test("a reasoning switch that fails to connect can still be switched back", () => {
  // Every row of the call menu is gated on `capabilities`. Blanking those
  // mid-switch removed the reasoning control at exactly the moment the new
  // session failed, so the only way out of a failed "thinking on" had
  // disappeared and the toggle looked stuck.
  assert.doesNotMatch(voiceHook, /setProvider\(next\);\n\s+setCapabilities\(null\);/);
  // And the optimistic state rolls back, so the menu stops describing a
  // session that never came up.
  assert.match(voiceHook, /confirmedThinkingRef/);
  assert.match(voiceHook, /thinkingRef\.current = confirmedThinkingRef\.current/);
});

test("the call bar separates what you press from what you set", () => {
  // Screen share is a mid-call action, not a setting: it belongs on the bar,
  // where a thumb can reach it, not three rows into a menu that also chooses
  // providers.
  assert.match(voiceBar, /voice\.capabilities\?\.screenInput && live/);
  assert.match(voiceBar, /function VoiceSettings/);
  // Settings are a panel with headings, not a flat verb list — a provider and
  // "Stop sharing screen" are not the same kind of row.
  assert.match(voiceBar, /PopoverContent/);
  assert.match(voiceBar, /<Switch/);
  assert.doesNotMatch(voiceBar, /DropdownMenuItem/);
  // No status cluster competes for the row any more (the glow is the state):
  // the controls never shrink and End sits in the composer's own primary slot,
  // so nothing can push it off a narrow screen.
  assert.match(voiceBar, /flex shrink-0 items-center gap-0\.5/);
  assert.match(voiceBar, /end: <VoiceCallEnd onClose=\{onClose\} \/>/);
});

test("the bar names the model actually answering", () => {
  // Which model is serving was knowable only from a relay log, so a call that
  // had fallen back to another protocol looked exactly like one that had not.
  assert.match(relaySession, /established\.model \? \{ model: established\.model \}/);
  assert.match(voiceHook, /setModel\(msg\.model \?\? null\)/);
  assert.match(voiceBar, /voice\.model/);
});
