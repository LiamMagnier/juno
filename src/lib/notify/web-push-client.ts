/**
 * Browser Web Push, from the page's side: whether this browser can be
 * notified, turning it on and off, and its two switches.
 *
 * Nothing here runs on page load. The service worker (public/sw.js) is
 * registered only by `enableWebPush`, which is called from the click that
 * asks for it, and `webPushStatus` only reads a registration that already
 * exists. A person who never opts in never gets a worker or a prompt. That is
 * the same rule use-needs-you-count.ts keeps for page-level notifications.
 *
 * No React and no zod: a settings row and the inbox both call these, and
 * neither should pay for a schema library to flip a switch. The server
 * validates everything that arrives (src/lib/notify/web-push-shared.ts).
 */

import type { PushPreferences } from "@/lib/notify/types";

export type WebPushState = "unsupported" | "denied" | "off" | "on";

/** The message public/sw.js posts to every open tab when a push arrives or a notification is read. */
export const WORKER_NOTIFICATIONS_CHANGED = "juno:notifications-changed";

const WORKER_URL = "/sw.js";
const SCOPE = "/";
const API = "/api/push/subscriptions";

/** How long a freshly registered worker gets to activate before enabling gives up. */
const ACTIVATE_TIMEOUT_MS = 15_000;

/**
 * Everything push needs, over https. On iOS, PushManager exists only in a
 * web app added to the Home Screen, so Safari in a tab answers "unsupported".
 * That is accurate.
 */
export function webPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The VAPID public key as the bytes `applicationServerKey` takes. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Whether a subscription was made with this public key. A subscription is
 * bound to the key it was made with, so after the server's key changes the old
 * one can never be delivered to. It counts as off, and enabling replaces it.
 */
