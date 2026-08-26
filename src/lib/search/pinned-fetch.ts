import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

import { isDisallowedAddress, isDisallowedHost } from "./url-safety";

/** Keep one agent fetch from buffering an unbounded response on the app host. */
export const MAX_PINNED_FETCH_BYTES = 10 * 1024 * 1024;

/**
 * Fetch one public HTTP(S) URL with the validated DNS answer pinned to the
 * socket. Resolving, validating, and then calling ordinary fetch() is still a
 * DNS-rebinding race because the connection performs a second lookup.
 */
export async function fetchPinnedPublicUrl(
  target: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  if (isDisallowedHost(target)) throw new Error("Blocked non-public URL");

  const parsed = new URL(target);
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials are blocked");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Hostname did not resolve");
  if (addresses.some((answer) => isDisallowedAddress(answer.address))) {
    throw new Error("Hostname resolves to a non-public address");
  }
  const selected = addresses[0];

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: Response) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error("Pinned fetch ended without a response"));
    };
    const onAbort = () => {
      request.destroy();
      finish(new DOMException("The operation was aborted", "AbortError"));
    };

    const headers = new Headers(init.headers);
    headers.set("Accept-Encoding", "identity");
    const options: http.RequestOptions = {
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname || "/"}${parsed.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    };

    const onResponse = (incoming: http.IncomingMessage) => {
      const declared = Number(incoming.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > MAX_PINNED_FETCH_BYTES) {
        incoming.resume();
        request.destroy();
        finish(new Error("Response exceeds Juno's download limit"));
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_PINNED_FETCH_BYTES) {
          request.destroy();
          finish(new Error("Response exceeds Juno's download limit"));
          return;
        }
        chunks.push(buffer);
      });
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value != null) responseHeaders.set(name, String(value));
        }
        finish(null, new Response(Buffer.concat(chunks), {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      });
      incoming.on("error", (error) => finish(error));
    };

    const request = parsed.protocol === "https:"
      ? https.request({ ...options, servername: hostname }, onResponse)
      : http.request(options, onResponse);
    request.on("error", (error) => finish(error));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else request.end();
  });
}
