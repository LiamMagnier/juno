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
