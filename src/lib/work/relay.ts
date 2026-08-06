/**
 * The pure decisions of the Juno Work relay.
 *
 * The relay is the seam where a phone or a browser causes something to happen
 * on somebody's Mac. Everything that actually goes wrong in that arrangement is
 * a decision rather than a query: a revocation landing while a host is parked
 * in a long poll, two Macs racing for one command, a lease expiring while the
 * work is still running, a command kind a host's build has no parser for, a
 * batch of events re-delivered because the acknowledgement was lost. Each of
 * those has an awkward boundary case, and a check that can only be exercised
 * against a live Postgres and a live Mac is a check that is exercised once, by
 * hand, on the day it is written.
 *
 * So the decisions live here, as functions of their arguments and a clock, and
 * the route handlers in `src/app/api/work/hosts/**` do the reading and writing.
 * Deliberately free of `server-only`, Prisma and SDK imports, exactly like
 * `domain.ts` and `event-envelope.ts`, so `tests/work-relay.test.ts` can import
 * it without a database.
 *
 * Nothing here re-declares a vocabulary `@/lib/work/domain` owns.
 */

import { z } from "zod";
import {
  COMMAND_LEASE_MS,
  COMMAND_TTL_MS,
  WORK_CAPABILITIES,
  WORK_COMMAND_KINDS,
  WORK_EVENT_KINDS,
  WORK_PERMISSION_POLICIES,
  WORK_TERMINAL_REASONS,
  narrowestPolicy,
  type WorkAuditKind,
  type WorkAuditSeverity,
  type WorkCapability,
  type WorkCommandKind,
  type WorkPermissionPolicy,
  type WorkTerminalReason,
} from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Protocol generations
// ---------------------------------------------------------------------------

/**
 * The wire generation this relay speaks.
 *
 * Bumped when a command kind is added or an existing payload gains a field a
 * previous build would misread. It is not a version of this file — an older
 * Mac keeps working against a newer relay, which is the entire reason the
 * number exists.
 */
export const RELAY_PROTOCOL_VERSION = 3;

/**
 * The lowest host generation that can parse each command kind.
 *
 * Generation 1 is the control plane every build that has ever shipped
 * understands: it either reduces what a run is doing or answers a question the
 * host itself asked. Generation 2 added the instructions that carry a payload
 * an older parser has no case for — `undo` names a batch from the host's own
 * journal, and the grant instructions name a folder dialog and an access mode.
 * Generation 3 added `steer`, which is the first instruction that changes what
 * a run is *doing* rather than whether it is running: a build with no case for
 * it holds a live model loop that was handed its goal at start and re-reads
 * nothing, so a Mac that cannot parse this has to be refused at enqueue. Told
 * "your Mac's version of Juno cannot do that" a person updates it; handed
 * silence they retype the sentence.
 *
 * The table is exhaustive over `WORK_COMMAND_KINDS` on purpose. A kind added to
 * `domain.ts` without a generation here is a compile error, which is the moment
 * somebody has to decide whether a Mac in the field can read it — the
 * alternative is defaulting it to 1 and discovering the answer from a host that
 * silently did nothing.
 */
export const COMMAND_KIND_PROTOCOL: Record<WorkCommandKind, number> = {
  start: 1,
  pause: 1,
  resume: 1,
  stop: 1,
  answer: 1,
  approve: 1,
  deny: 1,
  refresh_capabilities: 1,
  ping: 1,
  undo: 2,
  grant_folder: 2,
  revoke_grant: 2,
  steer: 3,
};

/**
 * The generation to route by, which is the lower of what was registered and
 * what the polling host says it is running right now.
 *
 * The two differ after a rollback: the row still records the generation the
 * newer build registered with, the binary that replaced it cannot parse half of
 * it, and routing on the stored number sends that host a command it will refuse
 * every time it is re-leased until it expires. A host may narrow itself; it may
 * not widen itself past what it registered, because the registration is the
 * claim the account's owner can actually see.
 */
export function negotiatedProtocolVersion(
  registered: number,
  declared?: number | null
): number {
  const floor = Number.isFinite(registered) && registered > 0 ? Math.floor(registered) : 1;
  if (declared === undefined || declared === null) return floor;
  if (!Number.isFinite(declared) || declared < 1) return floor;
  return Math.min(floor, Math.floor(declared));
}

export function hostUnderstands(kind: string, protocolVersion: number): boolean {
  const required = COMMAND_KIND_PROTOCOL[kind as WorkCommandKind];
  return required !== undefined && protocolVersion >= required;
}

/**
 * The kinds a host of this generation may be handed.
 *
 * Returned as a list rather than a predicate because the claim query filters on
 * it in the database: skipping an unparseable command in application code after
 * the row has already been leased would burn the lease and hand the host
 * nothing, once per poll, forever.
 */
export function supportedCommandKinds(protocolVersion: number): WorkCommandKind[] {
  return WORK_COMMAND_KINDS.filter((kind) => hostUnderstands(kind, protocolVersion));
}

// ---------------------------------------------------------------------------
// Long poll and lease arithmetic
// ---------------------------------------------------------------------------

