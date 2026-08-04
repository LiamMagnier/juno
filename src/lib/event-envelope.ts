/**
 * One envelope for the three event streams Juno runs.
 *
 * Chat, Work-ready tasks and Code each grew their own event shape, and each
 * solved the same four problems differently: ordering, deduplication, replay
 * after a reconnect, and deciding what is safe to show. The result is that a
 * fix to any one of them — the cursor bug, the duplicate-on-retry bug — has to
 * be found and re-made in the other two, and the third is usually missed.
 *
 * This is the envelope, not the payloads. Domain events keep their own types:
 * forcing a file-change and a token-delta into one untyped JSON blob would
 * trade three honest shapes for one dishonest one, and the work order says so
 * explicitly. What is shared is the metadata every stream needs and each was
 * inventing separately.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports so it can be used
 * by the runner, the routes and the tests alike.
 */

export const EVENT_ENVELOPE_VERSION = 1;

/** Which stream an event belongs to. */
export type EventStream = "chat" | "task" | "code";

/**
 * How freely an event may be shown.
 *
 * The classification exists because "can the user see this" and "can it go in
 * a log" are different questions with different answers, and answering them
 * ad hoc at each call site is how a prompt ends up in an operator dashboard.
 */
export type EventVisibility =
  /** Safe to render to the user who owns the run. */
  | "user"
  /** Safe for operators: no message content, no secrets. */
  | "operator"
  /** Neither. Kept for correctness (cursors, sequencing) and never displayed. */
  | "internal";

export interface EventEnvelope<Kind extends string = string, Payload = unknown> {
  /** Envelope version, so a reader can tell a newer producer from a broken one. */
  v: number;
  /** Monotonic within `runId`. The cursor a client resumes from. */
  seq: number;
  /** The run, session or task this belongs to. */
  runId: string;
  stream: EventStream;
  kind: Kind;
  /** Version of `payload`'s own shape, independent of the envelope's. */
  payloadVersion: number;
  /** Producer clock, ISO-8601. Never used for ordering — `seq` is. */
  at: string;
  /**
   * Stable per-event key. A producer that retries after an unacknowledged
   * write presents the same key, so the consumer can drop the duplicate.
   */
  idempotencyKey: string;
  visibility: EventVisibility;
  payload: Payload;
}

export interface EnvelopeInput<Kind extends string, Payload> {
  runId: string;
  stream: EventStream;
  kind: Kind;
  payload: Payload;
  seq: number;
  at?: string;
  payloadVersion?: number;
  visibility?: EventVisibility;
  /** Overrides the derived key. Only for a producer with its own scheme. */
  idempotencyKey?: string;
}

/**
 * Derives the idempotency key from the run and the sequence.
 *
 * Not from the payload: two identical tokens legitimately arrive twice in a
 * stream, and hashing content would collapse them into one, silently deleting
 * a character from the user's reply. Position is the thing that is actually
 * unique.
 */
export function deriveIdempotencyKey(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

export function makeEnvelope<Kind extends string, Payload>(
  input: EnvelopeInput<Kind, Payload>
): EventEnvelope<Kind, Payload> {
  return {
    v: EVENT_ENVELOPE_VERSION,
    seq: input.seq,
    runId: input.runId,
    stream: input.stream,
    kind: input.kind,
    payloadVersion: input.payloadVersion ?? 1,
    at: input.at ?? new Date().toISOString(),
    idempotencyKey: input.idempotencyKey ?? deriveIdempotencyKey(input.runId, input.seq),
    // Defaults to the most restrictive of the three. A new event kind whose
    // author forgot to classify it is invisible rather than over-shared, and
    // an invisible event is a bug someone reports — the opposite is not.
    visibility: input.visibility ?? "internal",
    payload: input.payload,
  };
}

/** Events a client may render for the owner of the run. */
export function userVisible<E extends EventEnvelope>(events: readonly E[]): E[] {
  return events.filter((event) => event.visibility === "user");
}

/** Events safe to put in an operator log. */
export function operatorVisible<E extends EventEnvelope>(events: readonly E[]): E[] {
  return events.filter(
    (event) => event.visibility === "user" || event.visibility === "operator"
  );
}

/**
 * Drops events already seen, by key, and orders what remains by `seq`.
 *
 * By key rather than by "seq greater than the cursor": a producer that retried
 * a batch can resend a *lower* seq than one already stored, and a
 * cursor-only rule would either drop the legitimate re-delivery or accept the
 * duplicate, depending on which side the comparison fell.
 */
export function dedupe<E extends EventEnvelope>(
  events: readonly E[],
  seenKeys: ReadonlySet<string> = new Set()
): E[] {
  const seen = new Set(seenKeys);
  const out: E[] = [];
  for (const event of events) {
    if (seen.has(event.idempotencyKey)) continue;
    seen.add(event.idempotencyKey);
    out.push(event);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Events after a cursor, for a client resuming a stream.
 *
 * Exclusive of the cursor itself: a client that has stored event 12 asks for
 * "after 12" and must not be handed 12 again.
 */
export function replayFrom<E extends EventEnvelope>(
  events: readonly E[],
  afterSeq: number
): E[] {
  return events.filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

/**
 * The first gap in a sequence, or null when there is none.
 *
 * A consumer that cannot see gaps silently renders a truncated transcript as a
 * complete one — which is exactly the failure the outbox and the idempotency
 * key exist to prevent, arriving one layer further down.
 */
export function firstGap(events: readonly EventEnvelope[], afterSeq: number): number | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let expected = afterSeq + 1;
  for (const event of ordered) {
    if (event.seq > expected) return expected;
    expected = Math.max(expected, event.seq + 1);
  }
  return null;
}

/** True when a producer's envelope is newer than this build understands. */
export function isFutureEnvelope(event: Pick<EventEnvelope, "v">): boolean {
  return event.v > EVENT_ENVELOPE_VERSION;
}
