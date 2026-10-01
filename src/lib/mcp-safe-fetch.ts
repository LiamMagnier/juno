import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { pinnedLookup } from "@/lib/search/pinned-fetch";
import { isDisallowedAddress, isDisallowedHost, isLoopbackAddress } from "@/lib/search/url-safety";

/*
 * The network path for MCP servers a USER added by URL.
 *
 * A built-in connector talks to a host Juno chose. A user MCP server talks to
 * whatever was typed into a form, from Juno's own network. Without a guard
 * that is a server-side request forgery primitive: point it at the cloud
 * metadata address or a service on the VM's loopback and read the answer back
 * as an "error message". It was one, shipped: the probe and the chat
 * transport both used the SDK's plain `fetch`, and `http://localhost` was
 * accepted in production.
 *
 * So every request here, including every redirect hop:
 *   - passes `userMcpUrlProblem`: https only, no credentials in the URL, no
 *     private, loopback, link-local or metadata host (http://localhost only
 *     when NODE_ENV says development or test);
 *   - resolves the hostname once, refuses any private answer (any answer at
 *     all but loopback for a development localhost), and PINS the socket to
 *     that validated address, so there is no second lookup and no
 *     DNS-rebinding window;
 *   - follows at most MAX_MCP_REDIRECTS redirects, and only for GET/HEAD (a
 *     POST that redirects is refused rather than replayed);
 *   - drops Authorization and every other header that is not on a short
 *     protocol allowlist the moment a redirect leaves the origin (scheme, host
 *     or port) it was sent to. A server that answers 302 to somewhere else
 *     must not receive the person's credential by doing so.
 *
 * Unlike the search fetcher it STREAMS: MCP's Streamable HTTP answers tool
 * calls as Server-Sent Events, which the SDK reads incrementally, and it can
 * hold a GET stream open for server notifications. Buffering either would
 * hang the call. It still caps what one response may deliver.
 *
 * Not `server-only`, like pinned-fetch.ts, so its rules can be exercised by
 * `tsx --test`; it imports node:http and can never reach a client bundle.
 */

export const MAX_MCP_REDIRECTS = 3;

/** One response's ceiling. A tool result reaches the model cut to 30k characters anyway. */
export const MAX_MCP_RESPONSE_BYTES = 32 * 1024 * 1024;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Statuses whose response may not carry a body (`new Response` throws on one that does). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * The headers that may follow a redirect to another origin: the ones MCP's
 * transport needs to be understood, and nothing that identifies the person.
 * An allowlist rather than "drop Authorization", so a credential a person
 * pastes under some other name, a cookie, or the MCP session id stays with
 * the origin it was issued for too.
 */
const CROSS_ORIGIN_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "user-agent",
]);

/*
 * Pools of their own. An agent keys kept-alive sockets by host and port, not
 * by the address they were opened to, so a shared pool could hand a validated
 * request a socket some other, unguarded caller in this process opened to the
 * same name. Every socket in these was opened to an address this module
 * validated.
 */
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const PRIVATE_NETWORK = "That address is on a private network Juno can't reach.";
const REDIRECT_REFUSED = "The server redirected Juno to an address it won't follow.";

/**
 * Refused by policy before anything was sent. The message is Juno's own
 * sentence, written for the person, and is the only error text from this
 * module that is safe to show verbatim.
 */
export class McpRequestBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestBlockedError";
  }
}

/**
 * Whether the development-only loopback exception is open. Read per call, so a
 * test cannot cache the answer.
 *
 * It fails closed: only an explicit `development` or `test` opens it. Keyed on
 * "not production", a worker started by hand without NODE_ENV (the trigger
 * poller run over SSH, say) would dial a saved `http://localhost` row on the
 * VM itself. `next dev` and `next start` set NODE_ENV and PM2 sets it for
 * every worker, so nothing that runs the normal way changes.
 */
function allowsLocalDevelopment(): boolean {
  const mode = process.env.NODE_ENV;
  return mode === "development" || mode === "test";
}

