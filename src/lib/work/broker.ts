/**
 * Token brokering: how a Work run calls a connector without ever holding the
 * credential that authorises the call.
 *
 * WHY A RAW TOKEN INSIDE AN AGENT PROCESS IS AN UNRECOVERABLE DISCLOSURE
 *
 * A credential that reaches the agent is not "in a variable". It is in the
 * model's context, which means it is in the request body sent to the provider,
 * in the transcript persisted so the run can be resumed, in the event stream
 * rendered on the phone and the Mac, and in anything the model quotes back —
 * and a model asked to debug its own failing tool call quotes headers. Every
 * one of those is a copy made in a different system with a different retention
 * policy, and not one of them can be recalled. There is no "delete the leaked
 * token" operation; there is only revocation, and revocation is the user's
 * work, not ours: an OAuth app means re-authorising every connector, an
 * app-specific password means rotating it in an Apple ID and updating whatever
 * else used it. So the failure is not that a secret was seen. It is that the
 * user acquires a chore they did not cause, and until they do it an attacker
 * who read one transcript can act as them with no further access to Juno.
 *
 * The alternative is what this file implements. The run is handed a handle: an
 * opaque, unguessable string that names one run, one connector and one narrowed
 * set of scopes, expires in minutes, and is worthless to anyone who is not
 * talking to this process. The mapping from handle to credential never crosses
 * into the sandbox — the broker does not even store the credential, only a
 * reference the trusted side can resolve — and revoking every handle a run
 * holds is a map delete rather than a conversation with the user. A handle in a
 * transcript is an incident that has already expired.
 *
 * THE EXCHANGE IS ONE-WAY AND SINGLE-USE PER CALL
 *
 * One-way: given a handle nothing about the credential can be derived, because
 * the handle is random rather than encoded, and the broker's own map is keyed by
 * a hash of the handle so its contents are not a table of usable handles either.
 * Single-use per call: each redemption carries an exchange id that is spent the
 * moment it is presented, so a handle captured mid-flight cannot be replayed
 * against a call that already happened. The count is bounded as well as the
 * clock, so a handle that escapes is limited even inside its lifetime.
 *
 * WHAT THIS DOES NOT COVER
 *
 * On the Anthropic path Juno hands the provider the MCP URL and a token and
 * Claude makes the calls itself (`anthropicMcpServers` in src/lib/mcp.ts). A
 * handle only works where the endpoint being called can redeem it — a
 * Juno-hosted MCP route, as src/lib/connector-token.ts already does for the
 * Apple connectors. For a third-party MCP server reached directly, the
 * provider needs the provider's own token and the broker cannot stand in the
 * middle. That path still puts a real credential outside this process, and no
 * amount of brokering here changes it.
 *
 * No `server-only` import, for the same reason as domain.ts and tool-access.ts:
 * the decisions here are pure and are unit-tested without a database. Nothing
 * in this file reads the environment or holds credential material at rest — the
 * `CredentialResolver` the caller supplies is where the decryption happens, and
 * that implementation is where `server-only` belongs.
 */

import { createHash, randomBytes } from "crypto";
import type { WorkAuditIntent } from "@/lib/work/connectors";

/**
 * Default handle lifetime.
 *
 * Short enough that a handle in a transcript is stale before anyone reads the
 * transcript, long enough to cover a connector call and its retry. Minting
 * again is free and only the trusted side can do it, so there is no reason to
 * be generous here.
 */
export const DEFAULT_HANDLE_TTL_MS = 5 * 60_000;

/**
 * The ceiling a caller cannot argue past. Matches TOKEN_TTL_MS in
 * src/lib/connector-token.ts: the two are the same kind of object — a
 * short-lived stand-in the model may hold — and letting Work mint longer-lived
 * ones would quietly make the weaker of the two the account's real exposure.
 */
export const MAX_HANDLE_TTL_MS = 15 * 60_000;

/**
 * Redemptions one handle may pay for before it is spent.
 *
 * A count as well as a clock, because "it expires in five minutes" says nothing
 * about how much damage fits into five minutes. Sixty-four is well above what a
 * single run legitimately makes against one connector inside one handle's life,
 * and a run that genuinely needs more asks the trusted side for another handle.
 */
export const DEFAULT_MAX_EXCHANGES = 64;

/**
 * How long a revoked or expired handle is remembered.
 *
 * Kept as a tombstone rather than deleted immediately so that the refusal can
 * say "revoked" or "expired" instead of "unknown". The distinction is the whole
 * value of the record during an incident: an unknown handle means something
 * forged one, a revoked handle means a real run kept using one after it was
 * pulled, and collapsing the two makes both unreadable.
 */
