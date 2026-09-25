import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import {
  deleteBodySchema,
  MAX_SUBSCRIPTIONS_PER_USER,
  storedEndpointSchema,
  subscribeBodySchema,
  subscriptionClaim,
  subscriptionPreferences,
  updateBodySchema,
} from "@/lib/notify/web-push-shared";

export const runtime = "nodejs";

/*
 * This browser's Web Push subscription, and its two switches.
 *
 * The subscription IS the preference: there is no account-level "browser
 * notifications" setting, because the only honest answer to "does this
 * browser get pushes" is whether this browser is subscribed. Every call
 * therefore names the browser by its endpoint, and every read and write is
 * scoped to the signed-in account — except the takeover in POST, below.
 */

const SWITCHES = { notifyNeedsYou: true, notifyUpdates: true } as const;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function invalid(message: string) {
  return NextResponse.json({ error: "invalid_input", message }, { status: 400 });
}

/** GET ?endpoint= — this browser's switches, or null when it is not subscribed to this account. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = storedEndpointSchema.safeParse(new URL(req.url).searchParams.get("endpoint") ?? "");
  if (!parsed.success) return invalid("That subscription could not be read.");

  const subscription = await prisma.webPushSubscription.findFirst({
    where: { userId: user.id, endpoint: parsed.data, active: true },
    select: SWITCHES,
  });
  return NextResponse.json({ subscription });
}

/** POST — subscribe this browser (or refresh its keys), taking the row over if another account had it. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  // A browser subscribes once and re-subscribes rarely; a stream of them is a
  // script filling the table.
  const limit = await rateLimit({ key: `push:subscribe:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many attempts to turn on notifications. Try again in a little while." },
      { status: 429 }
    );
  }

  const parsed = subscribeBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid("That subscription could not be read.");
  const { subscription, oldEndpoint } = parsed.data;
  const { endpoint } = subscription;

  // Unguarded on purpose, with the upsert below: an endpoint belongs to the
  // browser, not to an account, so when someone else signs in on it their
  // subscribe must find the row to take it over. Nothing from another
  // account's row is returned or kept. Its keys are read only to check that
  // this request comes from the same browser (subscriptionClaim).
  const existing = await prismaUnguarded.webPushSubscription.findUnique({
    where: { endpoint },
    select: { userId: true, p256dh: true, auth: true, ...SWITCHES },
  });
  const claim = subscriptionClaim(existing, user.id, subscription.keys);
  if (claim === "refused") {
    return NextResponse.json(
      { error: "conflict", message: "This browser's notifications could not be turned on. Try again." },
      { status: 409 }
    );
  }
  const previous =
    claim === "own"
      ? existing
      : oldEndpoint
        ? await prisma.webPushSubscription.findFirst({ where: { userId: user.id, endpoint: oldEndpoint }, select: SWITCHES })
        : null;
  const switches = subscriptionPreferences(
    { notifyNeedsYou: parsed.data.notifyNeedsYou, notifyUpdates: parsed.data.notifyUpdates },
    previous
  );
  const userAgent = req.headers.get("user-agent")?.slice(0, 256) ?? null;

  // Unguarded because on a takeover it rewrites another account's row. The
  // claim above is what permits that.
  const row = await prismaUnguarded.webPushSubscription.upsert({
    where: { endpoint },
    update: {
      userId: user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      active: true,
      ...switches,
    },
    create: {
      userId: user.id,
      endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      ...switches,
    },
    select: SWITCHES,
  });

  if (oldEndpoint && oldEndpoint !== endpoint) {
    await prisma.webPushSubscription.deleteMany({ where: { userId: user.id, endpoint: oldEndpoint } });
  }

  // Browsers that were never unsubscribed (a wiped profile, a reinstalled OS)
  // leave rows behind, and so do subscriptions a push service has forgotten
  // (switched off by the sender). Keep the newest few, live ones first, so one
  // account can grow neither the fan-out nor the table without bound.
  const stale = await prisma.webPushSubscription.findMany({
    where: { userId: user.id },
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
    skip: MAX_SUBSCRIPTIONS_PER_USER,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.webPushSubscription.deleteMany({ where: { userId: user.id, id: { in: stale.map((s) => s.id) } } });
  }

  return NextResponse.json({ subscribed: true, subscription: row });
}

/** PATCH — flip this browser's switches. */
export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = updateBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid("That change could not be read.");
  const { endpoint, notifyNeedsYou, notifyUpdates } = parsed.data;

  const data = {
    ...(notifyNeedsYou === undefined ? {} : { notifyNeedsYou }),
    ...(notifyUpdates === undefined ? {} : { notifyUpdates }),
  };
  if (Object.keys(data).length) {
    await prisma.webPushSubscription.updateMany({ where: { userId: user.id, endpoint, active: true }, data });
  }
  const subscription = await prisma.webPushSubscription.findFirst({
    where: { userId: user.id, endpoint, active: true },
    select: SWITCHES,
  });
  if (!subscription) {
    return NextResponse.json({ error: "not_found", message: "This browser is not subscribed." }, { status: 404 });
  }
  return NextResponse.json({ subscribed: true, subscription });
}

/** DELETE — forget this browser. Idempotent: already gone is still gone. */
export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = deleteBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid("That subscription could not be read.");

  // Deleted rather than switched off: the keys are worth nothing without the
  // subscription, and a row nobody can reach again is only something to leak.
  await prisma.webPushSubscription.deleteMany({ where: { userId: user.id, endpoint: parsed.data.endpoint } });
  return NextResponse.json({ unsubscribed: true });
}
