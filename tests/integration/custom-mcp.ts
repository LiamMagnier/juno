/*
 * Custom MCP connectors, end to end against a real (local) server.
 *
 * Runs with `--conditions=react-server` because the modules under test are
 * `server-only`. Spins up a throwaway OAuth-protected MCP server on loopback
 * (allowed only when NODE_ENV is explicitly development or test, which this
 * script sets; see allowsLocalDevelopment in src/lib/mcp-safe-fetch.ts) and walks
 * the whole path a person's server takes: probe → discovery → dynamic client
 * registration → token exchange → a streamed tools/list and tools/call
 * through the SSRF-safe fetcher. Then checks the fetcher refuses what it
 * must, override or not.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Next declares NODE_ENV read-only on ProcessEnv; the policy reads it per call.
const env = process.env as Record<string, string | undefined>;

async function main() {
  // The loopback exception fails closed: only an explicit development or test
  // NODE_ENV opens it, so a hand-started worker without NODE_ENV cannot dial
  // the VM's own services.
  env.NODE_ENV = "test";

  const {
    canonicalMcpUrl,
    isCustomConnectorId,
    newCustomConnectorId,
    probeCustomMcpServer,
    suggestedName,
  } = await import("../../src/lib/custom-connectors");
  const { customMcpUrlProblem, safeMcpFetch } = await import("../../src/lib/mcp-safe-fetch");
  const { createPkce, discoverEndpoints, exchangeMcpCode, registerClient } = await import("../../src/lib/mcp-oauth");
  const { classifyToolAccess } = await import("../../src/lib/tool-access");

  let passed = 0;
  async function check(name: string, run: () => Promise<void> | void) {
    await run();
    passed += 1;
    console.log(`ok - ${name}`);
  }

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  await check("urls are canonicalised the way people paste them", () => {
    assert.equal(canonicalMcpUrl("mcp.Linear.app/sse"), "https://mcp.linear.app/sse");
    assert.equal(canonicalMcpUrl("  https://example.com/mcp#frag "), "https://example.com/mcp");
    assert.equal(canonicalMcpUrl(""), null);
    assert.equal(canonicalMcpUrl("http://"), null);
  });

  await check("ids are short, prefixed and checkable", () => {
    const id = newCustomConnectorId();
    assert.match(id, /^mcp:[a-z0-9]{10}$/);
    assert.ok(isCustomConnectorId(id));
    assert.ok(!isCustomConnectorId("github"));
    assert.ok(!isCustomConnectorId("composio:slack"));
    assert.ok(!isCustomConnectorId("mcp:../../etc"));
  });

  await check("names come from the host unless the server names itself", () => {
    assert.equal(suggestedName("https://mcp.linear.app/mcp"), "Linear");
    assert.equal(suggestedName("https://api.acme.io/mcp"), "Acme");
    assert.equal(suggestedName("https://x.example/mcp", "Sentry"), "Sentry");
    assert.equal(suggestedName("https://tools.example/mcp", "mcp-server"), "Tools");
  });

  await check("only public https addresses are accepted", () => {
    assert.equal(customMcpUrlProblem("https://mcp.example.com/mcp"), null);
    assert.match(customMcpUrlProblem("http://mcp.example.com/mcp") ?? "", /https/);
    assert.match(customMcpUrlProblem("https://169.254.169.254/latest") ?? "", /private/);
    assert.match(customMcpUrlProblem("https://10.0.0.8/mcp") ?? "", /private/);
    assert.match(customMcpUrlProblem("https://svc.internal/mcp") ?? "", /private/);
    assert.match(customMcpUrlProblem("https://user:pw@example.com/mcp") ?? "", /username/);
    // The loopback override is for local development only, and loopback only.
    assert.equal(customMcpUrlProblem("http://localhost:9999/mcp"), null);
    assert.match(customMcpUrlProblem("http://10.0.0.8/mcp") ?? "", /https/);
  });

  // ---------------------------------------------------------------------------
  // A local OAuth-protected MCP server
  // ---------------------------------------------------------------------------

  const TOKEN = "test-access-token";
  let registered = 0;

  function makeMcp() {
    const server = new McpServer({ name: "Acme Tools", version: "1.0.0" }, { instructions: "Search and file Acme tickets." });
    server.registerTool(
      "search_tickets",
      { description: "Find tickets", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async ({ query }) => ({ content: [{ type: "text", text: `found 3 tickets for ${query}` }] })
    );
    server.registerTool(
      "create_ticket",
      { description: "File a ticket", inputSchema: { title: z.string() } },
      async ({ title }) => ({ content: [{ type: "text", text: `created ${title}` }] })
    );
    return server;
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  const http = createServer(async (req, res) => {
    const origin = `http://localhost:${(http.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      registered += 1;
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      assert.ok(body.redirect_uris?.[0]?.endsWith("/api/connectors/custom/callback"));
      return json(res, 201, { client_id: `client-${registered}` });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("code") !== "good-code" || !form.get("code_verifier")) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: TOKEN, refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/mcp" || url.pathname === "/open") {
      if (url.pathname === "/mcp" && req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeMcp();
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, JSON.parse(await readBody(req)));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const origin = `http://localhost:${(http.address() as AddressInfo).port}`;
  const mcpUrl = `${origin}/mcp`;

  try {
    await check("a protected server with OAuth sign-in probes as addable", async () => {
      const probe = await probeCustomMcpServer(mcpUrl);
      assert.ok(probe.ok, JSON.stringify(probe));
      assert.equal(probe.ok && probe.authHost, "localhost");
    });

    await check("an open server is refused with a reason, not added", async () => {
      const probe = await probeCustomMcpServer(`${origin}/open`);
      assert.equal(probe.ok, false);
      assert.equal(!probe.ok && probe.reason, "no_auth");
    });

    await check("nothing there reads as unreachable", async () => {
      const probe = await probeCustomMcpServer(`${origin}/nothing`);
      assert.equal(!probe.ok && probe.reason, "unreachable");
    });

    const endpoints = await discoverEndpoints(mcpUrl, safeMcpFetch);

    await check("sign-in: discover, register and exchange through the safe fetcher", async () => {
      const client = await registerClient(
        endpoints,
        { clientName: "Juno", clientUri: "https://juno.test", redirectUri: "https://juno.test/api/connectors/custom/callback" },
        safeMcpFetch
      );
      assert.equal(client.clientId, "client-1");
      const pkce = createPkce();
      const tokens = await exchangeMcpCode(
        {
          tokenEndpoint: endpoints.tokenEndpoint,
          client,
          code: "good-code",
          codeVerifier: pkce.verifier,
          redirectUri: "https://juno.test/api/connectors/custom/callback",
          resource: endpoints.resource,
        },
        safeMcpFetch
      );
      assert.equal(tokens.accessToken, TOKEN);
      assert.equal(tokens.expiresInSec, 3600);
    });

    await check("tools list and call over streamed responses through the safe fetcher", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        fetch: safeMcpFetch,
      });
      const client = new Client({ name: "juno", version: "1.0.0" });
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, "Acme Tools");
      assert.equal(client.getInstructions(), "Search and file Acme tickets.");
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      assert.deepEqual([...byName.keys()].sort(), ["create_ticket", "search_tickets"]);
      const search = byName.get("search_tickets")!;
      assert.equal(classifyToolAccess(search.name, search.annotations as { readOnlyHint?: boolean }), "read");
      assert.equal(classifyToolAccess("create_ticket"), "write");
      const result = await client.callTool({ name: "search_tickets", arguments: { query: "login" } });
      assert.deepEqual(result.content, [{ type: "text", text: "found 3 tickets for login" }]);
      await client.close();
    });

    await check("without the token the server is refused, not silently open", async () => {
      const res = await safeMcpFetch(mcpUrl, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      assert.equal(res.status, 401);
    });

    await check("the fetcher refuses private addresses even with the dev override", async () => {
      await assert.rejects(safeMcpFetch("http://169.254.169.254/latest/meta-data"), /Blocked|https/);
      await assert.rejects(safeMcpFetch("https://10.1.2.3/mcp"), /Blocked|private/);
    });

    await check("without the override, loopback is refused too", async () => {
      for (const mode of ["production", undefined]) {
        if (mode === undefined) delete env.NODE_ENV;
        else env.NODE_ENV = mode;
        try {
          assert.match(customMcpUrlProblem(mcpUrl) ?? "", /own machine/, `NODE_ENV=${mode}`);
          await assert.rejects(safeMcpFetch(mcpUrl), /Blocked/);
          const probe = await probeCustomMcpServer(mcpUrl);
          assert.equal(probe.ok, false);
        } finally {
          env.NODE_ENV = "test";
        }
      }
    });
  } finally {
    http.close();
  }

  // A hostile authorization server: huge metadata and a token endpoint that
  // trickles forever. Neither may be buffered whole or hold a request open.
  const { MAX_OAUTH_RESPONSE_BYTES } = await import("../../src/lib/mcp-oauth");
  const hostile = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < 16 * 1024 * 1024) {
          sent += chunk.byteLength;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end("{}");
      };
      pump();
      return;
    }
    if (req.url === "/slow-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      return; // never finishes
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => hostile.listen(0, resolve));
  const hostileUrl = `http://localhost:${(hostile.address() as AddressInfo).port}`;
  try {
    await check("an oversized authorization server answer is refused, not buffered", async () => {
      assert.ok(MAX_OAUTH_RESPONSE_BYTES <= 1024 * 1024);
      const before = process.memoryUsage().arrayBuffers;
      await assert.rejects(discoverEndpoints(`${hostileUrl}/mcp`, safeMcpFetch), /too large/);
      assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024, "the body was not read whole");
    });

    await check("a token endpoint that never finishes times out", async () => {
      const started = Date.now();
      await assert.rejects(
        exchangeMcpCode(
          { tokenEndpoint: `${hostileUrl}/slow-token`, client: { clientId: "c" }, code: "x", codeVerifier: "v", redirectUri: "https://juno.test/cb", resource: `${hostileUrl}/mcp` },
          safeMcpFetch
        ),
        /abort|timeout/i
      );
      assert.ok(Date.now() - started < 30_000);
    });
  } finally {
    hostile.closeAllConnections();
    hostile.close();
  }

  console.log(`\n${passed} custom MCP checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
