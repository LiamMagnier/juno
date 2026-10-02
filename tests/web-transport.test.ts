import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { fetchSafePublicUrl, MAX_SAFE_REDIRECTS } from "@/lib/search/fetch-safe";
import { readBodyBounded } from "@/lib/search/pdf-text";
import { BlockedAddressError, fetchPinnedPublicUrl, ResponseTooLargeError } from "@/lib/search/pinned-fetch";
import { chatFetchBlockReason } from "@/lib/search/url-safety";
import { extractUrlDocument, type ExtractTransport } from "@/lib/web/extract";
import { chatUserAgent, fetchPageForChat } from "@/lib/web/fetch-page";
import { createTurnWebLimits, UserWebCounters } from "@/lib/web/limits";
import { UrlLedger } from "@/lib/web/provenance";
import { TurnTaint } from "@/lib/web/taint";
import { urlGuard } from "@/lib/web/url-guard";

/*
 * The transport under chat's `web_fetch` (SPEC §6.1 steps 5–8, §6.4 items 2
 * and 7): the resolved address pinned to the socket, the chat policy applied
 * to EVERY redirect hop (a link the ledger approved must not bounce to Juno's
 * own origin or to a non-web port), the redirect limit, the web's two ports,
 * and deadlines that follow the caller's signal into the body.
 *
 * The socket tests run against a loopback server. Two test seams on the pinned
 * transport make that possible — a resolver, and the address rule that would
 * otherwise (correctly) refuse 127.0.0.1. Production passes neither.
 */

const OWN = new Set(["chat.juno.example"]);
const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];
const PAGE = `<html><head><title>Loopback</title></head><body><p>${"A readable paragraph of page text. ".repeat(6)}</p></body></html>`;

async function withServer(
  handler: http.RequestListener,
  run: (port: number, requests: http.IncomingMessage[]) => Promise<void>,
): Promise<void> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The pinned transport, pointed at loopback through its two seams. */
function loopbackTransport(maxBytes?: number): ExtractTransport {
  return (url, init, signal) =>
    fetchPinnedPublicUrl(url, init, signal, {
      resolve: async () => LOOPBACK,
      isDisallowedAddress: () => false,
      ...(maxBytes ? { maxBytes } : {}),
    });
}

// ── Pinned DNS ────────────────────────────────────────────────────────────────

test("the validated address is pinned to the socket and the name still goes out as Host", async () => {
  await withServer((_req, res) => res.end("pinned body"), async (port, requests) => {
    const response = await loopbackTransport()(`http://pinned.invalid:${port}/path?q=1`, {}, undefined);
    assert.equal(await response.text(), "pinned body");
    assert.equal(requests[0].headers.host, `pinned.invalid:${port}`);
    assert.equal(requests[0].url, "/path?q=1");
  });
});

test("a name that resolves to a private address is refused before connecting", async () => {
  await withServer((_req, res) => res.end("should not be reached"), async (port, requests) => {
    for (const answers of [LOOPBACK, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }]]) {
      await assert.rejects(
        fetchPinnedPublicUrl(`http://rebind.invalid:${port}/`, {}, undefined, { resolve: async () => answers }),
        BlockedAddressError,
      );
    }
    assert.equal(requests.length, 0);
  });
});

test("the body is a stream: a reader that stops early stops the socket, and the cap holds mid-stream", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      // No content-length: only the running count can enforce the cap.
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 64 && res.write(chunk)) sent += 1;
        if (sent < 64) res.once("drain", pump);
        else res.end();
      };
      pump();
    },
    async (port) => {
      const bounded = await loopbackTransport()(`http://stream.invalid:${port}/`, {}, undefined);
      assert.equal(await readBodyBounded(bounded, 256 * 1024), null, "the bounded reader stops at its own limit");

      const capped = await loopbackTransport(512 * 1024)(`http://stream.invalid:${port}/`, {}, undefined);
      await assert.rejects(capped.arrayBuffer(), ResponseTooLargeError);
    },
  );
});

test("a declared length over the cap is refused before the body is read", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(20 * 1024 * 1024) });
      res.write("x");
    },
    async (port) => {
      await assert.rejects(loopbackTransport(1024 * 1024)(`http://declared.invalid:${port}/`, {}, undefined), ResponseTooLargeError);
    },
  );
});

// ── Deadlines tied to the signal ─────────────────────────────────────────────

test("an abort after the headers ends a trickling body instead of waiting for it", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("."), 50);
      res.on("close", () => clearInterval(timer));
    },
    async (port) => {
      const controller = new AbortController();
      const response = await loopbackTransport()(`http://trickle.invalid:${port}/`, {}, controller.signal);
      const started = performance.now();
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(response.text(), { name: "AbortError" });
      assert.ok(performance.now() - started < 2_000);
    },
  );
});

test("the extractor's own deadline covers the whole chain and reads as `timeout`", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("<p>slow</p>"), 50);
      res.on("close", () => clearInterval(timer));
    },
    async (port) => {
      const started = performance.now();
      const outcome = await extractUrlDocument(`http://slow.invalid:${port}/`, undefined, {
        transport: loopbackTransport(),
        timeoutMs: 200,
      });
      assert.deepEqual(outcome, { ok: false, failure: { reason: "timeout" } });
      assert.ok(performance.now() - started < 2_000);
    },
  );
});

// ── Redirects: the guard on every hop, and the limit ─────────────────────────

