import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FALLBACK_VAPID_SUBJECT,
  MAX_PAYLOAD_BYTES,
  isPushServiceEndpoint,
  parseStoredVapidKeys,
  pushSubscriptionSchema,
  subscribeBodySchema,
  subscriptionClaim,
  subscriptionPreferences,
  updateBodySchema,
  vapidKeysFromEnv,
  vapidSubject,
  webPushDelivery,
  webPushMessage,
} from "@/lib/notify/web-push-shared";
import { applicationServerKey, subscribedWithKey } from "@/lib/notify/web-push-client";

const ROOT = process.cwd();
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// The shape `web-push generate-vapid-keys` prints: a 65-byte uncompressed
// point (so it starts with "B") and a 32-byte scalar.
const PUBLIC_KEY = `B${"A".repeat(86)}`;
const PRIVATE_KEY = "a".repeat(43);
const P256DH = `B${"x".repeat(86)}`;
const AUTH = "y".repeat(22);

const subscription = (endpoint: string, keys = { p256dh: P256DH, auth: AUTH }) => ({ endpoint, expirationTime: null, keys });

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

test("endpoints on the four browser push services are accepted", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc:APA91b",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
  ]) {
    assert.equal(isPushServiceEndpoint(endpoint), true, endpoint);
    assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint)).success, true, endpoint);
  }
});

test("an endpoint the server would be tricked into calling is refused", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc", // not https
    "https://169.254.169.254/latest/meta-data", // an address only the VM can reach
    "https://localhost:3000/api/admin",
    "https://fcm.googleapis.com.evil.test/fcm/send/abc", // suffix, not host
    "https://evilfcm.googleapis.com.test/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc", // credentials
    "https://fcm.googleapis.com:8443/fcm/send/abc", // a port
    `https://fcm.googleapis.com/${"a".repeat(2100)}`,
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint)).success, false, endpoint || "(empty)");
  }
});

test("subscription keys must be a P-256 point and a 16-byte secret", () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint, { p256dh: "B" + "x".repeat(40), auth: AUTH })).success, false);
  assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint, { p256dh: "A" + "x".repeat(86), auth: AUTH })).success, false);
  assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint, { p256dh: P256DH, auth: "short" })).success, false);
  assert.equal(pushSubscriptionSchema.safeParse(subscription(endpoint, { p256dh: P256DH, auth: "y".repeat(21) + "!" })).success, false);
  assert.equal(pushSubscriptionSchema.safeParse({ endpoint }).success, false, "keys are required");
});

test("padded or standard-alphabet keys are normalised to unpadded base64url", () => {
  const parsed = pushSubscriptionSchema.parse(
    subscription("https://fcm.googleapis.com/fcm/send/abc", { p256dh: `B${"+".repeat(85)}/=`, auth: `${"/".repeat(22)}==` })
  );
  assert.equal(parsed.keys.p256dh, `B${"-".repeat(85)}_`);
  assert.equal(parsed.keys.auth, "_".repeat(22));
});

test("a subscribe body carries only the known fields", () => {
  const parsed = subscribeBodySchema.parse({
    subscription: subscription("https://web.push.apple.com/abc"),
    notifyUpdates: false,
    userId: "someone-else",
  });
  assert.equal(parsed.notifyUpdates, false);
  assert.equal("userId" in parsed, false);
  assert.equal(subscribeBodySchema.safeParse({ subscription: subscription("https://web.push.apple.com/abc"), notifyUpdates: "no" }).success, false);
});

test("a stored endpoint can still be switched off after its service leaves the allowlist", () => {
  assert.equal(updateBodySchema.safeParse({ endpoint: "https://push.example.org/sub/1", notifyUpdates: false }).success, true);
  assert.equal(updateBodySchema.safeParse({ endpoint: "http://push.example.org/sub/1" }).success, false);
});

