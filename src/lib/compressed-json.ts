/**
 * JSON responses compressed by the route itself, for the routes that send a
 * conversation's history (GET /api/conversations/[id] and its /messages).
 *
 * Nothing else in the path compresses them. `next start` gzips pages and
 * build output but not what a route handler returns, and production's nginx
 * (deploy/nginx.conf.template, on Ubuntu's stock `gzip` settings) compresses
 * only text/html: a 90-byte JSON body from chat.liams.dev/api/health comes
 * back with no Content-Encoding. So the rest of a 2,000-message conversation
 * (what find reads when it opens) was 2.8 MB on the wire, about 1.1 s of a
 * 20 Mbit/s link before the browser could parse any of it.
 *
 * Brotli at a low quality: on that payload it is smaller than gzip at its
 * default level and about as fast to produce (docs/rework/program/
 * PERFORMANCE.md, "Compressed history"). Quality 11, zlib's default for
 * brotli, takes seconds on a body this size and is never used here.
 *
 * Compression runs on libuv's thread pool, not the event loop. Bodies under
 * 1 KB go as they are, as Next does for its own responses: the encoding would
 * cost more than it saves. A client that does not offer an encoding (a test
 * calling the route directly, curl without --compressed) gets plain JSON.
 *
 * Dependency-free and free of `server-only`, so it is unit tested directly
 * (tests/compressed-json.test.ts).
 */
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Below this a body is sent as it is. */
export const COMPRESS_MIN_BYTES = 1024;
const BROTLI_QUALITY = 5;
const GZIP_LEVEL = 6;

export type JsonEncoding = "br" | "gzip" | null;

/**
 * The encoding to answer with, from an Accept-Encoding header: brotli when
 * offered, then gzip, else none. A coding offered with q=0 is refused, and
 * `*` stands for any coding not named (RFC 9110 §12.5.3).
 */
export function pickJsonEncoding(header: string | null | undefined): JsonEncoding {
  if (!header) return null;
  const offered = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() === "q") {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    offered.set(name, q);
  }
  const accepts = (coding: string) => {
    const q = offered.get(coding) ?? offered.get("*");
    return q !== undefined && q > 0;
  };
  if (accepts("br")) return "br";
  if (accepts("gzip") || accepts("x-gzip")) return "gzip";
  return null;
}

/**
 * `NextResponse.json(body, init)`, compressed for the client that asked.
 * Always varies on Accept-Encoding, so a cache between never hands one
 * client's encoding to another.
 */
export async function compressedJson(req: Pick<Request, "headers">, body: unknown, init: ResponseInit = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");
  const raw = Buffer.from(text, "utf8");
  const encoding = raw.length < COMPRESS_MIN_BYTES ? null : pickJsonEncoding(req.headers.get("accept-encoding"));
  if (!encoding) {
    headers.set("Content-Length", String(raw.length));
    return new Response(new Uint8Array(raw.buffer, raw.byteOffset, raw.length), { ...init, headers });
  }
  const packed = encoding === "br"
    ? await brotli(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
    : await gzipAsync(raw, { level: GZIP_LEVEL });
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(packed.length));
  return new Response(new Uint8Array(packed.buffer, packed.byteOffset, packed.length), { ...init, headers });
}
