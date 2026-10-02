import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import Module, { createRequire } from "node:module";
import { after, afterEach, test } from "node:test";

import {
  MAX_MCP_REDIRECTS,
  McpRequestBlockedError,
  createSafeMcpFetch,
  safeMcpFetch,
  userMcpUrlProblem,
} from "@/lib/mcp-safe-fetch";
import { isDisallowedAddress } from "@/lib/search/url-safety";

/*
 * User-added MCP servers were a server-side request forgery primitive: the URL
 * check looked at the scheme only and let `http://localhost` through in
 * production, the probe and the chat transport dialled with plain fetch (no
 * private-address refusal, no DNS pinning, no redirect re-validation), and the
 * Test button echoed up to 240 characters of whatever answered. These tests
 * hold every one of those shut, against real sockets on loopback where the
 * behaviour is about sockets.
 */

// mcp-probe.ts and user-mcp.ts are `server-only`; the probe and the policy are
// exercised for real, so the marker is stubbed rather than the modules pinned
// as text.
const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
// The real module object (a namespace import would be a copy), so patching
// `lookup` below sees what `net.connect` would call.
const dns = req("node:dns") as typeof import("node:dns");
const { probeMcpEndpoint, describeProbeFailure } = req("../src/lib/mcp-probe") as typeof import("@/lib/mcp-probe");
const { isAllowedMcpUrl } = req("../src/lib/user-mcp") as typeof import("@/lib/user-mcp");

const src = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// Next declares NODE_ENV read-only on ProcessEnv; the policy reads it per call.
const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;
function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}
afterEach(() => setNodeEnv(originalNodeEnv));

// ---------------------------------------------------------------------------
// Fixtures: tiny HTTP servers on 127.0.0.1
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A minimal Streamable HTTP MCP server: JSON answers, no SSE stream. */
function mcpHandler(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

/** Resolves every name to loopback, and counts the calls. */
function loopbackResolver() {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    return [{ address: "127.0.0.1", family: 4 }];
  };
  return { calls, resolve };
}

// ---------------------------------------------------------------------------
// The URL policy (isAllowedMcpUrl / userMcpUrlProblem)
// ---------------------------------------------------------------------------

test("isAllowedMcpUrl: https to a public host, nothing private, no credentials", () => {
  setNodeEnv("production");
  assert.equal(isAllowedMcpUrl("https://mcp.example.com/mcp"), true);
  for (const url of [
    "http://mcp.example.com/mcp", // cleartext credential
    "ftp://mcp.example.com/",
    "not a url",
    "https://user:pw@mcp.example.com/mcp",
    "https://10.0.0.8/mcp",
    "https://192.168.1.10/mcp",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://svc.internal/mcp",
    "https://printer.local/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[::ffff:a9fe:a9fe]/mcp",
    "https://[fd00:ec2::254]/mcp",
    "https://[64:ff9b::7f00:1]/mcp",
    "https://0.0.0.7/mcp",
    "https://2130706433/mcp", // 127.0.0.1 as an integer
  ]) {
    assert.equal(isAllowedMcpUrl(url), false, url);
    assert.notEqual(userMcpUrlProblem(url), null, url);
  }
});

test("isAllowedMcpUrl: localhost is refused in production, over http and https", () => {
  setNodeEnv("production");
  for (const url of [
    "http://localhost:3001/mcp",
    "https://localhost/mcp",
    "http://127.0.0.1:3000/api",
    "http://[::1]:8080/mcp",
    "http://LOCALHOST./mcp",
  ]) {
    assert.equal(isAllowedMcpUrl(url), false, url);
    assert.match(userMcpUrlProblem(url) ?? "", /own machine/, url);
  }
});