test("a re-subscribe keeps the account's own switches; a takeover starts from the defaults", () => {
  assert.deepEqual(subscriptionPreferences({}, null), { notifyNeedsYou: true, notifyUpdates: true });
  assert.deepEqual(
    subscriptionPreferences({}, { notifyNeedsYou: true, notifyUpdates: false }),
    { notifyNeedsYou: true, notifyUpdates: false },
    "turning notifications back on must not quietly switch updates on again"
  );
  assert.deepEqual(
    subscriptionPreferences({ notifyUpdates: true }, { notifyNeedsYou: false, notifyUpdates: false }),
    { notifyNeedsYou: false, notifyUpdates: true }
  );
});

test("another account's browser is taken over only by a request holding its keys", () => {
  const keys = { p256dh: P256DH, auth: AUTH };
  const row = { userId: "u-a", ...keys };
  assert.equal(subscriptionClaim(null, "u-b", keys), "new");
  assert.equal(subscriptionClaim(row, "u-a", { p256dh: P256DH, auth: "z".repeat(22) }), "own", "a re-subscribe may refresh its own keys");
  assert.equal(subscriptionClaim(row, "u-b", keys), "takeover", "someone else signing in on the same browser");
  assert.equal(
    subscriptionClaim(row, "u-b", { p256dh: P256DH, auth: "z".repeat(22) }),
    "refused",
    "an endpoint read from a log is not the browser"
  );
  assert.equal(subscriptionClaim(row, "u-b", { p256dh: `B${"q".repeat(86)}`, auth: AUTH }), "refused");
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

test("a push carries exactly title, body, path, tag and notificationId", () => {
  const message = JSON.parse(
    webPushMessage({ title: " Quill has 3 ideas ", body: "Open to read them.", path: "/agents/a1", tag: "agent-a1", notificationId: "cn1" })
  );
  assert.deepEqual(message, {
    title: "Quill has 3 ideas",
    body: "Open to read them.",
    path: "/agents/a1",
    tag: "agent-a1",
    notificationId: "cn1",
  });
});

test("a path that could leave the app is dropped to null", () => {
  for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/admin", "/chat/../admin"]) {
    const message = JSON.parse(webPushMessage({ title: "t", body: "b", path: bad, tag: "t", notificationId: null }));
    assert.equal(message.path, null, bad);
  }
  const ok = JSON.parse(webPushMessage({ title: "t", body: "b", path: "/work/s1?tab=log", tag: "t", notificationId: null }));
  assert.equal(ok.path, "/work/s1?tab=log");
});

test("an empty title and tag fall back, and a malformed notification id is dropped", () => {
  const message = JSON.parse(webPushMessage({ title: "  ", body: "", path: null, tag: "", notificationId: "../../x" }));
  assert.equal(message.title, "Juno");
  assert.equal(message.tag, "juno");
  assert.equal(message.notificationId, null);
});

test("a long body is clipped so the encrypted push stays under the services' 4 KB limit", () => {
  const encoded = webPushMessage({
    title: "t".repeat(500),
    body: "\u0001é".repeat(5000),
    path: "/chat/c1",
    tag: "x".repeat(200),
    notificationId: "n1",
  });
  assert.ok(new TextEncoder().encode(encoded).length <= MAX_PAYLOAD_BYTES);
  const message = JSON.parse(encoded);
  assert.ok(message.title.length <= 120);
  assert.ok(message.tag.length <= 64);
  assert.equal(message.path, "/chat/c1", "clipping never costs the path");
});

test("needs-you pushes are urgent and short-lived; updates wait longer at normal urgency", () => {
  const needsYou = webPushDelivery("needs_you");
  const updates = webPushDelivery("updates");
  assert.equal(needsYou.urgency, "high");
  assert.equal(updates.urgency, "normal");
  assert.ok(needsYou.ttlSeconds < updates.ttlSeconds);
  assert.ok(updates.ttlSeconds <= 24 * 60 * 60);
});

test("a push that expires sooner is held by the push services only until it expires", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const inTenMinutes = new Date(now.getTime() + 10 * 60 * 1000);
  assert.equal(webPushDelivery("needs_you", inTenMinutes, now).ttlSeconds, 600);
  assert.equal(webPushDelivery("needs_you", inTenMinutes, now).urgency, "high");
  assert.equal(webPushDelivery("updates", new Date(now.getTime() - 1000), now).ttlSeconds, 0, "already expired");
  assert.equal(webPushDelivery("needs_you", new Date(now.getTime() + 86_400_000), now).ttlSeconds, 60 * 60, "never longer than the channel's own");
  assert.equal(webPushDelivery("updates", null, now).ttlSeconds, 12 * 60 * 60);
  assert.equal(webPushDelivery("updates", new Date(Number.NaN), now).ttlSeconds, 12 * 60 * 60, "a bad date is ignored, never a NaN TTL");
});

