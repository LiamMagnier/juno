/*
 * The app's service worker. Push only.
 *
 * It has one job: show a notification when the server pushes one
 * (src/lib/notify/web-push.ts), and open the right page when it is clicked.
 * There is deliberately no `fetch` handler and no cache. A worker that served
 * pages could serve a stale build after a deploy, and nothing here needs the
 * network to pass through it.
 *
 * Self-contained, with no importScripts: this file is registered for the whole
 * origin and updates on its own schedule, not with the app bundle. It is also
 * outside lint and typecheck (public/** is ignored), so it is kept small and
 * written defensively.
 *
 * The page registers it only when someone turns browser notifications on
 * (src/lib/notify/web-push-client.ts). Nobody gets a worker just by visiting.
 */

/** Posted to every open tab so its inbox refreshes. The page listens for this exact type. */
const CHANGED = "juno:notifications-changed";

const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/*
 * Safari revokes a push subscription when a push does not end in a visible
 * notification. Chrome and Firefox allow a quiet push while the site is in
 * front, which is when the open tab's inbox already shows it. So only
 * non-WebKit engines skip the banner for a focused tab.
 */
const UA = (self.navigator && self.navigator.userAgent) || "";
const QUIET_WHEN_FOCUSED = !(/AppleWebKit\//.test(UA) && !/Chrom(e|ium)\//.test(UA));

// A new version of this file takes over at once rather than waiting for every
// tab to close, so a fix to the push handler reaches people on their next visit.
self.addEventListener("install", () => {
  self.skipWaiting();
});

// Claiming open tabs is what lets a click navigate them (WindowClient.navigate
// works only on a page this worker controls). With no fetch handler, control
// changes nothing else about how those pages load.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * A path inside this app, or "/". The server already validated it. It is
 * checked again because it is the one input to openWindow and navigate, so a
 * bad one would be an open redirect.
 */
function safePath(value) {
  if (typeof value !== "string") return "/";
  const path = value.trim();
  if (!path || path.length > 512) return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "/";
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch (_) {
    return "/";
  }
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function readMessage(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_) {
    data = null;
  }
  if (!data || typeof data !== "object") data = {};
  return {
    // PRODUCT_NAME (src/lib/brand/names.ts); a service worker cannot import it.
    title: text(data.title, 200) || "Alevr",
    body: text(data.body, 1000),
    tag: text(data.tag, 128) || "juno",
    path: safePath(data.path),
    notificationId:
      typeof data.notificationId === "string" && NOTIFICATION_ID.test(data.notificationId) ? data.notificationId : null,
  };
}

async function windows() {
  try {
    return await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch (_) {
    return [];
  }
}

function announce(open) {
  for (const client of open) {
    try {
      client.postMessage({ type: CHANGED });
    } catch (_) {
      // A tab closing mid-loop; the others still hear it.
    }
  }
}

self.addEventListener("push", (event) => {
  const message = readMessage(event);
  event.waitUntil(
    (async () => {
      const open = await windows();
      // Every open tab refreshes, including a hidden one, so the dot is right
      // the moment someone switches back to it.
      announce(open);
      const inFront = open.some((client) => client.focused && client.visibilityState === "visible");
      if (inFront && QUIET_WHEN_FOCUSED) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        icon: "/icon.png",
        timestamp: Date.now(),
        data: { path: message.path, notificationId: message.notificationId },
      });
    })()
  );
});

async function markRead(notificationId) {
  if (!notificationId) return;
  try {
    // Same-origin, so the session cookie rides along and the Origin header
    // passes the CSRF check in src/middleware.ts.
    await fetch(`/api/notifications/${encodeURIComponent(notificationId)}`, {
      method: "PATCH",
      credentials: "same-origin",
    });
  } catch (_) {
    // Best effort. The row stays unread and the inbox still shows it.
  }
  announce(await windows());
}

async function openPath(path) {
  const target = new URL(path, self.location.origin).href;
  const tabs = (await windows()).filter((client) => client.frameType !== "nested");
  const tab =
    tabs.find((client) => client.focused) ||
    tabs.find((client) => client.visibilityState === "visible") ||
    tabs[0];
  if (tab) {
    try {
      const focused = (await tab.focus()) || tab;
      // Nowhere in particular to go (an informational notification), or
      // already there: bringing the tab forward is the whole answer.
      if (path === "/" || focused.url === target) return;
      if (typeof focused.navigate === "function") {
        const navigated = await focused.navigate(target);
        if (navigated) return;
      }
    } catch (_) {
      // Not controlled by this worker, or it closed; fall through to a new window.
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const notificationId =
    typeof data.notificationId === "string" && NOTIFICATION_ID.test(data.notificationId) ? data.notificationId : null;
  event.waitUntil(Promise.all([openPath(safePath(data.path)), markRead(notificationId)]));
});

/*
 * The browser replaced the subscription, because it expired or the push
 * service rotated it. Subscribe again with the same key and tell the server,
 * naming the old endpoint so its switches carry over and its row goes. If
 * this fails, the person turns notifications on again from settings. That is
 * the same place they turned them on the first time.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription || null;
      let next = event.newSubscription || null;
      if (!next) {
        const key = previous && previous.options && previous.options.applicationServerKey;
        if (!key) return;
        next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: next.toJSON(),
          ...(previous && previous.endpoint ? { oldEndpoint: previous.endpoint } : {}),
        }),
      });
    })().catch(() => {
      // Nothing to fall back to from here. See the note above.
    })
  );
});
