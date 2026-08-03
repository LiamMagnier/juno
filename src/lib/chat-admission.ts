/**
 * Stage one of the chat route: decide whether a request is admissible at all.
 *
 * `src/app/api/chat/route.ts` is 2,500 lines in which parsing, size checks,
 * idempotency recovery, context assembly, execution planning, streaming and
 * persistence are interleaved. Splitting it is Phase 7's job and is not
 * something to do in one pass; this is the first stage lifted out, chosen
 * because it is genuinely self-contained: it reads the raw body and returns a
 * verdict, touching no database and no provider.
 *
 * Pure, so the admission rules can be characterised by tests that do not need
 * a request, a session or a network — which is what makes the rest of the
 * split safe to do incrementally afterwards.
 */
import {
  checkBodyBytes,
  checkMessageSize,
  checkPrivateHistory,
  limitErrorBody,
  type RequestLimitViolation,
} from "@/lib/request-limits";

export type AdmissionVerdict<T> =
  | { ok: true; input: T }
  | {
      ok: false;
      status: number;
      /** The exact JSON body to return. */
      body: Record<string, unknown>;
    };

/** The shape the route's zod schema exposes, narrowed to what admission reads. */
export interface AdmissibleBody {
  message?: string;
  privateHistory?: readonly { content: string }[];
}

/**
 * Applies, in order: body size, JSON validity, schema, then per-field limits.
 *
 * The order is the point. Size is checked before `JSON.parse` so a multi-
 * megabyte body is never parsed, and per-field limits are checked before any
 * idempotency recovery so a request too large to serve is refused identically
 * on every retry rather than being recovered into a stored receipt.
 */
export function admitChatRequest<T extends AdmissibleBody>(
  rawBody: string | null,
  parse: (value: unknown) => { success: true; data: T } | { success: false }
): AdmissionVerdict<T> {
  if (rawBody === null) {
    return { ok: false, status: 400, body: { error: "Invalid input" } };
  }

  const tooLarge = checkBodyBytes(Buffer.byteLength(rawBody, "utf8"));
  if (tooLarge) return rejection(tooLarge);

  let json: unknown = null;
  try {
    json = JSON.parse(rawBody);
  } catch {
    // Left as null: the schema below rejects it, so a malformed body and a
    // schema-invalid body produce the same 400 and the same sentence. That is
    // deliberate — telling a caller which of the two it was describes the
    // parser, not anything they can fix.
    json = null;
  }

  const parsed = parse(json);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: "Invalid input" } };
  }

  const oversized =
    (parsed.data.message !== undefined ? checkMessageSize(parsed.data.message) : null) ??
    (parsed.data.privateHistory ? checkPrivateHistory(parsed.data.privateHistory) : null);
  if (oversized) return rejection(oversized);

  return { ok: true, input: parsed.data };
}

function rejection(violation: RequestLimitViolation): AdmissionVerdict<never> {
  return { ok: false, status: violation.status, body: limitErrorBody(violation) };
}