// ---------------------------------------------------------------------------
// VAPID keys and subject
// ---------------------------------------------------------------------------

test("env keys are used only as a complete, well-formed pair", () => {
  assert.equal(vapidKeysFromEnv(undefined, undefined), "unset");
  assert.equal(vapidKeysFromEnv("", "  "), "unset", ".env.example ships them empty");
  assert.deepEqual(vapidKeysFromEnv(PUBLIC_KEY, PRIVATE_KEY), { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY });
  assert.deepEqual(vapidKeysFromEnv(`${PUBLIC_KEY}=`, `${PRIVATE_KEY}=`), { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY });
  assert.equal(vapidKeysFromEnv(PUBLIC_KEY, undefined), "invalid", "half a pair must not mint a new one");
  assert.equal(vapidKeysFromEnv("not-a-key", PRIVATE_KEY), "invalid");
});

test("a stored pair is read back only when it is one", () => {
  assert.deepEqual(parseStoredVapidKeys(JSON.stringify({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, extra: 1 })), {
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
  });
  assert.equal(parseStoredVapidKeys("[encrypted field could not be decrypted]"), null);
  assert.equal(parseStoredVapidKeys(JSON.stringify({ publicKey: PUBLIC_KEY })), null);
});

test("the VAPID subject is the configured contact, else the https app URL, else a placeholder", () => {
  assert.equal(vapidSubject({ subject: "mailto:ops@juno.example", appUrl: "https://juno.example" }), "mailto:ops@juno.example");
  assert.equal(vapidSubject({ subject: "https://juno.example/contact" }), "https://juno.example/contact");
  assert.equal(vapidSubject({ subject: "", appUrl: "https://juno.example/app" }), "https://juno.example");
  assert.equal(vapidSubject({ subject: "ops@juno.example", appUrl: "https://juno.example" }), "https://juno.example", "a bare address is not a subject");
  // Apple's push service rejects a localhost subject outright.
  assert.equal(vapidSubject({ appUrl: "https://localhost:3000" }), FALLBACK_VAPID_SUBJECT);
  assert.equal(vapidSubject({ subject: "https://localhost", appUrl: "http://127.0.0.1:3000" }), FALLBACK_VAPID_SUBJECT);
  assert.equal(vapidSubject({ appUrl: "http://juno.example" }), FALLBACK_VAPID_SUBJECT);
  assert.equal(vapidSubject({}), FALLBACK_VAPID_SUBJECT);
});

// ---------------------------------------------------------------------------
// The page's key handling
// ---------------------------------------------------------------------------