/**
 * How long a claim request parks before answering "nothing yet".
 *
 * Under the sixty-second ceiling every serverless platform and reverse proxy in
 * front of this route enforces, with room for the response to travel. A poll
 * cut off by an infrastructure timeout looks to the host exactly like a network
 * failure, so it backs off — which is the opposite of what an idle relay wants.
 */
export const HOST_POLL_WINDOW_MS = 25_000;

/** Gap between claim attempts inside one long poll. Matches the Code relay. */
export const HOST_POLL_INTERVAL_MS = 1_250;

export function commandExpiresAt(now: Date, ttlMs: number = COMMAND_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs);
}

export function commandLeaseUntil(now: Date, leaseMs: number = COMMAND_LEASE_MS): Date {
  return new Date(now.getTime() + leaseMs);
}

export function pollDeadline(startedAt: Date, windowMs: number = HOST_POLL_WINDOW_MS): Date {
  return new Date(startedAt.getTime() + windowMs);
}

/**
 * Whether there is time for another attempt before the poll must answer.
 *
 * The interval is added before the comparison rather than after the sleep: a
 * loop that checks only the deadline sleeps one last time and then answers
 * late, which is precisely how a poll sized to fit under a proxy timeout stops
 * fitting under it.
 */
export function shouldPollAgain(
  deadline: Date,
  now: Date,
  intervalMs: number = HOST_POLL_INTERVAL_MS
): boolean {
  return now.getTime() + intervalMs < deadline.getTime();
}

// ---------------------------------------------------------------------------
// Claimability
// ---------------------------------------------------------------------------

/** The columns of a `WorkCommand` a claim decision reads, and no others. */
export interface ClaimableCommandView {
  kind: string;
  status: string;
  expiresAt: Date;
  leaseExpiresAt: Date | null;
}

export type CommandClaimability =
  /** Free to lease right now. */
  | "claimable"
  /** Past `expiresAt`. Never handed out, whatever its status says. */
  | "expired"
  /** Claimed by somebody whose lease is still running. */
  | "leased"
  /** Already succeeded, failed, expired or was cancelled. */
  | "settled"
  /** Valid and free, but this host's build cannot parse it. */
  | "unsupported";

/**
 * Why a command may or may not be handed to this host, in one value.
 *
 * Expiry is tested before status, and that order is the point. A command whose
 * TTL has passed is not claimable even though its row still says `pending`: a
 * "stop" issued five minutes ago and claimed now by a Mac that has just woken
 * would stop the run the user restarted in the meantime, which is a strictly
 * worse outcome than the stop never arriving.
 *
 * An expired *lease* is the opposite case and must stay claimable. A host that
 * crashed holding a command has not done the work, and refusing to re-hand it
 * would strand the session behind a lease nobody is going to release.
 */
export function commandClaimability(
  command: ClaimableCommandView,
  now: Date,
  protocolVersion: number
): CommandClaimability {
  if (command.expiresAt.getTime() <= now.getTime()) return "expired";
  if (command.status !== "pending" && command.status !== "claimed") return "settled";
  if (
    command.status === "claimed" &&
    command.leaseExpiresAt !== null &&
    command.leaseExpiresAt.getTime() > now.getTime()
  ) {
    return "leased";
  }
  if (!hostUnderstands(command.kind, protocolVersion)) return "unsupported";
  return "claimable";
}