/** `localhost`, `127.0.0.1` or `::1`, in any of the spellings `URL` reports. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Why a URL can't be used as a user MCP endpoint, or null when it can.
 *
 * https only. The Authorization header is a live credential, and a remote
 * http host would receive it in cleartext. The one exception is loopback in
 * development and test, so local development can point at
 * `http://localhost:3001/mcp`; anywhere else loopback is the VM itself, whose
 * services (the app, the relay, PM2's) are exactly what must not be reachable.
 * The host is judged lexically here; `safeMcpFetch` judges what it resolves to.
 */
export function userMcpUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an https:// address.";
  if (url.username || url.password) return "Remove the username and password from the URL.";
  if (isLoopbackHostname(url.hostname)) {
    return allowsLocalDevelopment()
      ? null
      : "Juno can't connect to servers on its own machine. Use the server's public https:// address.";
  }
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (isDisallowedHost(url.href)) return PRIVATE_NETWORK;
  return null;
}

export const customMcpUrlProblem = userMcpUrlProblem;

type Resolve = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolve: Resolve = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

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
      }
    );
  });
}

/**
 * Resolve once and return the one answer the socket will be pinned to.
 *
 * EVERY answer is judged, not only the one used: a name that returns a public
 * and a private address is a name built to rebind. A development localhost
 * must resolve to loopback and nothing else, so a hosts-file entry or a
 * hostile resolver cannot turn "localhost" into the rest of the network.
 */
async function resolvePinned(
  target: URL,
  resolve: Resolve,
  signal: AbortSignal | undefined,
  refusal: string
): Promise<{ address: string; family: number }> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const answers = await raceAbort(resolve(hostname), signal);
  if (answers.length === 0) {
    throw Object.assign(new Error("The MCP server's hostname did not resolve"), { code: "ENOTFOUND" });
  }
  const local = allowsLocalDevelopment() && isLoopbackHostname(target.hostname);
  const refused = local
    ? answers.some((answer) => !isLoopbackAddress(answer.address))
    : answers.some((answer) => isDisallowedAddress(answer.address));
  if (refused) throw new McpRequestBlockedError(refusal);
  return answers[0];
}

function bodyOf(body: RequestInit["body"]): Buffer | null {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("Unsupported request body for an MCP request");
}

/** The subset of `headers` that may go to a different origin. */
function crossOriginHeaders(headers: Headers): Headers {
  const kept = new Headers();
  headers.forEach((value, name) => {
    if (CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) kept.set(name, value);
  });
  return kept;
}