test("the public key becomes the 65 bytes applicationServerKey takes", () => {
  const bytes = applicationServerKey(PUBLIC_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test("a subscription made with a different key counts as not subscribed", () => {
  const key = applicationServerKey(PUBLIC_KEY).buffer;
  assert.equal(subscribedWithKey(key, PUBLIC_KEY), true);
  assert.equal(subscribedWithKey(key, `B${"B".repeat(86)}`), false);
  assert.equal(subscribedWithKey(null, PUBLIC_KEY), false);
});

// ---------------------------------------------------------------------------
// Wiring, pinned as text (the modules behind it are server-only or not JS we lint)
// ---------------------------------------------------------------------------

test("the service worker is push-only and self-contained", () => {
  const sw = source("public/sw.js");
  assert.doesNotMatch(sw, /addEventListener\(\s*["']fetch["']/, "a fetch handler could serve a stale build");
  assert.doesNotMatch(sw, /importScripts\(/);
  assert.doesNotMatch(sw, /caches\./);
  for (const event of ["push", "notificationclick", "pushsubscriptionchange"]) {
    assert.match(sw, new RegExp(`addEventListener\\("${event}"`), event);
  }
  assert.match(sw, /juno:notifications-changed/);
  // The click re-validates the path before it reaches openWindow.
  assert.match(sw, /path\.startsWith\("\/\/"\)/);
  assert.match(sw, /openWindow\(target\)/);
});

test("sw.js is served outside the document CSP, uncached, and scoped to the origin", () => {
  assert.match(source("src/middleware.ts"), /\|sw\.js\)\.\*\)/);
  const next = source("next.config.mjs");
  assert.match(next, /source: "\/sw\.js"[\s\S]*?"Cache-Control", value: "no-cache"/);
  assert.match(next, /"Service-Worker-Allowed", value: "\/"/);
});

test("the page never registers the worker except from enableWebPush", () => {
  const client = source("src/lib/notify/web-push-client.ts");
  assert.equal(client.match(/serviceWorker\.register\(/g)?.length, 1);
  assert.match(client, /export async function enableWebPush[\s\S]*?serviceWorker\.register\(/);
  // The permission request is started before anything is awaited.
  const enable = client.slice(client.indexOf("export async function enableWebPush"));
  assert.ok(enable.indexOf("requestPermission()") < enable.indexOf("await "));
});

test("enabling always subscribes afresh and names the subscription it replaces", () => {
  const client = source("src/lib/notify/web-push-client.ts");
  const enable = client.slice(client.indexOf("export async function enableWebPush"), client.indexOf("export async function disableWebPush"));
  // A subscription the push service has forgotten stays in the browser; posting
  // it again would read as "on" and fail on the next push.
  assert.match(enable, /stale\.unsubscribe\(\)/);
  assert.match(enable, /pushManager\.subscribe\(/);
  assert.match(enable, /oldEndpoint/);
});

test("the subscriptions route is session-scoped, validated and rate limited", () => {
  const route = source("src/app/api/push/subscriptions/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /rateLimit\(\{ key: `push:subscribe:\$\{user\.id\}`/);
  for (const schema of ["subscribeBodySchema", "updateBodySchema", "deleteBodySchema", "storedEndpointSchema"]) {
    assert.match(route, new RegExp(`${schema}\\.safeParse`), schema);
  }
  // Every write but the upsert-by-endpoint names the account.
  assert.doesNotMatch(route, /(updateMany|deleteMany|findFirst)\(\{ where: \{ (?!userId)/);
  // The only cross-account queries are the takeover's lookup and its upsert,
  // and the upsert is reached only past the key check.
  assert.deepEqual(route.match(/prismaUnguarded\.webPushSubscription\.\w+/g), [
    "prismaUnguarded.webPushSubscription.findUnique",
    "prismaUnguarded.webPushSubscription.upsert",
  ]);
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.ok(post.indexOf('claim === "refused"') > 0);
  assert.ok(post.indexOf('claim === "refused"') < post.indexOf(".upsert("));
});

test("the sender switches off gone subscriptions and never throws into the bootstrap", () => {
  const sender = source("src/lib/notify/web-push.ts");
  assert.match(sender, /^import "server-only";/);
  assert.match(sender, /status === 404 \|\| status === 410/);
  assert.match(sender, /data: \{ active: false \}/);
  assert.match(sender, /isPushServiceEndpoint\(subscription\.endpoint\)/);
  assert.match(sender, /webPushDelivery\(channel, payload\.expiresAt\)/);
  const bootstrap = source("src/lib/app-data.ts");
  assert.match(bootstrap, /webPush: Boolean\(pushPublicKey\)/);
  assert.match(bootstrap, /webPushPublicKey: pushPublicKey/);
});