test("isAllowedMcpUrl: in development and test, localhost may use http for local development", () => {
  for (const nodeEnv of ["development", "test"]) {
    setNodeEnv(nodeEnv);
    assert.equal(isAllowedMcpUrl("http://localhost:3001/mcp"), true, String(nodeEnv));
    assert.equal(isAllowedMcpUrl("http://127.0.0.1:3001/mcp"), true, String(nodeEnv));
    assert.equal(isAllowedMcpUrl("http://[::1]:3001/mcp"), true, String(nodeEnv));
    // …and only loopback: the rest of the private network is refused everywhere.
    assert.equal(isAllowedMcpUrl("http://10.0.0.8/mcp"), false, String(nodeEnv));
    assert.equal(isAllowedMcpUrl("https://10.0.0.8/mcp"), false, String(nodeEnv));
    assert.equal(isAllowedMcpUrl("http://127.0.0.2/mcp"), false, String(nodeEnv));
  }
});

test("the localhost exception fails closed: no NODE_ENV, or any value but development/test, is production", async () => {
  // Keyed on "not production", a worker started by hand without NODE_ENV
  // would have dialled a saved http://localhost row on the VM itself.
  const { port, seen } = await serve(mcpHandler);
  for (const nodeEnv of [undefined, "", "staging", "Production", "prod"]) {
    setNodeEnv(nodeEnv);
    for (const url of ["http://localhost:3001/mcp", "http://127.0.0.1:3001/mcp", "https://[::1]/mcp"]) {
      assert.equal(isAllowedMcpUrl(url), false, `${String(nodeEnv)} ${url}`);
      assert.match(userMcpUrlProblem(url) ?? "", /own machine/, `${String(nodeEnv)} ${url}`);
    }
    await assert.rejects(
      safeMcpFetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" }),
      McpRequestBlockedError,
      String(nodeEnv)
    );
    // A name that is not lexically loopback but answers loopback is judged as
    // private, not waved through as "local development".
    const fetcher = createSafeMcpFetch({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await assert.rejects(fetcher(`https://mcp.example.com:${port}/mcp`), McpRequestBlockedError, String(nodeEnv));
  }
  assert.equal(seen.length, 0);
});

test("every spelling of loopback and metadata is refused in production, however the URL is written", () => {
  setNodeEnv("production");
  for (const url of [
    // Integer, octal, hex, short and mixed IPv4 forms (URL rewrites them all to a quad).
    "https://2130706433/mcp",
    "https://017700000001/mcp",
    "https://0x7f000001/mcp",
    "https://0x7f.1/mcp",
    "https://0177.0.0.1/mcp",
    "https://127.1/mcp",
    "https://0/mcp",
    "https://0251.0376.0251.0376/latest/meta-data/",
    "https://0xa9.0xfe.0xa9.0xfe/latest/meta-data/",
    // Trailing dots, case, percent-encoding and full-width forms of the same names.
    "https://127.0.0.1./mcp",
    "https://169.254.169.254./latest/meta-data/",
    "https://LOCALHOST./mcp",
    "https://localhost../mcp",
    "https://%6c%6f%63%61%6c%68%6f%73%74/mcp",
    "https://%31%32%37.0.0.1/mcp",
    "https://127。0。0。1/mcp",
    "https://metadata./computeMetadata/v1/",
    // Every IPv6 road back to an IPv4 loopback or metadata address.
    "https://[::1]/mcp",
    "https://[0:0:0:0:0:0:0:1]/mcp",
    "https://[::]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[0:0:0:0:0:ffff:7f00:1]/mcp",
    "https://[::ffff:169.254.169.254]/mcp",
    "https://[::127.0.0.1]/mcp",
    "https://[::ffff:0:7f00:1]/mcp", // SIIT IPv4-translated: one hextet off from mapped
    "https://[::ffff:0:a9fe:a9fe]/mcp",
    "https://[64:ff9b::a9fe:a9fe]/mcp",
    "https://[2002:7f00:1::]/mcp",
    // Credentials in the URL, in either position.
    "https://evil@127.0.0.1/mcp",
    "https://127.0.0.1@evil.example/mcp",
    "https://user:pw@mcp.example.com/mcp",
  ]) {
    assert.notEqual(userMcpUrlProblem(url), null, url);
  }
  // The parser that judged the URL is the parser that dials it: a backslash or
  // a fragment cannot make the check read one host and the socket another.
  assert.equal(new URL("https://mcp.example.com\\@127.0.0.1/").hostname, "mcp.example.com");
  assert.equal(new URL("https://mcp.example.com#@127.0.0.1/").hostname, "mcp.example.com");
});

test("the rest of ::/8, IPv4-translated included, is refused as a DNS answer too", async () => {
  setNodeEnv("production");
  for (const address of ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "::ffff:0:0:1", "0:0:0:1::1", "ff::1", "::1:0:0:1"]) {
    assert.equal(isDisallowedAddress(address), true, address);
    const fetcher = createSafeMcpFetch({ resolve: async () => [{ address, family: 6 }] });
    await assert.rejects(
      fetcher("https://mcp.example.com/mcp", { method: "POST", body: "{}" }),
      (err: unknown) => err instanceof McpRequestBlockedError && /private network/.test(err.message),
      address
    );
  }
  // Mapped is judged by the address it carries, before the ::/8 rule: a
  // public one is still an ordinary route.
  assert.equal(isDisallowedAddress("::ffff:8.8.8.8"), false);
  assert.equal(isDisallowedAddress("::ffff:808:808"), false);
});

// ---------------------------------------------------------------------------
// The fetcher: resolution, pinning, rebinding
// ---------------------------------------------------------------------------

test("a hostname that resolves to a private or metadata address is refused before connecting", async () => {
  setNodeEnv("production");
  for (const answers of [
    ["10.0.0.9"],
    ["169.254.169.254"],
    ["fd00:ec2::254"],
    ["::ffff:127.0.0.1"],
    ["168.63.129.16"],
    // The rebinding shape: one public answer to pass a naive check, one private.
    ["93.184.216.34", "127.0.0.1"],
  ]) {
    const fetcher = createSafeMcpFetch({
      resolve: async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    });
    await assert.rejects(
      fetcher("https://mcp.example.com/mcp", { method: "POST", body: "{}" }),
      (err: unknown) => err instanceof McpRequestBlockedError && /private network/.test(err.message),
      answers.join(",")
    );
  }
});

test("a development localhost must resolve to loopback and nothing else", async () => {
  setNodeEnv("development");
  const fetcher = createSafeMcpFetch({ resolve: async () => [{ address: "10.0.0.9", family: 4 }] });
  await assert.rejects(fetcher("http://localhost:3001/mcp"), McpRequestBlockedError);
});

test("the socket connects to the validated answer: no second lookup, so no rebinding window", async () => {
  setNodeEnv("development");
  const { port, seen } = await serve((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("pinned"));
  // Answer loopback once, then rebind to a private address. A transport that
  // resolved again at connect time would be steered by the second answer.
  const calls: string[] = [];
  const fetcher = createSafeMcpFetch({
    resolve: async (hostname) => {
      calls.push(hostname);
      return [{ address: calls.length === 1 ? "127.0.0.1" : "10.0.0.9", family: 4 }];
    },
  });
  const socketLookups: string[] = [];
  const realLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = (hostname: string, ...rest: unknown[]) => {
    socketLookups.push(hostname);
    return (realLookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  };
  try {
    const response = await fetcher(`http://localhost:${port}/mcp`);
    assert.equal(await response.text(), "pinned");
  } finally {
    (dns as { lookup: unknown }).lookup = realLookup;
  }
  assert.deepEqual(calls, ["localhost"], "resolved exactly once, by the validator");
  assert.deepEqual(socketLookups, [], "the socket never looked the name up itself");
  assert.equal(seen.length, 1);
  // The next request resolves afresh and is judged afresh: the rebound answer is refused.
  await assert.rejects(fetcher(`http://localhost:${port}/mcp`), McpRequestBlockedError);
  assert.equal(seen.length, 1);
});

test("localhost is refused in production before any request leaves", async () => {
  const { port, seen } = await serve(mcpHandler);
  setNodeEnv("production");
  await assert.rejects(
    safeMcpFetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" }),
    (err: unknown) => err instanceof McpRequestBlockedError && /own machine/.test(err.message)
  );
  await assert.rejects(safeMcpFetch(`http://localhost:${port}/mcp`), McpRequestBlockedError);
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------------------
// The fetcher: redirects
// ---------------------------------------------------------------------------

test("a redirect to a private host is refused, whether the name or its answer is private", async () => {
  setNodeEnv("development");
  for (const location of [
    "https://10.0.0.1/mcp",
    "http://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://[::ffff:10.0.0.1]/mcp",
    "https://rebind.example/mcp", // resolves to metadata below
    "http://public.example/mcp", // not https
    "file:///etc/passwd",
  ]) {
    const { port, seen } = await serve((_req, res) => res.writeHead(302, { location }).end());
    const fetcher = createSafeMcpFetch({
      resolve: async (hostname) =>
        hostname === "rebind.example" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
    });
    await assert.rejects(
      fetcher(`http://127.0.0.1:${port}/mcp`),
      (err: unknown) => err instanceof McpRequestBlockedError && /redirected/.test(err.message),
      location
    );
    assert.equal(seen.length, 1, location);
  }
});

test("a cross-origin redirect drops Authorization and every other credential-bearing header", async () => {
  setNodeEnv("development");
  const landing = await serve((_req, res) => res.writeHead(200).end("landed"));
  const start = await serve((_req, res) => res.writeHead(302, { location: `http://localhost:${landing.port}/landing` }).end());
  const { resolve } = loopbackResolver();
  const fetcher = createSafeMcpFetch({ resolve });
  const response = await fetcher(`http://127.0.0.1:${start.port}/mcp`, {
    headers: {
      Authorization: "Bearer person-secret",
      "X-Api-Key": "also-secret",
      Cookie: "session=secret",
      "Mcp-Session-Id": "session-123",
      Accept: "text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
    },
  });
  assert.equal(await response.text(), "landed");
  assert.equal(start.seen[0].headers.authorization, "Bearer person-secret", "the origin it was meant for still gets it");
  const hop = landing.seen[0].headers;
  assert.equal(hop.authorization, undefined);
  assert.equal(hop["x-api-key"], undefined);
  assert.equal(hop.cookie, undefined);
  assert.equal(hop["mcp-session-id"], undefined);
  assert.equal(hop.accept, "text/event-stream", "protocol headers survive");
  assert.equal(hop["mcp-protocol-version"], "2025-06-18");
});

test("a port change is a different origin too; a same-origin redirect keeps the credential", async () => {
  setNodeEnv("development");
  const other = await serve((_req, res) => res.writeHead(200).end("other port"));
  const same = await serve((req, res) => {
    if (req.url === "/start") res.writeHead(307, { location: "/next" }).end();
    else if (req.url === "/next") res.writeHead(302, { location: `http://127.0.0.1:${other.port}/x` }).end();
    else res.writeHead(404).end();
  });
  const response = await safeMcpFetch(`http://127.0.0.1:${same.port}/start`, {
    headers: { Authorization: "Bearer person-secret" },
  });
  assert.equal(await response.text(), "other port");
  assert.deepEqual(
    same.seen.map((entry) => [entry.url, entry.headers.authorization]),
    [
      ["/start", "Bearer person-secret"],
      ["/next", "Bearer person-secret"],
    ]
  );
  assert.equal(other.seen[0].headers.authorization, undefined);
});

test("a POST that redirects is refused rather than replayed anywhere", async () => {
  setNodeEnv("development");
  const target = await serve((_req, res) => res.writeHead(200).end());
  const start = await serve((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${target.port}/mcp` }).end());
  await assert.rejects(
    safeMcpFetch(`http://127.0.0.1:${start.port}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer person-secret" },
    }),
    McpRequestBlockedError
  );
  assert.equal(target.seen.length, 0);
});

test("redirects are capped", async () => {
  setNodeEnv("development");
  const loop = await serve((req, res) => res.writeHead(302, { location: `${req.url}x` }).end());
  await assert.rejects(
    safeMcpFetch(`http://127.0.0.1:${loop.port}/r`),
    (err: unknown) => err instanceof McpRequestBlockedError && /too many/.test(err.message)
  );
  assert.equal(loop.seen.length, MAX_MCP_REDIRECTS + 1);
});

// ---------------------------------------------------------------------------
// The probe: fetcher, deadline, and what the person is told
// ---------------------------------------------------------------------------

test("the probe connects and lists tools through the safe fetcher", async () => {
  setNodeEnv("development");
  const { port, seen } = await serve(mcpHandler);
  const result = await probeMcpEndpoint({
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: "Bearer person-secret" },
  });
  assert.deepEqual(result, { ok: true, toolNames: ["echo"], toolCount: 1, accountLabel: "fixture" });
  assert.ok(seen.every((entry) => entry.headers.authorization === "Bearer person-secret"));
});

test("the probe refuses localhost in production and says why, without sending anything", async () => {
  const { port, seen } = await serve(mcpHandler);
  setNodeEnv("production");
  const result = await probeMcpEndpoint({ url: `http://127.0.0.1:${port}/mcp` });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /own machine/);
  assert.equal(seen.length, 0);
});

test("the probe's deadline is wired: a server that never answers is cut off", async () => {
  setNodeEnv("development");
  const { port } = await serve(() => {
    // Accept the request and never answer.
  });
  const startedAt = Date.now();
  const result = await probeMcpEndpoint({ url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 1_000 });
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(result, { ok: false, error: "The server didn't answer within 1 second." });
  assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
});

test("the probe never echoes what the upstream said", async () => {
  setNodeEnv("development");
  const secret = "root:x:0:0 internal-service-banner hunter2";
  for (const [status, expected] of [
    [500, "The server had a problem (HTTP 500). Try again later."],
    [401, "The server turned down Alevr's credentials. Check the Authorization header."],
    [404, "Nothing at that address answered as an MCP server. Check the URL, which usually ends in /mcp."],
    [418, "The server refused the connection (HTTP 418)."],
  ] as const) {
    const { port } = await serve((_req, res) => res.writeHead(status, { "content-type": "text/plain" }).end(secret));
    const result = await probeMcpEndpoint({ url: `http://127.0.0.1:${port}/mcp` });
    assert.deepEqual(result, { ok: false, error: expected }, String(status));
  }
  const html = await serve((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<p>${secret}</p>`));
  const result = await probeMcpEndpoint({ url: `http://127.0.0.1:${html.port}/mcp` });
  assert.deepEqual(result, { ok: false, error: "That address answered, but not as an MCP server." });
});

test("probe failures map to fixed sentences, and only Juno's own refusals pass their text through", () => {
  const upstream = new Error("Error POSTing to endpoint: SECRET BODY");
  assert.equal(describeProbeFailure(upstream, false), "Alevr couldn't connect to that server.");
  assert.equal(
    describeProbeFailure(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }), false),
    "Alevr couldn't find that server. Check the address."
  );
  assert.equal(
    describeProbeFailure(Object.assign(new Error("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), false),
    "The server's security certificate couldn't be verified."
  );
  assert.equal(describeProbeFailure(new Error("whatever"), true), "The server didn't answer within 15 seconds.");
  assert.equal(describeProbeFailure(new McpRequestBlockedError("Juno's sentence."), false), "Juno's sentence.");
});

// ---------------------------------------------------------------------------
// Wiring the tests above cannot reach (server-only modules with a database)
// ---------------------------------------------------------------------------

test("every user MCP request path uses the safe fetcher and re-checks the stored URL", () => {
  const mcp = src("src/lib/mcp.ts");
  // The chat/Work/agent transport: user servers and custom connectors (both a
  // URL typed into a form) get the safe fetcher, decided by the id rather than
  // by an optional field a caller rebuilding ActiveConnector can drop (the Work
  // runner does), and a URL that fails today's rules is not dialled even if it
  // was saved earlier.
  assert.match(
    mcp,
    /const userServer = isUserMcpConnectorId\(c\.id\) \|\| isCustomConnectorId\(c\.id\);\n\s*if \(userServer && userMcpUrlProblem\(c\.mcpUrl\)\) return;/
  );
  assert.match(mcp, /\.\.\.\(userServer \? \{ fetch: safeMcpFetch \} : \{\}\)/);
  assert.doesNotMatch(mcp, /c\.custom \? \{ fetch/, "the fetcher is not chosen by the optional `custom` field");
  assert.match(mcp, /if \(userMcpUrlProblem\(server\.url\)\) continue;/);
  assert.match(mcp, /if \(userMcpUrlProblem\(connector\.url\)\) continue;/, "a saved custom connector URL is re-judged too");
  // The Work runner rebuilds each connector from parts; it carries a custom
  // connector's switched-off tools so a run never offers them.
  const runner = src("scripts/work-runner.ts");
  assert.match(runner, /\.\.\.\(endpoint\.custom \? \{ custom: endpoint\.custom \} : \{\}\)/);
  assert.match(runner, /\.\.\.\(entry\.custom \? \{ custom: entry\.custom \} : \{\}\)/);
  // …and a sealed header that no longer opens is not dialled anonymously.
  assert.match(mcp, /if \(server\.authHeader && !authHeader\) continue;/);
  // Exactly one transport in mcp.ts, so there is no second, unguarded one.
  assert.equal(mcp.match(/new StreamableHTTPClientTransport\(/g)?.length, 1);
  assert.doesNotMatch(mcp, /SSEClientTransport/);

  // The probe (draft test, saved test, create and PATCH all call it).
  const userMcp = src("src/lib/user-mcp.ts");
  assert.match(userMcp, /probeMcpEndpoint\(\{ url, headers: headersForServer\(input\.authHeader\), fetch: safeMcpFetch \}\)/);
  assert.match(src("src/lib/mcp-probe.ts"), /const baseFetch = input\.fetch \?\? safeMcpFetch;/);
  for (const route of ["src/app/api/mcp/servers/route.ts", "src/app/api/mcp/servers/[id]/route.ts"]) {
    assert.match(src(route), /userMcpUrlProblem\(/, route);
  }
});

test("every route that probes a URL is metered; PATCH is not a way around /test's limit", () => {
  // Draft test, saved test and a re-pointing PATCH share one budget; create has its own.
  for (const route of ["src/app/api/mcp/servers/test/route.ts", "src/app/api/mcp/servers/[id]/test/route.ts"]) {
    assert.match(src(route), /rateLimit\(\{ key: `user-mcp:test(?:-draft)?:\$\{user\.id\}`/, route);
  }
  assert.match(src("src/app/api/mcp/servers/route.ts"), /rateLimit\(\{ key: `user-mcp:create:\$\{user\.id\}`/);
  const patch = src("src/app/api/mcp/servers/[id]/route.ts");
  const metered = patch.indexOf("rateLimit({ key: `user-mcp:test:${user.id}`");
  const probed = patch.indexOf("await testUserMcpConnection(");
  assert.ok(metered > 0, "PATCH spends the test budget");
  assert.ok(metered < probed, "…before it dials anything");
  assert.match(patch, /if \(identityChanged\) \{\n(?:\s*\/\/[^\n]*\n)*\s*const limit = await rateLimit\(/);
});

test("key rotation re-seals user MCP Authorization headers", () => {
  const script = src("scripts/rotate-encryption-keys.ts");
  assert.match(script, /prismaUnguarded\.userMcpServer\.findMany/);
  assert.match(script, /prismaUnguarded\.userMcpServer\.update\(\{ where: \{ id: row\.id \}, data: \{ authHeader \} \}\)/);
  assert.match(script, /const userMcpServers = await rotateUserMcpServers\(\);/);
  assert.match(script, /userMcpServers\.failed/);
});