/** One request to one validated address, answered as a streaming `Response`. */
function pinnedRequest(
  target: URL,
  method: string,
  headers: Headers,
  body: Buffer | null,
  pin: { address: string; family: number },
  signal: AbortSignal | undefined
): Promise<Response> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    // Set while a body is streaming, so an abort or a socket error after the
    // headers ends the stream instead of leaving the SDK's reader hanging.
    let endBody: ((error: Error | null) => void) | null = null;

    const release = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (endBody) endBody(error);
      if (settled) return;
      settled = true;
      release();
      reject(error);
    };
    const onAbort = () => {
      request.destroy();
      fail(abortError());
    };

    const sent = new Headers(headers);
    // Node's client does not decompress; ask for the bytes as they are.
    sent.set("accept-encoding", "identity");
    if (body) sent.set("content-length", String(body.byteLength));
    const options: http.RequestOptions = {
      hostname,
      port: target.port || undefined,
      path: `${target.pathname || "/"}${target.search}`,
      method,
      headers: Object.fromEntries(sent.entries()),
      lookup: pinnedLookup(pin.address, pin.family),
    };

    const onResponse = (incoming: http.IncomingMessage) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        try {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value != null) responseHeaders.set(name, String(value));
        } catch {
          // A value `Headers` will not hold is dropped rather than failing the call.
        }
      }
      // `Response` accepts 200–599 only; anything else is a server error here.
      const raw = incoming.statusCode ?? 502;
      const status = raw >= 200 && raw <= 599 ? raw : 502;
      const build = (stream: ReadableStream<Uint8Array> | null) => new Response(stream, { status, headers: responseHeaders });

      if (NULL_BODY_STATUSES.has(status) || method === "HEAD") {
        incoming.resume();
        settled = true;
        release();
        resolve(build(null));
        return;
      }

      let bytes = 0;
      let done = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            endBody = (error) => {
              if (done) return;
              done = true;
              endBody = null;
              release();
              try {
                if (error) controller.error(error);
                else controller.close();
              } catch {
                // Already cancelled by the reader.
              }
            };
            incoming.on("data", (chunk: Buffer | string) => {
              if (done) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > MAX_MCP_RESPONSE_BYTES) {
                request.destroy();
                endBody?.(new Error("The MCP server's response was too large"));
                return;
              }
              controller.enqueue(new Uint8Array(buffer));
              // Backpressure: stop reading the socket until the reader catches up.
              if ((controller.desiredSize ?? 1) <= 0) incoming.pause();
            });
            incoming.on("end", () => endBody?.(null));
            incoming.on("error", (error) => endBody?.(error));
            incoming.on("close", () => {
              endBody?.(incoming.complete ? null : new Error("The connection closed before the response ended"));
            });
          },
          pull() {
            incoming.resume();
          },
          cancel() {
            done = true;
            endBody = null;
            release();
            request.destroy();
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 })
      );
      settled = true;
      resolve(build(stream));
    };

    const request =
      target.protocol === "https:"
        ? // SNI carries a name, never an address literal (RFC 6066).
          https.request({ ...options, agent: httpsAgent, servername: isIP(hostname) ? undefined : hostname }, onResponse)
        : http.request({ ...options, agent: httpAgent }, onResponse);
    request.on("error", fail);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (body) request.write(body);
    request.end();
  });
}

export interface SafeMcpFetchOptions {
  /** Test seam for the resolver. Production uses the system resolver. */
  resolve?: Resolve;
}

/**
 * `fetch` for user MCP servers, shape-compatible with the MCP SDK's
 * `FetchLike`. `createSafeMcpFetch` exists for the resolver seam; every
 * production caller uses `safeMcpFetch`.
 */
export function createSafeMcpFetch(options: SafeMcpFetchOptions = {}): FetchLike {
  const resolve = options.resolve ?? systemResolve;
  return async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = bodyOf(init.body);
    const signal = init.signal ?? undefined;
    const origin = new URL(input instanceof URL ? input.href : input);
    let target = origin;
    let headers = new Headers(init.headers);
    for (let hop = 0; ; hop += 1) {
      const problem = userMcpUrlProblem(target.href);
      if (problem) throw new McpRequestBlockedError(hop === 0 ? problem : REDIRECT_REFUSED);
      // A development localhost may redirect within loopback; nothing else may
      // redirect onto it.
      if (hop > 0 && isLoopbackHostname(target.hostname) && !isLoopbackHostname(origin.hostname)) {
        throw new McpRequestBlockedError(REDIRECT_REFUSED);
      }
      const pin = await resolvePinned(target, resolve, signal, hop === 0 ? PRIVATE_NETWORK : REDIRECT_REFUSED);
      const response = await pinnedRequest(target, method, headers, body, pin, signal);
      if (!REDIRECTS.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      if (method !== "GET" && method !== "HEAD") throw new McpRequestBlockedError(REDIRECT_REFUSED);
      if (hop >= MAX_MCP_REDIRECTS) throw new McpRequestBlockedError("The server redirected Juno too many times.");
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new McpRequestBlockedError(REDIRECT_REFUSED);
      }
      // Once stripped, never restored: a hop back to the first origin does not
      // earn the credential back, because the server that sent it there is not
      // the one it was given to.
      if (next.origin !== target.origin) headers = crossOriginHeaders(headers);
      target = next;
    }
  };
}

export const safeMcpFetch: FetchLike = createSafeMcpFetch();
