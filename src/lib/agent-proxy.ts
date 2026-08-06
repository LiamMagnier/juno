/**
 * Provider requests are usually small JSON bodies, but Code can also carry
 * image content. Keep a generous ceiling without allowing an authenticated
 * client to make the Next.js process buffer an arbitrary request in memory.
 */
export const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;

export type LimitedBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: "too_large" | "unreadable" };

/** Read a request body with a hard byte limit, including streamed bodies whose
 * Content-Length header is absent or deliberately inaccurate. */
export async function readLimitedRequestBody(
  req: Request,
  maxBytes = MAX_AGENT_BODY_BYTES,
): Promise<LimitedBodyResult> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!req.body) return { ok: true, body: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("agent request body too large").catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(bytes) };
}

export interface UpstreamAbort {
  signal: AbortSignal;
  /** Clear the timer when the upstream request has finished. */
  cancel(): void;
}

/**
 * Bound an upstream provider call by both the user's request lifetime and a
 * server-side ceiling. Without this, a provider that accepts a request but
 * never produces headers can pin a Next.js worker indefinitely.
 */
export function createUpstreamAbort(
  parent: AbortSignal,
  timeoutMs: number,
): UpstreamAbort {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    onParentAbort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort("upstream_timeout"), timeoutMs);
  let cancelled = false;
  return {
    signal: controller.signal,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

export function isUpstreamTimeout(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === "upstream_timeout";
}