test("a real redirect chain is walked hop by hop and reported", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/landing" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      }
    },
    async (port, requests) => {
      const start = `http://hops.invalid:${port}/start`;
      const outcome = await extractUrlDocument(start, undefined, {
        transport: loopbackTransport(),
        userAgent: chatUserAgent("https://chat.juno.example"),
      });
      assert.ok(outcome.ok);
      assert.deepEqual(outcome.page.hops, [start, `http://hops.invalid:${port}/landing`]);
      assert.equal(outcome.page.finalUrl, `http://hops.invalid:${port}/landing`);
      assert.equal(requests[0].headers["user-agent"], "Mozilla/5.0 (compatible; Juno/1.0; +https://chat.juno.example) user-initiated fetch");
    },
  );
});

function redirectTo(location: string): ExtractTransport {
  return async (url) =>
    url === "https://start.example/"
      ? new Response(null, { status: 302, headers: { location } })
      : new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
}

test("fetchSafePublicUrl applies the caller's guard to every hop", async () => {
  for (const location of ["https://chat.juno.example/api/me", "http://public.example:8080/admin", "http://127.0.0.1/"]) {
    const requested: string[] = [];
    const transport: ExtractTransport = async (url, init, signal) => {
      requested.push(url);
      return redirectTo(location)(url, init, signal);
    };
    const result = await fetchSafePublicUrl("https://start.example/", {}, undefined, transport, {
      guard: (url) => urlGuard(url, OWN),
    });
    assert.deepEqual(result, { kind: "blocked" }, location);
    assert.deepEqual(requested, ["https://start.example/"], `${location} was requested`);
  }
  // Research and Work pass no guard: an ordinary cross-host redirect still works.
  const open = await fetchSafePublicUrl("https://start.example/", {}, undefined, redirectTo("http://public.example:8080/"));
  assert.equal(open.kind, "response");
});

function ledgerTurn(urls: string[]) {
  const ledger = new UrlLedger();
  for (const url of urls) ledger.add(url, "search_result");
  return {
    ledger,
    taint: new TurnTaint({ staticContent: false }),
    limits: createTurnWebLimits({ roundBudget: 10, userId: "u", userCounters: new UserWebCounters() }),
    signal: new AbortController().signal,
    private: false,
  };
}

test("web_fetch: a ledger link cannot redirect to Juno's own origin or to :8080", async () => {
  for (const location of ["https://chat.juno.example/api/me", "http://start.example:8080/"]) {
    const ctx = ledgerTurn(["https://start.example/"]);
    const outcome = await fetchPageForChat({ url: "https://start.example/" }, ctx, {
      ownHosts: OWN,
      extract: (url, signal, opts) => extractUrlDocument(url, signal, { ...opts, transport: redirectTo(location) }),
    });
    assert.equal(outcome.error?.code, "url_not_allowed", location);
  }
  // A cross-host redirect to an ordinary public page is allowed and reported.
  const ctx = ledgerTurn(["https://start.example/"]);
  const outcome = await fetchPageForChat({ url: "https://start.example/" }, ctx, {
    ownHosts: OWN,
    extract: (url, signal, opts) => extractUrlDocument(url, signal, { ...opts, transport: redirectTo("https://other.example/page") }),
  });
  assert.equal(outcome.status, "succeeded");
  assert.match(outcome.text, /^URL: https:\/\/other\.example\/page\nRequested: https:\/\/start\.example\/\n/);
  assert.equal(outcome.web?.finalUrl, "https://other.example/page");
  assert.equal(ctx.ledger.match("https://other.example/page")?.kind, "fetched_page", "the landing page joins the ledger");
});

test("web_fetch: too many redirects is `url_not_accessible`, with the reason", async () => {
  let n = 0;
  const loop: ExtractTransport = async () => new Response(null, { status: 302, headers: { location: `https://hop.example/${++n}` } });
  const ctx = ledgerTurn(["https://hop.example/0"]);
  const outcome = await fetchPageForChat({ url: "https://hop.example/0" }, ctx, {
    ownHosts: OWN,
    extract: (url, signal, opts) => extractUrlDocument(url, signal, { ...opts, transport: loop }),
  });
  assert.equal(outcome.error?.code, "url_not_accessible");
  assert.match(outcome.text, /too many redirects/);
  assert.equal(n, MAX_SAFE_REDIRECTS + 1);
});

// ── The web's two ports ───────────────────────────────────────────────────────

test("chat fetches keep to ports 80 and 443 and off Juno's own hosts", () => {
  for (const url of ["http://example.com/", "https://example.com/", "http://example.com:80/", "https://example.com:443/", "http://example.com:443/", "https://example.com:80/"]) {
    assert.equal(chatFetchBlockReason(url, OWN), null, url);
  }
  const refused: Array<[string, string]> = [
    ["http://example.com:8080/", "port"],
    ["https://example.com:22/", "port"],
    ["https://example.com:8443/", "port"],
    ["ftp://example.com/", "scheme"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://10.1.2.3/", "private_address"],
    ["https://[::ffff:127.0.0.1]/", "private_address"],
    ["https://chat.juno.example/", "own_origin"],
    ["https://www.chat.juno.example/", "own_origin"],
    ["https://CHAT.JUNO.EXAMPLE./", "own_origin"],
  ];
  for (const [url, reason] of refused) assert.equal(chatFetchBlockReason(url, OWN), reason, url);
});

test("the transport modules keep server-only out of a test's import graph (harness rule 1)", () => {
  for (const file of ["src/lib/search/pinned-fetch.ts", "src/lib/search/fetch-safe.ts", "src/lib/web/extract.ts", "src/lib/web/url-guard.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import [^;]*from "@\/lib\/(search\/search-engine|web-search|prisma|db)";/m, file);
  }
});