export const TOMBSTONE_GRACE_MS = 10 * 60_000;

/**
 * What the broker stores in place of a credential.
 *
 * Identifiers only. The real token is fetched at redemption time by the
 * resolver and is never held between calls, so a heap dump of a long-running
 * relay process yields row ids rather than the account's connectors.
 */
export interface WorkCredentialRef {
  connectorId: string;
  /** The Connection row. Useless without the database and the encryption key. */
  connectionId: string;
  /** Set for a local connector: the Mac that holds the credential. */
  hostId?: string | null;
}

/**
 * How the trusted side turns a reference into a credential.
 *
 * Given the narrowed scopes as well as the reference so an implementation that
 * can mint a downscoped token does, rather than handing back the account-wide
 * one and relying on the caller to behave.
 */
export type CredentialResolver = (
  ref: WorkCredentialRef,
  scopes: readonly string[]
) => Promise<string>;

export interface WorkHandleRequest {
  runId: string;
  connectorId: string;
  credential: WorkCredentialRef;
  /**
   * The scopes this handle may be exercised with, already narrowed to what the
   * run needs. A redemption asking for anything outside this set is refused
   * rather than trimmed: a call that asked for more than it was given is a call
   * whose author believed something false about its own permissions.
   */
  scopes: readonly string[];
  /** Clamped to MAX_HANDLE_TTL_MS. */
  ttlMs?: number;
  maxExchanges?: number;
}

/**
 * The only credential-shaped thing the run ever sees.
 *
 * Every field is safe to put on the wire, in an event, or in a transcript —
 * which is the point, because it will end up in all three.
 */
export interface WorkBrokerHandle {
  handle: string;
  runId: string;
  connectorId: string;
  scopes: readonly string[];
  /** Unix ms. */
  expiresAt: number;
  maxExchanges: number;
}

export interface WorkExchangeRequest {
  handle: string;
  /**
   * Unique per call, generated by the caller making the call. Presenting one
   * twice is a replay, not a retry — a retry generates a new id.
   */
  exchangeId: string;
  runId: string;
  connectorId: string;
  /** The scopes this particular call needs. Must be a subset of the handle's. */
  scopes: readonly string[];
}

export const WORK_EXCHANGE_REFUSALS = [
  "unknown_handle",
  "revoked",
  "expired",
  "connector_mismatch",
  "run_mismatch",
  "scope_exceeded",
  "replayed",
  "exchange_limit",
  "credential_unavailable",
] as const;

export type WorkExchangeRefusal = (typeof WORK_EXCHANGE_REFUSALS)[number];

/**
 * Refusals that mean something presented a handle it should not have had, as
 * opposed to a handle that ran out. The first group is a security finding worth
 * paging someone about; the second is housekeeping a healthy run does daily,
 * and grading them the same trains whoever reads the log to skip the row.
 */
const FORGERY_SHAPED = new Set<WorkExchangeRefusal>([
  "unknown_handle",
  "connector_mismatch",
  "run_mismatch",
  "scope_exceeded",
  "replayed",
]);

export type WorkExchangeResult =
  | {
      ok: true;
      /**
       * The real credential. Its only legitimate destination is an outbound
       * request header on the call this exchange paid for. It must not be
       * returned to the sandbox, written to an event, stored on the run, or put
       * in a tool argument — every one of those is the disclosure this module
       * exists to prevent.
       */
      credential: string;
      exchangeId: string;
      scopes: readonly string[];
      expiresAt: number;
    }
  | {
      ok: false;
      reason: WorkExchangeRefusal;
      explanation: string;
      audit: WorkAuditIntent;
    };

/** Everything about a handle except what makes it usable. Safe to render. */
export interface WorkHandleView {
  runId: string;
  connectorId: string;
  scopes: readonly string[];
  expiresAt: number;
  exchangesUsed: number;
  maxExchanges: number;
  revoked: boolean;
}

export interface WorkBrokerOptions {
  /** Injected so expiry is tested against a clock rather than a sleep. */
  now?: () => number;
  /** Injected only for tests; the default is 32 bytes of CSPRNG output. */
  newHandle?: () => string;
  defaultTtlMs?: number;
  maxExchanges?: number;
}

interface BrokerEntry {
  runId: string;
  connectorId: string;
  credential: WorkCredentialRef;
  scopes: Set<string>;
  expiresAt: number;
  maxExchanges: number;
  /** Exchange ids already presented. Bounded by maxExchanges. */
  spent: Set<string>;
  revokedAt: number | null;
}

