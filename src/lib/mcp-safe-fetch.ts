import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";

import { pinnedLookup } from "@/lib/search/pinned-fetch";
import { isDisallowedAddress, isDisallowedHost } from "@/lib/search/url-safety";

/*
 * The network path for MCP servers a USER added by URL.
 *
 * A built-in connector talks to a host Juno chose. A custom one talks to
 * whatever was typed into a form, and to whatever that server's metadata
 * then names (its authorization server, registration and token endpoints),
 * all fetched from Juno's own network. Without a guard that is a
 * server-side request forgery primitive: point it at the cloud metadata
 * address or a service on the VM's loopback and read the answer back as an
 * "error message".
 *
 * So every request here:
 *   - is https (http only for loopback, and only with the dev override),
 *   - resolves the hostname once, refuses any private/loopback/link-local
 *     answer, and PINS the socket to that validated address (no second
 *     lookup, so no DNS-rebinding window),
 *   - refuses credentials in the URL,
 *   - follows at most a few redirects, re-validating each hop, and only for
 *     GET/HEAD (a POST that redirects is refused rather than replayed).
 *
 * Unlike the search fetcher it STREAMS: MCP's Streamable HTTP answers tool
 * calls as Server-Sent Events, which the SDK reads incrementally, and it can
 * hold a GET stream open for server notifications. Buffering either would
 * hang the call.
 */

const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Local MCP servers during development (`http://localhost:8787/mcp`). Never
 * honoured in production, whatever the environment says.
 */
function localAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.JUNO_DEV_ALLOW_LOCAL_MCP === "1";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Why a URL can't be used as a custom MCP endpoint, or null when it can. */
export function customMcpUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid URL.";
  }
  if (url.username || url.password) return "Remove the username and password from the URL.";
  if (localAllowed() && isLoopbackHost(url.hostname)) return null;
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (isDisallowedHost(url.href)) return "That address is on a private network Juno can't reach.";
  return null;
}

function bodyOf(body: RequestInit["body"]): Buffer | null {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("Unsupported request body for an MCP request");
}

async function pinnedRequest(target: URL, init: RequestInit, body: Buffer | null): Promise<Response> {
  const local = localAllowed() && isLoopbackHost(target.hostname);
  if (!local) {
    const problem = customMcpUrlProblem(target.href);
    if (problem) throw new Error(`Blocked MCP request: ${problem}`);
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error("The MCP server's hostname did not resolve");
  if (!local && answers.some((answer) => isDisallowedAddress(answer.address))) {
    throw new Error("The MCP server's hostname resolves to a private address");
  }
  const chosen = answers[0];
  const signal = init.signal ?? undefined;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const headers = new Headers(init.headers);
    // Node's client does not decompress; ask for the bytes as they are.
    headers.set("Accept-Encoding", "identity");
    if (body) headers.set("Content-Length", String(body.byteLength));
    const options: http.RequestOptions = {
      hostname,
      port: target.port || undefined,
      path: `${target.pathname || "/"}${target.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(chosen.address, chosen.family),
    };
    const onAbort = () => {
      request.destroy(new DOMException("The operation was aborted", "AbortError"));
    };
    const onResponse = (incoming: http.IncomingMessage) => {
      settled = true;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else if (value != null) responseHeaders.set(name, String(value));
      }
      const status = incoming.statusCode ?? 500;
      const empty = status === 204 || status === 304 || init.method === "HEAD";
      if (empty) incoming.resume();
      incoming.on("close", () => signal?.removeEventListener("abort", onAbort));
      resolve(
        new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        })
      );
    };
    const request = target.protocol === "https:"
      ? https.request({ ...options, servername: hostname }, onResponse)
      : http.request(options, onResponse);
    request.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (!settled) reject(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (body) request.write(body);
    request.end();
  });
}

/**
 * `fetch` for custom MCP servers and their OAuth endpoints. Shape-compatible
 * with the MCP SDK's `FetchLike` and with `McpFetch` in mcp-oauth.
 */
export async function safeMcpFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const body = bodyOf(init.body);
  let target = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  for (let hop = 0; ; hop += 1) {
    const response = await pinnedRequest(target, init, body);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) return response;
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("The MCP server redirected a request Juno won't replay");
    }
    if (hop >= MAX_REDIRECTS) throw new Error("The MCP server redirected too many times");
    target = new URL(location, target);
  }
}
