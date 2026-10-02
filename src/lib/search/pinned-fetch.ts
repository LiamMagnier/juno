import { PRODUCT_NAME } from "@/lib/brand/names";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

import { isDisallowedAddress, isDisallowedHost } from "./url-safety";

/**
 * The most one fetch will stream before it is cut off, unless the caller asks
 * for less. The largest reader behind it — a PDF — stops at 12 MB on its own
 * (`MAX_PDF_BYTES`), and this ceiling used to sit BELOW that at 10 MB, so a
 * 10–12 MB paper died here as a generic fetch failure instead of reaching the
 * reader that would have said "too large" (SPEC §6.1 step 8).
 */
export const MAX_PINNED_FETCH_BYTES = 12 * 1024 * 1024;

/** Refused before connecting: the name resolved to, or was, a non-public address. */
export class BlockedAddressError extends Error {
  constructor(message = "Hostname resolves to a non-public address") {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** The body passed the byte ceiling, by its declared length or while streaming. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Response exceeds ${PRODUCT_NAME}'s download limit`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * A socket `lookup` that answers with the address already validated.
 *
 * It must honour `options.all`. Since Node 20, `net.connect` asks with
 * `{ all: true }` (happy-eyeballs autoSelectFamily) and expects an array; a
 * bare `(address, family)` answer then fails every hostname URL with
 * ERR_INVALID_IP_ADDRESS, which is how every pinned fetch broke on Node 24.
 */
export function pinnedLookup(address: string, family: number): NonNullable<http.RequestOptions["lookup"]> {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as NonNullable<http.RequestOptions["lookup"]>;
}

/**
 * The two seams a test needs to point the real transport at a loopback server:
 * the resolver, and the address rule that would otherwise refuse 127.0.0.1.
 * Production passes neither. `maxBytes` is the only one a caller sets for real.
 */
export interface PinnedFetchOptions {
  /** Byte ceiling on the streamed body; default `MAX_PINNED_FETCH_BYTES`. */
  maxBytes?: number;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  isDisallowedAddress?: (address: string) => boolean;
}

/** Statuses whose response may not carry a body (`new Response` throws on one that does). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** `promise`, or an AbortError as soon as `signal` aborts. The lookup itself cannot be cancelled. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Fetch one public HTTP(S) URL with the validated DNS answer pinned to the
 * socket. Resolving, validating, and then calling ordinary fetch() is still a
 * DNS-rebinding race because the connection performs a second lookup.
 *
 * The response is returned as soon as its headers arrive and its body is a
 * STREAM, capped at `maxBytes`. It used to be buffered whole (up to 10 MB)
 * before any caller saw it, so the bounded readers downstream — 2 MB of chat
 * HTML, 4 MB of research HTML — bounded nothing that mattered: the bytes were
 * already resident. Now a reader that stops early stops the socket too, and
 * `signal` aborts the body as well as the connect: a server trickling one byte
 * a second is cut off at the caller's deadline, not at the end of its body.
 */
export async function fetchPinnedPublicUrl(
  target: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  options: PinnedFetchOptions = {},
): Promise<Response> {
  if (isDisallowedHost(target)) throw new BlockedAddressError("Blocked non-public URL");
  const maxBytes = options.maxBytes ?? MAX_PINNED_FETCH_BYTES;
  const disallowed = options.isDisallowedAddress ?? isDisallowedAddress;

  const parsed = new URL(target);
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials are blocked");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolve ?? ((name: string) => dnsLookup(name, { all: true, verbatim: true }));
  const addresses = await raceAbort(resolve(hostname), signal);
  if (addresses.length === 0) throw new Error("Hostname did not resolve");
  if (addresses.some((answer) => disallowed(answer.address))) throw new BlockedAddressError();
  const selected = addresses[0];

  return await new Promise<Response>((resolvePromise, reject) => {
    let settled = false;
    // Set once the body stream exists, so an abort after the headers errors it.
    let failBody: ((error: Error) => void) | null = null;
    let bodyDone = false;

    const release = () => signal?.removeEventListener("abort", onAbort);
    const finish = (error: Error | null, response?: Response) => {
      if (settled) return;
      settled = true;
      if (error) {
        release();
        reject(error);
      } else if (response) {
        // The listener stays while a body is still streaming.
        if (bodyDone) release();
        resolvePromise(response);
      } else {
        release();
        reject(new Error("Pinned fetch ended without a response"));
      }
    };
    const onAbort = () => {
      request.destroy();
      if (failBody) failBody(abortError());
      finish(abortError());
    };

    const headers = new Headers(init.headers);
    headers.set("Accept-Encoding", "identity");
    const requestOptions: http.RequestOptions = {
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname || "/"}${parsed.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(selected.address, selected.family),
    };

    const onResponse = (incoming: http.IncomingMessage) => {
      const declared = Number(incoming.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        incoming.resume();
        request.destroy();
        finish(new ResponseTooLargeError(maxBytes));
        return;
      }

      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        try {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value != null) responseHeaders.set(name, String(value));
        } catch {
          // A header value `Headers` will not hold (a stray control character)
          // is dropped rather than failing the whole page.
        }
      }
      // `Response` accepts 200–599 only; anything else a server invents is a
      // server error as far as every caller here is concerned.
      const raw = incoming.statusCode ?? 502;
      const status = raw >= 200 && raw <= 599 ? raw : 502;
      const build = (body: ReadableStream<Uint8Array> | null) => {
        try {
          return new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders });
        } catch {
          return new Response(body, { status, headers: responseHeaders });
        }
      };

      if (NULL_BODY_STATUSES.has(status) || requestOptions.method === "HEAD") {
        incoming.resume();
        bodyDone = true;
        finish(null, build(null));
        return;
      }

      let bytes = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const end = (error: Error | null) => {
              if (bodyDone) return;
              bodyDone = true;
              failBody = null;
              release();
              try {
                if (error) controller.error(error);
                else controller.close();
              } catch {
                // Already cancelled by the reader.
              }
            };
            failBody = (error) => end(error);
            incoming.on("data", (chunk: Buffer | string) => {
              if (bodyDone) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > maxBytes) {
                request.destroy();
                end(new ResponseTooLargeError(maxBytes));
                return;
              }
              controller.enqueue(new Uint8Array(buffer));
              // Backpressure: stop reading the socket until the reader catches up.
              if ((controller.desiredSize ?? 1) <= 0) incoming.pause();
            });
            incoming.on("end", () => end(null));
            incoming.on("error", (error) => end(error));
            incoming.on("aborted", () => end(new Error("The connection closed before the body ended")));
          },
          pull() {
            incoming.resume();
          },
          cancel() {
            bodyDone = true;
            failBody = null;
            release();
            request.destroy();
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
      );
      finish(null, build(body));
    };

    const request = parsed.protocol === "https:"
      ? https.request({ ...requestOptions, servername: hostname }, onResponse)
      : http.request(requestOptions, onResponse);
    request.on("error", (error) => {
      if (failBody) failBody(error);
      finish(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else request.end();
  });
}