function defaultHandle(): string {
  // 32 bytes, so the handle cannot be guessed and cannot be confused with an
  // id from anywhere else in the system. The prefix is for humans reading a log
  // line and deciding whether they are looking at a secret.
  return `wkh_${randomBytes(32).toString("base64url")}`;
}

/**
 * Keyed by hash rather than by the handle itself.
 *
 * The map is then not a list of working handles: someone who reads the broker's
 * memory learns which runs hold access to which connectors, which is a real
 * disclosure, but cannot use any of it to make a call. Cheap, and it removes
 * the worst version of a memory-disclosure bug.
 */
function key(handle: string): string {
  return createHash("sha256").update(handle).digest("hex");
}

function refusalAudit(
  reason: WorkExchangeRefusal,
  request: WorkExchangeRequest,
  entry: BrokerEntry | undefined
): WorkAuditIntent {
  return {
    // WORK_AUDIT_KINDS has no kind for token brokering, and it is not this
    // file's place to add one. `command_refused` is the closest true statement:
    // something asked the trusted side to do a thing on a run's behalf and was
    // told no. `action` names which trusted-side operation it was, so these
    // rows stay separable from relay-command refusals.
    kind: "command_refused",
    severity: FORGERY_SHAPED.has(reason) ? "violation" : "refusal",
    detail: {
      action: "connector_token_exchange",
      reason,
      decision: "refused",
      /*
       * `runId` and `connectorId` are what the request CLAIMED, not what the
       * broker verified — for a forged handle there is nothing verified to
       * record. They stay the claim in every case rather than switching to the
       * handle's own values when one happens to resolve, because a column that
       * silently means two different things cannot be queried.
       *
       * Every key here is on ALLOWED_AUDIT_KEYS in src/lib/work/audit.ts;
       * anything else is dropped by sanitizeAuditDetail without comment, and a
       * refusal row that reaches the table empty is worse than no row.
       */
      runId: request.runId,
      connectorId: request.connectorId,
      requestId: request.exchangeId,
      ...(entry ? { attempts: entry.spent.size } : {}),
    },
  };
}

/**
 * The handle-to-credential mapping, held in the trusted process.
 *
 * There is deliberately no method that takes a run id and returns credentials,
 * and no method that lists handles. Redemption requires presenting the handle,
 * so a compromised run can exercise what it was given and cannot enumerate what
 * it was not.
 */
export class WorkTokenBroker {
  private readonly entries = new Map<string, BrokerEntry>();
  private readonly now: () => number;
  private readonly newHandle: () => string;
  private readonly defaultTtlMs: number;
  private readonly defaultMaxExchanges: number;

  constructor(options: WorkBrokerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newHandle = options.newHandle ?? defaultHandle;
    this.defaultTtlMs = Math.min(options.defaultTtlMs ?? DEFAULT_HANDLE_TTL_MS, MAX_HANDLE_TTL_MS);
    this.defaultMaxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  }

  /** Handles currently held, tombstones included. For operations, not callers. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Issue a handle for one run and one connector.
   *
   * The returned object contains no credential material, so it can be sent
   * straight into the sandbox. The reference stays here.
   */
  mint(request: WorkHandleRequest): WorkBrokerHandle {
    // A zero or negative ttl produces a handle that is already expired rather
    // than one that falls back to the default. Both readings are defensible;
    // this one fails closed, and the caller finds out on the first exchange
    // instead of holding a five-minute credential it thought it had asked not
    // to have.
    const ttl = Math.min(Math.max(request.ttlMs ?? this.defaultTtlMs, 0), MAX_HANDLE_TTL_MS);
    const expiresAt = this.now() + ttl;
    const scopes = [...new Set(request.scopes)];
    const maxExchanges = Math.max(request.maxExchanges ?? this.defaultMaxExchanges, 1);
    const handle = this.newHandle();

    this.entries.set(key(handle), {
      runId: request.runId,
      connectorId: request.connectorId,
      credential: request.credential,
      scopes: new Set(scopes),
      expiresAt,
      maxExchanges,
      spent: new Set(),
      revokedAt: null,
    });

    return {
      handle,
      runId: request.runId,
      connectorId: request.connectorId,
      scopes,
      expiresAt,
      maxExchanges,
    };
  }

  /** What a handle is for, without anything that would let it be used. */
  inspect(handle: string): WorkHandleView | null {
    const entry = this.entries.get(key(handle));
    if (!entry) return null;
    return {
      runId: entry.runId,
      connectorId: entry.connectorId,
      scopes: [...entry.scopes],
      expiresAt: entry.expiresAt,
      exchangesUsed: entry.spent.size,
      maxExchanges: entry.maxExchanges,
      revoked: entry.revokedAt !== null,
    };
  }

