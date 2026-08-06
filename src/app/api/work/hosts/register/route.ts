import { NextResponse } from "next/server";
import type { Prisma, WorkHost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { hostStateFor } from "@/lib/work/domain";
import { recordWorkAudit } from "@/lib/work/audit";
import { serializeHost } from "@/lib/work/serializers";
import {
  HOST_NOT_FOUND,
  WORK_RELAY_REFUSALS,
  advertisedCapabilityKeys,
  hostRegistrationSchema,
  isPermissionPolicy,
  parseAdvertisement,
  reconcilePolicy,
  reconcileToggles,
  refusalBody,
  type HostToggles,
} from "@/lib/work/relay";

export const runtime = "nodejs";

/**
 * Per-user ceiling on host advertisements.
 *
 * `WorkRemoteHost.run` advertises once per pass of its loop, and a pass is one
 * long poll — roughly twice a minute per Mac. This leaves room for several Macs
 * reconnecting at once after an outage without letting a client that has lost
 * its loop rewrite the same row hundreds of times a second.
 */
const HOST_REGISTER_RATE_LIMIT = 120;

/** The advertised switches, in the order `HostToggles` declares them. */
function togglesOf(host: Pick<WorkHost, keyof HostToggles>): HostToggles {
  return {
    enabled: host.enabled,
    allowsFileWork: host.allowsFileWork,
    allowsBrowser: host.allowsBrowser,
    allowsComputerUse: host.allowsComputerUse,
    allowsShell: host.allowsShell,
    allowsBackground: host.allowsBackground,
  };
}

/**
 * Registers or re-advertises a Mac for Juno Work.
 *
 * Both, through one endpoint, because they are the same statement: this is what
 * this machine can do right now. The host sends it on every heartbeat rather
 * than only when something changes, because the answer changes when the user
 * revokes a folder or flips a switch, and a relay routing on a manifest from
 * ten minutes ago dispatches work the host will refuse.
 *
 * Nothing here derives a capability. The boolean columns and the capability
 * keys are both written from what the host said, and a Mac that claims nothing
 * gets nothing — `selectTarget` then routes its work to the cloud or refuses
 * it, which is the honest outcome. Inferring `local_files` from a toggle would
 * queue file work at a machine whose build has no file tool, and that presents
 * to the user as a task that is about to start and never does.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const limited = await rateLimit({
    key: `work-host-register:${user.id}`,
    limit: HOST_REGISTER_RATE_LIMIT,
    windowSec: 60,
  });
  if (!limited.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const parsed = hostRegistrationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  // Identity and pairing are CodeDevice's, reused rather than reimplemented —
  // a second pairing protocol is the thing the work order forbids. A device id
  // belonging to another account is indistinguishable here from one that does
  // not exist, because a 403 would confirm that the id names a real Mac on a
  // real account, which is the one fact a stolen session does not already have.
  const device = await prisma.codeDevice.findFirst({
    where: { id: body.deviceId, userId: user.id },
    select: { id: true },
  });
  if (!device) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  const existing = await prisma.workHost.findFirst({
    where: { deviceId: device.id, userId: user.id },
  });

  // A revoked host may not re-register itself. Letting the advertisement clear
  // `revokedAt` would make revocation last exactly one heartbeat — the Mac the
  // user just cut off would put itself back on the list within the minute.
  // Restoring it is the owner's action, on `PATCH /api/work/hosts/{id}`.
  if (existing?.revokedAt) {
    await recordWorkAudit({
      userId: user.id,
      kind: WORK_RELAY_REFUSALS.revoked.audit,
      severity: WORK_RELAY_REFUSALS.revoked.severity,
      actor: "macos",
      hostId: existing.id,
      detail: { hostId: existing.id, deviceId: device.id, reason: "register", revoked: true },
    });
    return NextResponse.json(refusalBody(WORK_RELAY_REFUSALS.revoked), {
      status: WORK_RELAY_REFUSALS.revoked.status,
    });
  }

  const advertised: HostToggles = {
    enabled: body.enabled,
    allowsFileWork: body.allowsFileWork,
    allowsBrowser: body.allowsBrowser,
    allowsComputerUse: body.allowsComputerUse,
    allowsShell: body.allowsShell,
    allowsBackground: body.allowsBackground,
  };

  // The manifest is what the host claimed, stored as it arrived — including
  // capability names this build does not recognise, which are kept so that a
  // newer Mac's advertisement is not silently rewritten by an older backend.
  // The routable subset is derived on the way out, never on the way in.
  const now = new Date();
  const manifest = {
    toggles: advertised,
    capabilities: body.capabilities,
    approvalPolicy: body.approvalPolicy,
    allowedApps: body.allowedApps,
    blockedApps: body.blockedApps,
    allowedDomains: body.allowedDomains,
    platform: body.platform,
    appVersion: body.appVersion,
    protocolVersion: body.protocolVersion,
    advertisedAt: now.toISOString(),
  } satisfies Prisma.InputJsonObject;

  // What was claimed last time, so the owner's own narrowing survives this
  // heartbeat. A row whose manifest predates this shape has nothing to compare
  // against and the host's claim stands as written: the alternative — reading
  // every switch that is off as owner-narrowed — would leave a Mac permanently
  // unable to offer anything it had ever had switched off.
  const previous = existing ? parseAdvertisement(existing.capabilities) : null;
  const toggles = reconcileToggles(
    previous && existing ? { advertised: previous.toggles, effective: togglesOf(existing) } : null,
    advertised
  );
  const approvalPolicy = reconcilePolicy(
    previous && existing
      ? {
          advertised: previous.approvalPolicy,
          // A column holding something outside the vocabulary reads as the
          // strictest policy, matching every other reader of this value.
          effective: isPermissionPolicy(existing.approvalPolicy)
            ? existing.approvalPolicy
            : "conservative",
        }
      : null,
    body.approvalPolicy
  );

  const advertisement = {
    displayName: body.displayName,
    platform: body.platform,
    appVersion: body.appVersion,
    protocolVersion: body.protocolVersion,
    ...toggles,
    approvalPolicy,
    capabilities: manifest,
    capabilitiesVersion: body.capabilitiesVersion,
    allowedApps: body.allowedApps,
    blockedApps: body.blockedApps,
    allowedDomains: body.allowedDomains,
    // Presence, from the host's own heartbeat. `hostStateFor` reads the age of
    // `lastSeenAt`, which is zero here, so this records the distinction only
    // the host can draw — busy versus idle — and lets the clock narrow it later.
    state: hostStateFor(now, now, body.activeRunCount),
    lastSeenAt: now,
    activeRunCount: body.activeRunCount,
    queuedRunCount: body.queuedRunCount,
  };

  // Upsert on `deviceId`, which is unique on `WorkHost`. Two heartbeats racing
  // the very first registration would otherwise both find no row and both
  // insert, and the second would fail on the unique index — an error the host
  // would report as an outage on the one request that establishes it exists.
  const host = await prisma.workHost.upsert({
    where: { deviceId: device.id },
    create: { userId: user.id, deviceId: device.id, ...advertisement },
    update: advertisement,
  });

  // Only the transition is logged, not every heartbeat: a row per advertisement
  // would bury the two events anybody actually looks for — when this Mac
  // started accepting work, and when it stopped.
  if (!existing || existing.enabled !== host.enabled) {
    await recordWorkAudit({
      userId: user.id,
      kind: host.enabled ? "host_enabled" : "host_disabled",
      severity: "info",
      actor: "macos",
      hostId: host.id,
      detail: {
        hostId: host.id,
        deviceId: device.id,
        enabled: host.enabled,
        platform: host.platform,
        appVersion: host.appVersion,
        protocolVersion: host.protocolVersion,
        capabilities: advertisedCapabilityKeys(manifest),
        policy: host.approvalPolicy,
      },
    });
  }

  return NextResponse.json({
    host: serializeHost(host),
    // The keys this relay will actually route on, which is the manifest minus
    // any name this backend has no meaning for. Returned so a newer Mac can
    // see that half its advertisement is being ignored rather than infer it
    // from work that never arrives.
    routableCapabilities: advertisedCapabilityKeys(manifest),
  });
}