export function isClaimable(
  command: ClaimableCommandView,
  now: Date,
  protocolVersion: number
): boolean {
  return commandClaimability(command, now, protocolVersion) === "claimable";
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The refusal codes this surface emits.
 *
 * The strings are load-bearing: `NativeWorkClient.workError` switches on them
 * to decide whether a failure is a network problem worth a Retry button or a
 * final answer worth a sentence. Renaming one here turns a revocation back into
 * a generic server error, and a generic server error is something the host loop
 * backs off and retries forever.
 */
export type WorkRelayRefusalCode =
  | "work_host_revoked"
  | "work_host_not_enabled"
  | "work_host_unknown_command"
  | "work_command_expired"
  | "work_command_conflict";

export interface WorkRelayRefusal {
  code: WorkRelayRefusalCode;
  status: number;
  /** Addressed to the person watching, because that is where it is rendered. */
  message: string;
  /** Whether trying the identical request again could ever succeed. */
  retryable: boolean;
  audit: WorkAuditKind;
  severity: WorkAuditSeverity;
}

const REVOKED: WorkRelayRefusal = {
  code: "work_host_revoked",
  status: 403,
  message: "This Mac's access to Juno Work has been revoked.",
  // Non-retryable is the entire mechanism. `WorkRemoteHost.run` moves to
  // `.stopped` on a non-retryable error and keeps backing off on anything else,
  // so a retryable revocation is a decommissioned Mac that polls a relay which
  // has already told it to stop, until somebody notices the traffic.
  retryable: false,
  // Filed under `host_revoked` rather than `command_refused` so that "what did
  // that Mac do after we revoked it" is one query on one kind. Every other
  // refusal here is about a command and is filed as such.
  audit: "host_revoked",
  severity: "refusal",
};

const NOT_ENABLED: WorkRelayRefusal = {
  code: "work_host_not_enabled",
  status: 403,
  message: "Juno Work is switched off on this Mac.",
  retryable: false,
  audit: "command_refused",
  severity: "refusal",
};

const UNKNOWN_COMMAND: WorkRelayRefusal = {
  code: "work_host_unknown_command",
  status: 409,
  message: "This Mac's version of Juno cannot carry out that instruction.",
  // Permanent for this pairing: the answer changes when the Mac is updated, not
  // when the request is repeated.
  retryable: false,
  audit: "command_refused",
  severity: "refusal",
};

const COMMAND_EXPIRED: WorkRelayRefusal = {
  code: "work_command_expired",
  status: 410,
  message: "That instruction expired before this Mac could act on it.",
  retryable: false,
  audit: "command_refused",
  severity: "refusal",
};

const COMMAND_CONFLICT: WorkRelayRefusal = {
  code: "work_command_conflict",
  status: 409,
  message: "That instruction is no longer in a state this Mac can complete.",
  retryable: false,
  audit: "command_refused",
  severity: "warning",
};

export const WORK_RELAY_REFUSALS = {
  revoked: REVOKED,
  notEnabled: NOT_ENABLED,
  unknownCommand: UNKNOWN_COMMAND,
  commandExpired: COMMAND_EXPIRED,
  commandConflict: COMMAND_CONFLICT,
} as const;

/** The host columns every refusal decision reads. */
export interface HostGateView {
  enabled: boolean;
  revokedAt: Date | null;
}

/**
 * Whether this host may take part in the relay at all, re-evaluated on every
 * pass of a long poll rather than once at connect.
 *
 * `allowDisabled` exists for exactly one caller: acknowledging a command that
 * was claimed before the user switched Work off. Revocation still refuses that
 * — it is a security action and the Mac has to stop talking — but merely
 * disabling should not strand an in-flight instruction with no outcome, which
 * presents to the user as a task that is stopping forever.
 */
export function refuseHostPlane(
  host: HostGateView,
  options: { allowDisabled?: boolean } = {}
): WorkRelayRefusal | null {
  if (host.revokedAt !== null) return REVOKED;
  if (!host.enabled && !options.allowDisabled) return NOT_ENABLED;
  return null;
}

/**
 * Whether a client may queue this kind for this host.
 *
 * Refused at enqueue rather than at delivery, so the phone that pressed the
 * button learns now that this Mac cannot do it. Checked again at claim time
 * because the Mac's build can change between the two, and a stale answer to a
 * capability question is the kind that gets discovered by a user watching a
 * spinner.
 */
export function refuseEnqueue(
  host: HostGateView,
  kind: string,
  protocolVersion: number
): WorkRelayRefusal | null {
  const gate = refuseHostPlane(host);
  if (gate) return gate;
  if (!hostUnderstands(kind, protocolVersion)) return UNKNOWN_COMMAND;
  return null;
}

/**
 * The refusal body, in the shape `NativeWorkClient` decodes.
 *
 * It reads `code`, `message` and `retryable` from a nested `error` object, so
 * the flat `{ error: "..." }` the older Code routes return would come back as
 * an unclassified server error and be retried. Built in one place rather than
 * written out per route for that reason.
 */
export function refusalBody(refusal: WorkRelayRefusal): {
  error: { code: WorkRelayRefusalCode; message: string; retryable: boolean };
} {
  return {
    error: { code: refusal.code, message: refusal.message, retryable: refusal.retryable },
  };
}

/**
 * The answer to "there is no such host" and to "that host is somebody else's".
 *
 * Deliberately the same object, and deliberately not a `WorkRelayRefusal`: it
 * carries no code for a client to branch on and writes no audit row against an
 * account that did not ask for it. A 403 here would confirm that the id names a
 * real Mac belonging to a real account, which is the one fact an attacker
 * holding a stolen session for a different account does not already have.
 */
export const HOST_NOT_FOUND = { error: "Not found" } as const;

// ---------------------------------------------------------------------------
// Dispatch: the instruction that drives a local run
// ---------------------------------------------------------------------------

/**
 * The command payload a Mac needs to start or restart a run.
 *
 * The two keys are the contract `DesktopWorkRunHost` is already written
 * against: it reads the goal from `payload.goal` (falling back to
 * `payload.prompt`) and the model from `payload.model`, and throws
 * `DesktopWorkRunError.noGoal` when neither goal key is there — a `start` that
 * omits the goal is a command the Mac claims, refuses, and acknowledges as
 * failed, which presents to the user as a task that started and immediately
 * broke for no stated reason.
 *
 * Only `goal` is written, never `prompt`. The fallback exists for older hosts
 * and writing both would be two places for the same sentence to differ.
 *
 * The goal is passed through whole. Truncating it to fit some notional payload
 * bound would silently change what the run was asked to do, and the ceiling
 * that matters — what a model will read — belongs to the run, not the wire.
 *
 * `model` is omitted rather than sent as null when the run has no concrete id,
 * because the Mac's `??` fallback to its own default only fires on a missing
 * key; a null would decode as a value and leave it driving a model called
 * nothing.
 *
 * `permissionPolicy` is the third key and the newest. Until it existed a Mac
 * gated every approval on its own `host.approvalPolicy` and never learned what
 * the task had asked for, so a task composed as Manual that landed on a Mac set
 * to Skip ran as Skip: the narrowing was computed correctly in the dispatch
 * route, written onto the run, digested into every approval — and then not sent
 * to the one machine that enforces it. Sending the already-narrowed value is
 * what closes that, and it can only ever be at least as strict as the Mac's own
 * setting because `resolveApprovalMode` intersected the two before it got here.
 *
 * Omitted, not nulled, when the caller has nothing to say, for the same reason
 * as `model`: `DesktopWorkExecutorAdapter` falls back to the host's policy on a
 * missing key, which is exactly the behaviour every build before this had.
 */
export function startCommandPayload(input: {
  goal: string;
  model?: string | null;
  permissionPolicy?: WorkPermissionPolicy | null;
}): Record<string, unknown> {
  const model = typeof input.model === "string" && input.model.length > 0 ? input.model : null;
  const policy = isPermissionPolicy(input.permissionPolicy) ? input.permissionPolicy : null;
  return {
    goal: input.goal,
    ...(model === null ? {} : { model }),
    ...(policy === null ? {} : { permissionPolicy: policy }),
  };
}

/**
 * The idempotency key for a command about one run.
 *
 * Derived rather than random, because `(userId, idempotencyKey)` is the unique
 * index the whole enqueue path rests on and a random key makes every retry a
 * second instruction. `start` and `stop` take no discriminator: a run is
 * started once and finished once — `finishRun` sees to the second — so the run
 * id alone names the instruction for all time. `pause`, `resume` and `answer`
 * can legitimately happen more than once for one run, so each carries the thing
 * that makes this occurrence distinct: the sequence of the transcript event
 * that recorded the transition, or the id of the question being answered.
 *
 * The `work:` prefix keeps these out of the way of the keys clients mint for
 * themselves, which are opaque strings from a phone and have no structure to
 * collide with.
 */
export function runCommandKey(
  runId: string,
  kind: WorkCommandKind,
  discriminator?: string | number
): string {
  return discriminator === undefined
    ? `work:run:${runId}:${kind}`
    : `work:run:${runId}:${kind}:${discriminator}`;
}

/**
 * The idempotency key for the command that carries an approval decision.
 *
 * Keyed on the approval and the answer rather than on the run: a decision is
 * written once — `decision: "pending"` in the route's WHERE sees to that — so a
 * retry of the same answer must reach the same command row, and the two answers
 * are different instructions that must never share one.
 */
export function approvalCommandKey(approvalId: string, decision: string): string {
  return `work:approval:${approvalId}:${decision}`;
}

/** The host columns a dispatch decision reads, and no others. */
export interface CommandHostView extends HostGateView {
  id: string;
  /** The generation the host registered with. Never one a client asserted. */
  protocolVersion: number;
}

export type RunCommandPlan =
  /** Queue it, at this Mac. */
  | { plan: "enqueue"; hostId: string }
  /**
   * Nothing to send, and nothing wrong. Cloud runs have no Mac to instruct, and
   * saying so explicitly is what stops a caller reading "no command" as an
   * error and refusing a dispatch that is going perfectly well.
   */
  | { plan: "skip"; why: "not_local" | "no_host" }
  | { plan: "refuse"; refusal: WorkRelayRefusal };

/**
 * Whether an owner's intent becomes an instruction on a Mac, and which.
 *
 * The whole of Juno Work on a Mac hangs off this being called: a run dispatched
 * to a local host used to reach `queued` and stop there, because
 * `POST /api/work/hosts/[id]/commands` was the only writer of the command queue
 * and no dispatch path ever called it. The Mac polled correctly, forever, for a
 * command nobody had written.
 *
 * The protocol check is `refuseEnqueue` rather than a second copy of the same
 * comparison. That matters more than it looks: `COMMAND_KIND_PROTOCOL` is the
 * single table saying which generation can parse what, and a duplicate test
 * here would be the one that goes stale when a kind is added — leaving a Mac
 * handed an instruction it cannot read, which it refuses once per re-lease
 * until the command expires.
 *
 * The registered generation is used, never a declared one. A declaration is
 * evidence from a host that is currently polling; enqueue happens on behalf of
 * a phone or a browser, which is in no position to say what that Mac can parse.
 */
export function planRunCommand(input: {
  /** The run's `effectiveTarget`. `local` is the only one with a Mac to tell. */
  effectiveTarget: string | null;
  host: CommandHostView | null;
  kind: WorkCommandKind;
}): RunCommandPlan {
  if (input.effectiveTarget !== "local") return { plan: "skip", why: "not_local" };
  // A local run whose host row has gone — revoked and deleted, or an account
  // whose Mac was removed between selection and dispatch. There is nothing to
  // instruct and nothing to refuse: the run's own lease sweep is what ends it.
  if (input.host === null) return { plan: "skip", why: "no_host" };

  const refusal = refuseEnqueue(input.host, input.kind, input.host.protocolVersion);
  if (refusal) return { plan: "refuse", refusal };

  return { plan: "enqueue", hostId: input.host.id };
}

// ---------------------------------------------------------------------------
// Host advertisements
// ---------------------------------------------------------------------------

/**
 * The switches a Mac advertises and a user may narrow.
 *
 * A type alias rather than an interface so it keeps an implicit index
 * signature: the register route stores the advertised set verbatim in a JSON
 * column, and Prisma's `InputJsonObject` accepts an object literal type but not
 * an interface.
 */
export type HostToggles = {
  enabled: boolean;
  allowsFileWork: boolean;
  allowsBrowser: boolean;
  allowsComputerUse: boolean;
  allowsShell: boolean;
  allowsBackground: boolean;
};

export const HOST_TOGGLE_KEYS = [
  "enabled",
  "allowsFileWork",
  "allowsBrowser",
  "allowsComputerUse",
  "allowsShell",
  "allowsBackground",
] as const satisfies readonly (keyof HostToggles)[];

/**
 * What the host itself last claimed, stored verbatim in `WorkHost.capabilities`.
 *
 * Kept separate from the boolean columns because those hold the *effective*
 * permission — the host's claim after the account owner has narrowed it — and
 * the two have to be distinguishable. Without the record of what was claimed,
 * a heartbeat cannot tell "off because this Mac cannot do it" from "off because
 * the user switched it off from their phone", and whichever way it guesses is
 * wrong half the time: either the kill switch is undone by the next heartbeat,
 * or a capability the user re-enabled on the Mac never comes back.
 */
export interface HostAdvertisement {
  toggles: HostToggles;
  /** Capability keys the host listed. Never derived from the toggles here. */
  capabilities: WorkCapability[];
  approvalPolicy: WorkPermissionPolicy;
}

const CAPABILITY_NAMES: ReadonlySet<string> = new Set(WORK_CAPABILITIES);

/**
 * The routable capability keys out of a stored or incoming manifest.
 *
 * Reads only what the host wrote. It does not consult the toggles, and that
 * restraint is the requirement rather than an omission: a relay that infers
 * `local_files` from `allowsFileWork` is a relay that routes file work to a Mac
 * whose build has no file tool, and the user watches it queue at a machine that
 * will refuse every command.
 *
 * Names this build does not know are dropped from the *routable* list while
 * remaining in the stored manifest, because `selectTarget` can only match on
 * capabilities it has a meaning for, and matching on an unknown string would be
 * inventing one.
 */
export function advertisedCapabilityKeys(manifest: unknown): WorkCapability[] {
  const listed = Array.isArray(manifest)
    ? manifest
    : manifest !== null && typeof manifest === "object"
      ? (manifest as { capabilities?: unknown }).capabilities
      : undefined;
  if (!Array.isArray(listed)) return [];
  const keys: WorkCapability[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string" || !CAPABILITY_NAMES.has(entry)) continue;
    const key = entry as WorkCapability;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function isPermissionPolicy(value: unknown): value is WorkPermissionPolicy {
  return typeof value === "string" && (WORK_PERMISSION_POLICIES as readonly string[]).includes(value);
}

/** Reads back an advertisement this relay previously stored. */
export function parseAdvertisement(stored: unknown): HostAdvertisement | null {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const raw = stored as { toggles?: unknown; approvalPolicy?: unknown };
  if (raw.toggles === null || typeof raw.toggles !== "object" || Array.isArray(raw.toggles)) {
    return null;
  }
  const toggles = raw.toggles as Record<string, unknown>;
  const read = (key: keyof HostToggles): boolean => toggles[key] === true;
  return {
    toggles: {
      enabled: read("enabled"),
      allowsFileWork: read("allowsFileWork"),
      allowsBrowser: read("allowsBrowser"),
      allowsComputerUse: read("allowsComputerUse"),
      allowsShell: read("allowsShell"),
      allowsBackground: read("allowsBackground"),
    },
    capabilities: advertisedCapabilityKeys(stored),
    // An unreadable policy reads as the strictest one, not as the default
    // `narrowestPolicy` returns for an empty argument list. That default is
    // `permissive`, which is correct for a meet and catastrophic here: a
    // manifest written by an older build, or truncated, would silently widen
    // what the Mac is allowed to do without asking.
    approvalPolicy: isPermissionPolicy(raw.approvalPolicy) ? raw.approvalPolicy : "conservative",
  };
}

/**
 * The toggles to write when a host re-advertises, preserving the owner's
 * narrowing.
 *
 * A toggle ends up on only if the host still claims it AND the owner has not
 * switched it off. The owner's decision is recovered by comparing the previous
 * advertisement with what was previously in force: a switch the host claimed and
 * that was nevertheless off was turned off by a person, and a heartbeat must not
 * undo that. Without this, switching file work off from a phone lasts until the
 * Mac's next heartbeat — under a minute — and the user watches the switch flip
 * back on by itself.
 *
 * `previous` being null is the first registration, where there is nothing to
 * preserve and the host's claim stands as written.
 */
export function reconcileToggles(
  previous: { advertised: HostToggles; effective: HostToggles } | null,
  advertised: HostToggles
): HostToggles {
  const next = {} as HostToggles;
  for (const key of HOST_TOGGLE_KEYS) {
    const ownerSwitchedOff =
      previous !== null && previous.advertised[key] && !previous.effective[key];
    next[key] = advertised[key] && !ownerSwitchedOff;
  }
  return next;
}

/**
 * The approval policy to write when a host re-advertises.
 *
 * Same asymmetry as the toggles, in three values instead of two: a policy
 * stricter than the host asked for was chosen by the owner and survives, while
 * a policy equal to the last advertisement is simply the host's and follows it.
 * Taking the meet unconditionally would be the bug — the Mac could then never
 * relax its own default again, because last time's value would hold it down
 * forever.
 */
export function reconcilePolicy(
  previous: { advertised: WorkPermissionPolicy; effective: WorkPermissionPolicy } | null,
  advertised: WorkPermissionPolicy
): WorkPermissionPolicy {
  if (previous === null) return advertised;
  const ownerNarrowed =
    previous.effective !== previous.advertised &&
    narrowestPolicy(previous.effective, previous.advertised) === previous.effective;
  return ownerNarrowed ? narrowestPolicy(advertised, previous.effective) : advertised;
}

// ---------------------------------------------------------------------------
// Owner-side toggling
// ---------------------------------------------------------------------------

export type HostTogglePatch = Partial<HostToggles>;

export interface HostToggleOutcome {
  /** The values to write. Never wider than the host's own advertisement. */
  applied: HostToggles;
  /**
   * Switches the caller asked to turn on that the host has not advertised.
   * Reported rather than silently dropped: a settings screen that shows a
   * toggle snapping back with no explanation is a bug report, and the honest
   * answer — "that Mac has not offered this" — is one the client can render.
   */
  refused: (keyof HostToggles)[];
}

/**
 * Applies an owner's toggle change against the ceiling the host advertised.
 *
 * The asymmetry is the escalation boundary of the whole relay. Switching a
 * capability *off* always works, from anywhere, immediately. Switching one *on*
 * requires the Mac to have said it is available, because the alternative is a
 * stolen web session granting shell access to a machine whose owner never
 * offered it — and the owner is the one person in the system who is standing in
 * front of that machine.
 */
export function narrowHostToggles(
  advertised: HostToggles,
  current: HostToggles,
  patch: HostTogglePatch
): HostToggleOutcome {
  const applied = {} as HostToggles;
  const refused: (keyof HostToggles)[] = [];
  for (const key of HOST_TOGGLE_KEYS) {
    const requested = patch[key];
    if (requested === undefined) {
      applied[key] = current[key];
      continue;
    }
    if (requested && !advertised[key]) {
      refused.push(key);
      applied[key] = current[key];
      continue;
    }
    applied[key] = requested;
  }
  return { applied, refused };
}

// ---------------------------------------------------------------------------
// The host outbox
// ---------------------------------------------------------------------------

/**
 * One event as a host presents it.
 *
 * `seq` is the *producer's* counter, not the relay's. The two are separate
 * sequence spaces on purpose: `WorkRun.lastSeq` is allocated by `appendEvents`
 * under a row lock and is what clients resume from, while this one belongs to
 * the host's outbox and is what tells the relay whether the batch in front of it
 * is complete. Conflating them would mean the relay could only detect a gap by
 * trusting a number the producer also uses to address its own storage.
 */
export interface IncomingHostEvent {
  seq: number;
  kind: string;
  eventKey?: string | null;
}

export interface HostOutboxPlan<E extends IncomingHostEvent> {
  /** The contiguous run, in order, that may be appended. */
  accepted: E[];
  /** Re-deliveries: at or below the acknowledged mark, or a repeated key. */
  duplicates: E[];
  /** The producer sequence the relay has now taken responsibility for. */
  acceptedThrough: number;
  /**
   * The first producer sequence missing from this batch, or null when the batch
   * was complete. The host re-sends from here.
   */
  firstGap: number | null;
}

export interface HostOutboxInput<E extends IncomingHostEvent> {
  /** The producer sequence the relay last accepted from this host, for this run. */
  acknowledgedSeq: number;
  events: readonly E[];
  /** Producer keys the run has already stored, when the caller has read them. */
  seenKeys?: ReadonlySet<string>;
}

/**
 * Sorts, deduplicates and gap-checks a host's outbox batch.
 *
 * Three separate failures, and the order they are handled in matters.
 *
 * Deduplication is by key rather than by "sequence above the cursor", for the
 * reason `event-envelope.ts` gives: a producer retrying a batch can resend a
 * *lower* sequence than one already stored, and a cursor-only rule would either
 * drop the legitimate re-delivery or accept the duplicate depending on which
 * side of the cursor the comparison fell.
 *
 * A gap truncates the batch instead of rejecting it, which is where this
 * departs from `planSessionEventAppend`. A host draining an hour of buffered
 * work presents thousands of events; refusing all of them because one is
 * missing throws away everything that did arrive and asks for it again, and the
 * re-send has the same hole in it. Accepting the contiguous prefix and naming
 * the missing sequence lets the host re-send from the hole, which is the only
 * request that can actually make progress.
 *
 * The relay's own idempotency still rests on `appendEvents`, which arbitrates
 * against the database. This plan is what makes the answer to the host —
 * accepted, duplicated, or "you skipped one" — computable before any of that.
 */
export function planHostOutbox<E extends IncomingHostEvent>(
  input: HostOutboxInput<E>
): HostOutboxPlan<E> {
  const seen = new Set(input.seenKeys ?? []);
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);

  const accepted: E[] = [];
  const duplicates: E[] = [];
  let expected = input.acknowledgedSeq + 1;
  let firstGap: number | null = null;

  for (const event of ordered) {
    const key = typeof event.eventKey === "string" && event.eventKey.length > 0 ? event.eventKey : null;
    if (key !== null && seen.has(key)) {
      duplicates.push(event);
      continue;
    }
    // Below the mark, or a second event claiming a slot already taken in this
    // same batch. Both are re-deliveries of something the relay has answered
    // for; neither may consume a new sequence.
    if (event.seq < expected) {
      duplicates.push(event);
      continue;
    }
    if (event.seq > expected) {
      firstGap = expected;
      break;
    }
    if (key !== null) seen.add(key);
    accepted.push(event);
    expected += 1;
  }

  return { accepted, duplicates, acceptedThrough: expected - 1, firstGap };
}

// ---------------------------------------------------------------------------
// The end of a run, as a host reports it
// ---------------------------------------------------------------------------

/** Terminal detail is prose about the ending, never the model's own text. */
const MAX_HOST_TERMINAL_DETAIL_CHARS = 4_000;

const TERMINAL_REASONS: ReadonlySet<string> = new Set(WORK_TERMINAL_REASONS);

/**
 * The `outcome` vocabulary a Mac reports, mapped onto the reason column.
 *
 * `DesktopWorkRunHost.finish` emits four: `succeeded` when the model stopped
 * with nothing left to call, `failed` when a turn threw, `stopped` when a
 * `stop` command was carried out, and `truncated` when the run hit the host's
 * ceiling on turns.
 *
 * `truncated` maps to `failed` and not to `budget_exceeded`, following
 * `WorkSession.terminalOutcome` in the cloud runtime, which makes the same call
 * for the same reason: nothing was over an account ceiling, and reporting one
 * sends the reader to raise a limit that was never the problem. It does not map
 * to `completed` either — a run that stopped at step sixty-four has not
 * answered the goal, and a green tick over it is the one outcome nobody can
 * act on.
 */
const HOST_OUTCOME_REASONS: Record<string, WorkTerminalReason> = {
  succeeded: "completed",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled",
  cancelled: "cancelled",
  truncated: "failed",
};

export interface HostTerminalReport {
  reason: WorkTerminalReason;
  /** Operator-facing prose behind the reason, or null when the host gave none. */
  detail: string | null;
}

function stringField(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One event, as much of it as a terminal reading needs. */
export interface TerminalEventView {
  kind: string;
  payload?: unknown;
}

/**
 * The run's ending, out of a batch a host drained — or null if it holds none.
 *
 * `run_finished` is the only kind that ends a run. `error` is deliberately not
 * terminal: both the Mac and the cloud runtime emit one mid-run and carry on,
 * and a relay that ended a run on the first error would stop a task over a tool
 * call that recovered.
 *
 * The FIRST `run_finished` wins, matching `finishRun`, whose WHERE excludes
 * every terminal status so that the first writer to commit decides why the run
 * ended. Reading the last one here and the first one there would be two rules
 * for one question.
 *
 * Three producers write this payload and they do not agree on a key, so all
 * three are read in order of how specific they are. `agent-core` sends
 * `terminalReason`, already in this vocabulary. `scripts/work-runner.ts` sends
 * `reason`, also in this vocabulary. The Mac sends `outcome` plus a `reason`
 * that is a sentence for a person — which is why `reason` is only taken as a
 * verdict when it actually is one, and otherwise becomes the detail. Guessing
 * the other way would file every local run under a terminal reason called
 * "Finished.".
 *
 * An ending this build cannot name is `failed`, not `completed`. The run is
 * over either way — that is what the event says — and of the two mislabels,
 * "we cannot say this worked" is the one a reader can act on.
 */
export function hostTerminalReport(
  events: readonly TerminalEventView[]
): HostTerminalReport | null {
  const finished = events.find((event) => event.kind === "run_finished");
  if (!finished) return null;

  const payload = finished.payload;
  const declared = stringField(payload, "terminalReason");
  const named = stringField(payload, "reason");
  const outcome = stringField(payload, "outcome");

  const reason: WorkTerminalReason =
    declared !== null && TERMINAL_REASONS.has(declared)
      ? (declared as WorkTerminalReason)
      : named !== null && TERMINAL_REASONS.has(named)
        ? (named as WorkTerminalReason)
        : outcome !== null && HOST_OUTCOME_REASONS[outcome] !== undefined
          ? HOST_OUTCOME_REASONS[outcome]
          : "failed";

  // The detail is whichever prose the producer offered: `detail` when it has
  // one, otherwise the sentence in `reason` — which is only prose when it was
  // not itself the verdict.
  const prose =
    stringField(payload, "detail") ?? (named !== null && !TERMINAL_REASONS.has(named) ? named : null);

  return { reason, detail: prose === null ? null : prose.slice(0, MAX_HOST_TERMINAL_DETAIL_CHARS) };
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/**
 * Colocated with the decisions rather than with the routes, exactly as
 * `src/app/api/work/protocol.ts` does for the session surface. A body shape and
 * the rule that reads it drift apart when they live in different files, and the
 * one that drifts here is the one a Mac in the field is already sending.
 */

/** Ids in this codebase are cuids; the cap is a sanity bound, not a format. */
const id = z.string().trim().min(1).max(200);

/** Matches the bound `protocol.ts` uses, for the reason it gives: a client
 *  minting keys for both surfaces should not have to remember two. */
const idempotencyKey = z.string().trim().min(8).max(200);

/** Bundle identifiers and domains. Long enough for a reverse-DNS name. */
const policyName = z.string().trim().min(1).max(253);

/**
 * What a Mac advertises when it registers or heartbeats.
 *
 * Every capability field is required to be *said*, not defaulted to on. A host
 * that omits a switch is a host that has not claimed it, and the reading of
 * "not claimed" is no — the other reading ships a feature switched on for
 * everybody who never opened settings.
 */
export const hostRegistrationSchema = z.object({
  deviceId: id,
  displayName: z.string().trim().min(1).max(200),
  // Work is macOS-only today. Widening this is a deliberate edit, the way the
  // Code device route was widened when the Windows client shipped, rather than
  // an open string that lets an unknown platform register silently.
  platform: z.literal("macos").default("macos"),
  appVersion: z.string().trim().max(100).default(""),
  protocolVersion: z.number().int().min(1).max(1_000).default(1),
  enabled: z.boolean().default(false),
  allowsFileWork: z.boolean().default(false),
  allowsBrowser: z.boolean().default(false),
  allowsComputerUse: z.boolean().default(false),
  allowsShell: z.boolean().default(false),
  allowsBackground: z.boolean().default(false),
  approvalPolicy: z.enum(WORK_PERMISSION_POLICIES).default("conservative"),
  /** The host's own `advertisedCapabilities`, stored verbatim. */
  capabilities: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  capabilitiesVersion: z.number().int().min(1).max(1_000).default(1),
  allowedApps: z.array(policyName).max(500).default([]),
  blockedApps: z.array(policyName).max(500).default([]),
  allowedDomains: z.array(policyName).max(500).default([]),
  activeRunCount: z.number().int().min(0).max(10_000).default(0),
  queuedRunCount: z.number().int().min(0).max(10_000).default(0),
});

export const enqueueCommandSchema = z.object({
  sessionId: id,
  runId: id.nullish(),
  kind: z.enum(WORK_COMMAND_KINDS),
  payload: z.record(z.string(), z.unknown()).default({}),
  payloadVersion: z.number().int().min(1).max(1_000).default(1),
  idempotencyKey,
});

/**
 * A host's answer for one command.
 *
 * Only the two outcomes a host can produce. `expired` and `cancelled` are
 * things that happen to a command rather than answers to it, and a host that
 * could send them would be claiming a verdict nobody reached.
 */
export const commandAckSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(10_000).optional(),
});

/**
 * An owner's change to one Mac.
 *
 * Every field optional, because PATCH is a partial update and the difference is
 * load-bearing: a body that filled in the absent fields would switch Work off
 * for the whole Mac every time somebody changed the browser toggle.
 * `revoked: false` is the one un-revocation path, and it is `false` only —
 * revoking is `DELETE`, which is where the audit trail expects to find it.
 */
export const hostPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowsFileWork: z.boolean().optional(),
    allowsBrowser: z.boolean().optional(),
    allowsComputerUse: z.boolean().optional(),
    allowsShell: z.boolean().optional(),
    allowsBackground: z.boolean().optional(),
    approvalPolicy: z.enum(WORK_PERMISSION_POLICIES).optional(),
    revoked: z.literal(false).optional(),
    // `allowedApps`, `blockedApps` and `allowedDomains` are deliberately absent,
    // and it is worth saying why so nobody "fixes" it: the Mac sends all three
    // on every heartbeat through `POST /register`, which writes them. Accepting
    // them here would let the web save a change that the next heartbeat — at
    // most thirty seconds later — silently reverted. They are edited on the Mac,
    // and the hosts screen shows them read-only and says so.
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty patch" });

export const hostOutboxSchema = z.object({
  runId: id,
  /**
   * The producer sequence this host believes the relay has accepted. Echoed
   * back on every response as `acceptedThrough`, so the two agree without the
   * relay having to keep a second sequence space alongside `WorkRun.lastSeq`.
   */
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  events: z
    .array(
      z.object({
        seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        kind: z.enum(WORK_EVENT_KINDS),
        payload: z.record(z.string(), z.unknown()).default({}),
        payloadVersion: z.number().int().min(1).max(1_000).optional(),
        eventKey: z.string().trim().min(1).max(200).nullish(),
        visibility: z.enum(["user", "operator", "internal"]).optional(),
        agentId: id.nullish(),
      })
    )
    .min(1)
    // A drain, not a firehose. Large enough that a Mac reconnecting after an
    // hour offline empties its outbox in a handful of round trips, small enough
    // that one request cannot hold a transaction open across thousands of rows.
    .max(500),
});