  /**
   * Redeem a handle for the credential behind it, once.
   *
   * The checks are ordered so that the refusal names the strongest true thing:
   * a handle presented for the wrong connector is reported as a mismatch even
   * if it also happens to be expired, because "expired" would send whoever
   * reads it to look at clocks.
   */
  async exchange(
    request: WorkExchangeRequest,
    resolve: CredentialResolver
  ): Promise<WorkExchangeResult> {
    const entry = this.entries.get(key(request.handle));
    if (!entry) {
      return this.refuse("unknown_handle", request, undefined, "This handle is not one Juno issued, or it was issued long enough ago to have been forgotten.");
    }
    if (entry.connectorId !== request.connectorId) {
      return this.refuse("connector_mismatch", request, entry, `This handle is for ${entry.connectorId}, not ${request.connectorId}.`);
    }
    if (entry.runId !== request.runId) {
      return this.refuse("run_mismatch", request, entry, "This handle belongs to a different run.");
    }
    if (entry.revokedAt !== null) {
      return this.refuse("revoked", request, entry, "This handle was revoked.");
    }
    if (this.now() >= entry.expiresAt) {
      return this.refuse("expired", request, entry, "This handle has expired. Ask for a new one.");
    }
    const exceeded = request.scopes.filter((s) => !entry.scopes.has(s));
    if (exceeded.length > 0) {
      return this.refuse("scope_exceeded", request, entry, `This handle does not cover ${exceeded.join(", ")}.`);
    }
    if (entry.spent.has(request.exchangeId)) {
      return this.refuse("replayed", request, entry, "This exchange has already been used. A retry needs a new exchange id.");
    }
    if (entry.spent.size >= entry.maxExchanges) {
      return this.refuse("exchange_limit", request, entry, `This handle has been used ${entry.maxExchanges} times, which is its limit. Ask for a new one.`);
    }

    /*
     * Spend the ticket before resolving, not after.
     *
     * A resolver that fails after the ticket is spent costs the caller one
     * retry with a fresh exchange id. Spending after would mean a failure
     * anywhere in the resolve — a timeout, a lost response — leaves the id
     * reusable, and a reused id is indistinguishable from a captured one being
     * replayed. Given that ambiguity, refusing is the only safe reading, so the
     * id has to be burnt at presentation.
     */
    entry.spent.add(request.exchangeId);

    let credential: string;
    try {
      credential = await resolve(entry.credential, [...entry.scopes]);
    } catch {
      // The resolver's error is deliberately not carried into the audit detail:
      // a decryption or provider failure message is exactly the kind of string
      // that ends up containing a fragment of what it failed on.
      return this.refuse(
        "credential_unavailable",
        request,
        entry,
        `Juno could not retrieve the authorisation for ${entry.connectorId}. It may need to be reconnected.`
      );
    }

    return {
      ok: true,
      credential,
      exchangeId: request.exchangeId,
      scopes: [...entry.scopes],
      expiresAt: entry.expiresAt,
    };
  }

  /** Revoke one handle. Returns false when it was never known. */
  revokeHandle(handle: string): boolean {
    const entry = this.entries.get(key(handle));
    if (!entry || entry.revokedAt !== null) return false;
    entry.revokedAt = this.now();
    return true;
  }

  /**
   * Revoke everything a run holds, and the reason the run's end must call it:
   * a finished run has no legitimate use for a connector, so anything still
   * presenting its handles afterwards is either a leak being exercised or a
   * bug, and both want the same answer.
   */
  revokeRun(runId: string): number {
    let revoked = 0;
    for (const entry of this.entries.values()) {
      if (entry.runId !== runId || entry.revokedAt !== null) continue;
      entry.revokedAt = this.now();
      revoked += 1;
    }
    return revoked;
  }

  /**
   * Drop tombstones old enough that "unknown" is the honest answer anyway.
   *
   * Called on a timer by whatever owns the broker. Without it a relay process
   * that runs for weeks accumulates one entry per connector per run forever,
   * and the map becomes a slow leak of exactly the metadata this class tries to
   * hold as little of as possible.
   */
  sweep(): number {
    const cutoff = this.now() - TOMBSTONE_GRACE_MS;
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      const done = entry.revokedAt ?? entry.expiresAt;
      if (done > cutoff) continue;
      this.entries.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  private refuse(
    reason: WorkExchangeRefusal,
    request: WorkExchangeRequest,
    entry: BrokerEntry | undefined,
    explanation: string
  ): WorkExchangeResult {
    return { ok: false, reason, explanation, audit: refusalAudit(reason, request, entry) };
  }
}