export function subscribedWithKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!key) return false;
  let expected: Uint8Array;
  try {
    expected = applicationServerKey(publicKey);
  } catch {
    return false;
  }
  const actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SCOPE);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function send(method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<Response> {
  return fetch(API, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * An endpoint the server will accept as a name for a stored row (its
 * `storedEndpointSchema`). An odd one is left out of the body rather than
 * failing the whole request over a row that only needed tidying.
 */
function nameable(endpoint: string): boolean {
  return endpoint.startsWith("https://") && endpoint.length <= 2048;
}

function preferencesFrom(value: unknown): PushPreferences | null {
  if (!value || typeof value !== "object") return null;
  const { notifyNeedsYou, notifyUpdates } = value as Record<string, unknown>;
  return typeof notifyNeedsYou === "boolean" && typeof notifyUpdates === "boolean"
    ? { notifyNeedsYou, notifyUpdates }
    : null;
}

/**
 * Where this browser stands, without prompting or registering anything.
 *
 * "on" needs both halves: the browser holds a subscription, and the server
 * holds it for this account. A browser subscribed while someone else was
 * signed in is "off" here, and enabling takes it over. When the server cannot
 * be asked, the answer is "on" with unknown switches. The browser half is the
 * one that decides whether a push can arrive.
 *
 * Pass the current public key to count a subscription made with an old one
 * as off.
 */
export async function webPushStatus(publicKey?: string | null): Promise<{ state: WebPushState; prefs: PushPreferences | null }> {
  if (!webPushSupported()) return { state: "unsupported", prefs: null };
  if (Notification.permission === "denied") return { state: "denied", prefs: null };

  let subscription: PushSubscription | null;
  try {
    subscription = await existingSubscription();
  } catch {
    // Service workers switched off (Firefox private windows throw here).
    return { state: "unsupported", prefs: null };
  }
  if (!subscription || Notification.permission !== "granted") return { state: "off", prefs: null };
  if (publicKey && !subscribedWithKey(subscription.options.applicationServerKey, publicKey)) {
    return { state: "off", prefs: null };
  }

  try {
    const res = await fetch(`${API}?endpoint=${encodeURIComponent(subscription.endpoint)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return { state: "on", prefs: null };
    const data = (await res.json()) as { subscription?: unknown };
    const prefs = preferencesFrom(data.subscription);
    return prefs ? { state: "on", prefs } : { state: "off", prefs: null };
  } catch {
    return { state: "on", prefs: null };
  }
}

function requestPermission(): Promise<NotificationPermission> {
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return Notification.requestPermission().catch(() => "default" as NotificationPermission);
}

/** The registration once its worker is active. pushManager.subscribe refuses one that is still installing. */
async function activated(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return navigator.serviceWorker.ready;
  if (worker.state === "activated") return registration;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("service worker did not activate")), ACTIVATE_TIMEOUT_MS);
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") {
        clearTimeout(timer);
        resolve();
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        reject(new Error("service worker was replaced before it activated"));
      }
    });
  });
  return registration;
}

/**
 * Turns browser notifications on. Call it directly from the click that asks
 * for them.
 *
 * The permission request starts before the first `await`. Safari and Firefox
 * grant a prompt only while the click that asked for it is still being
 * handled, and an await in front of the request would use that up. The
 * worker registers alongside it, because registering needs no gesture.
 */
export async function enableWebPush(
  publicKey: string,
  prefs?: Partial<PushPreferences>
): Promise<{ ok: true } | { ok: false; reason: "unsupported" | "denied" | "failed" }> {
  if (!webPushSupported()) return { ok: false, reason: "unsupported" };

  const permission = requestPermission();
  const registering = navigator.serviceWorker.register(WORKER_URL, { scope: SCOPE, updateViaCache: "none" });
  // Handled below. Marked handled now so an early return on "denied" does not
  // turn a failed registration into an unhandled rejection.
  registering.catch(() => undefined);

  try {
    if ((await permission) !== "granted") return { ok: false, reason: "denied" };
    const registration = await activated(await registering);

    // Always a fresh subscription. Enabling runs only when status said "off",
    // and a subscription the browser still holds then is one the server cannot
    // use. Its push service may have forgotten it (a 410 switched its row off,
    // but browsers keep the object), it may be bound to an old public key, or
    // another account may hold it. Posting it again would be answered with
    // "on" and then fail on the next push. Naming it as `oldEndpoint` carries
    // this account's switches over and removes its row.
    const stale = await registration.pushManager.getSubscription();
    const oldEndpoint = stale?.endpoint ?? null;
    if (stale) await stale.unsubscribe().catch(() => false);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });

    const res = await send("POST", {
      subscription: subscription.toJSON(),
      ...(oldEndpoint && oldEndpoint !== subscription.endpoint && nameable(oldEndpoint) ? { oldEndpoint } : {}),
      ...(prefs?.notifyNeedsYou === undefined ? {} : { notifyNeedsYou: prefs.notifyNeedsYou }),
      ...(prefs?.notifyUpdates === undefined ? {} : { notifyUpdates: prefs.notifyUpdates }),
    });
    return res.ok ? { ok: true } : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/**
 * Turns browser notifications off for this browser. The server forgets it
 * first, because once the browser unsubscribes nothing can name the
 * subscription to the server any more. The worker stays registered. It does
 * nothing without a subscription, and turning notifications back on then
 * needs no second install.
 */
export async function disableWebPush(): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const subscription = await existingSubscription();
    if (!subscription) return;
    await send("DELETE", { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  } catch {
    // Already gone, or service workers are off. Either way nothing is left to push to.
  }
}

/** Flips this browser's switches. False when it is not subscribed or the server said no. */
export async function updateWebPushPrefs(prefs: Partial<PushPreferences>): Promise<boolean> {
  if (!webPushSupported()) return false;
  try {
    const subscription = await existingSubscription();
    if (!subscription) return false;
    const res = await send("PATCH", { endpoint: subscription.endpoint, ...prefs });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Calls `listener` whenever the service worker says the notifications changed:
 * a push arrived, or one was opened and marked read. Returns the unsubscribe.
 * The inbox uses it to refresh without waiting for its next poll.
 */
export function onWorkerNotificationsChanged(listener: () => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => undefined;
  const container = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data && typeof data === "object" && (data as { type?: unknown }).type === WORKER_NOTIFICATIONS_CHANGED) listener();
  };
  container.addEventListener("message", onMessage);
  // A worker's messages queue until the page says it is listening.
  // addEventListener alone does not say so, but startMessages does.
  container.startMessages();
  return () => container.removeEventListener("message", onMessage);
}
