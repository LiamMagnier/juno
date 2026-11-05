import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import {
  createComputerViewUpgradeHandler,
  createViewTokenLedger,
  isAllowedComputerEndpoint,
  presentedViewToken,
  isHostInCidr,
  mintComputerViewToken,
  verifyComputerViewToken,
} from "../src/computer-view.js";

const TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef";

describe("relay/computer-view token & CIDR checks", () => {
  it("verifies a valid signed token", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = mintComputerViewToken(
      {
        v: 1,
        a: "agent_123",
        u: "user_456",
        h: "172.30.0.10",
        p: 5900,
        m: "watch",
        exp,
        j: "jti-watch-0001",
      },
      TEST_SECRET
    );
    const parsed = verifyComputerViewToken(token, {
      authSecret: TEST_SECRET,
      nodeEnv: "production",
    });
    assert.ok(parsed);
    assert.equal(parsed.a, "agent_123");
    assert.equal(parsed.u, "user_456");
    assert.equal(parsed.h, "172.30.0.10");
    assert.equal(parsed.p, 5900);
    assert.equal(parsed.m, "watch");
  });

  it("rejects tampered signature, expired token, and out-of-CIDR host", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const valid = mintComputerViewToken(
      {
        v: 1,
        a: "agent_123",
        u: "user_456",
        h: "172.30.0.10",
        p: 5900,
        m: "watch",
        exp,
        j: "jti-watch-0001",
      },
      TEST_SECRET
    );

    // Bad signature
    assert.equal(
      verifyComputerViewToken(`${valid}x`, {
        authSecret: TEST_SECRET,
        nodeEnv: "production",
      }),
      null
    );

    // Expired token
    const expired = mintComputerViewToken(
      {
        v: 1,
        a: "agent_123",
        u: "user_456",
        h: "172.30.0.10",
        p: 5900,
        m: "watch",
        exp: Math.floor(Date.now() / 1000) - 5,
        j: "jti-expired-01",
      },
      TEST_SECRET
    );
    assert.equal(
      verifyComputerViewToken(expired, {
        authSecret: TEST_SECRET,
        nodeEnv: "production",
      }),
      null
    );

    // Out-of-CIDR host
    const outOfCidr = mintComputerViewToken(
      {
        v: 1,
        a: "agent_123",
        u: "user_456",
        h: "10.0.0.8",
        p: 5900,
        m: "watch",
        exp,
        j: "jti-watch-0001",
      },
      TEST_SECRET
    );
    assert.equal(
      verifyComputerViewToken(outOfCidr, {
        authSecret: TEST_SECRET,
        nodeEnv: "production",
      }),
      null
    );

    // 127.0.0.1 rejected in production, allowed in dev
    const loopback = mintComputerViewToken(
      {
        v: 1,
        a: "agent_123",
        u: "user_456",
        h: "127.0.0.1",
        p: 45123,
        m: "control",
        exp,
        j: "jti-loopback-1",
      },
      TEST_SECRET
    );
    assert.equal(
      verifyComputerViewToken(loopback, {
        authSecret: TEST_SECRET,
        nodeEnv: "production",
      }),
      null
    );
    assert.ok(
      verifyComputerViewToken(loopback, {
        authSecret: TEST_SECRET,
        nodeEnv: "development",
      })
    );
  });

  it("checks CIDR subnet matching accurately", () => {
    assert.equal(isHostInCidr("172.30.0.2", "172.30.0.0/24"), true);
    assert.equal(isHostInCidr("172.30.0.254", "172.30.0.0/24"), true);
    assert.equal(isHostInCidr("172.30.1.2", "172.30.0.0/24"), false);
    assert.equal(isAllowedComputerEndpoint("172.30.0.12", 5900, { nodeEnv: "production" }), true);
    assert.equal(isAllowedComputerEndpoint("172.30.0.12", 5901, { nodeEnv: "production" }), false);
  });
});

describe("relay/computer-view single-use tokens", () => {
  it("a token without a one-time id is refused, and the ledger accepts an id once", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const withoutId = mintComputerViewToken(
      { v: 1, a: "agent_123", u: "user_456", h: "172.30.0.10", p: 5900, m: "watch", exp } as never,
      TEST_SECRET
    );
    assert.equal(verifyComputerViewToken(withoutId, { authSecret: TEST_SECRET, nodeEnv: "production" }), null);

    const ledger = createViewTokenLedger(() => 1_000_000);
    assert.equal(ledger.accept({ j: "jti-once-0001", exp: 2_000 }), true);
    assert.equal(ledger.accept({ j: "jti-once-0001", exp: 2_000 }), false);
    assert.equal(ledger.accept({ j: "jti-once-0002", exp: 2_000 }), true);
  });

  it("a token for one agent cannot be re-pointed at another agent's computer", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = mintComputerViewToken(
      { v: 1, a: "agent_a", u: "user_1", h: "172.30.0.10", p: 5900, m: "control", exp, j: "jti-agent-a-01" },
      TEST_SECRET
    );
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, a: "agent_b", h: "172.30.0.11" }), "utf8").toString("base64url");
    assert.equal(verifyComputerViewToken(`${forged}.${sig}`, { authSecret: TEST_SECRET, nodeEnv: "production" }), null);
  });

  it("reads the token from the juno-view subprotocol before the query string", () => {
    assert.equal(
      presentedViewToken({ url: "/computer?t=from-query", headers: { "sec-websocket-protocol": "binary, juno-view.from-protocol" } }),
      "from-protocol"
    );
    assert.equal(presentedViewToken({ url: "/computer?t=from-query", headers: {} }), "from-query");
    assert.equal(presentedViewToken({ url: "/computer", headers: {} }), null);
  });
});

describe("relay/computer-view WebSocket <-> TCP bridge", () => {
  it("pipes binary bytes round-trip and enforces origin, token, and 3-viewer cap", async () => {
    // 1. Start a fake VNC TCP server on 127.0.0.1
    const tcpServer = net.createServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.on("data", (chunk) => {
        // Echo back prefixed with 0xaa
        socket.write(Buffer.concat([Buffer.from([0xaa]), chunk]));
      });
    });

    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
    const tcpPort = (tcpServer.address() as AddressInfo).port;

    // 2. Start HTTP server with computerView upgrade handler
    const computerView = createComputerViewUpgradeHandler({
      allowedOrigins: ["https://juno.example"],
      authSecret: TEST_SECRET,
      nodeEnv: "development",
      maxViewersPerAgent: 3,
    });

    const httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    httpServer.on("upgrade", (req, socket, head) => {
      if (!computerView.handleUpgrade(req, socket, head)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpServer.address() as AddressInfo).port;

    try {
      let serial = 0;
      const mint = () =>
        mintComputerViewToken(
          {
            v: 1,
            a: "agent_bridge_1",
            u: "user_1",
            h: "127.0.0.1",
            p: tcpPort,
            m: "control",
            exp: Math.floor(Date.now() / 1000) + 60,
            j: `jti-bridge-${String((serial += 1)).padStart(4, "0")}`,
          },
          TEST_SECRET
        );
      const validToken = mint();

      // Bad origin -> 403
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(
              `ws://127.0.0.1:${httpPort}/voice-relay/computer?t=${encodeURIComponent(validToken)}`,
              ["binary"],
              { headers: { Origin: "https://evil.example" } }
            );
            ws.on("open", () => {
              ws.close();
              resolve();
            });
            ws.on("error", reject);
          })
      );

      // Bad signature -> 401
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(
              `ws://127.0.0.1:${httpPort}/voice-relay/computer?t=${encodeURIComponent(validToken + "bad")}`,
              ["binary"],
              { headers: { Origin: "https://juno.example" } }
            );
            ws.on("open", () => {
              ws.close();
              resolve();
            });
            ws.on("error", reject);
          })
      );

      // Valid connection + binary round-trip + subprotocol "binary"
      const ws1 = new WebSocket(
        `ws://127.0.0.1:${httpPort}/voice-relay/computer?t=${encodeURIComponent(validToken)}`,
        ["binary"],
        { headers: { Origin: "https://juno.example" } }
      );

      const firstBanner = await new Promise<Buffer>((resolve, reject) => {
        ws1.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
        ws1.once("error", reject);
      });
      assert.equal(ws1.protocol, "binary");
      assert.equal(firstBanner.toString("ascii"), "RFB 003.008\n");

      const echoPromise = new Promise<Buffer>((resolve, reject) => {
        ws1.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
        ws1.once("error", reject);
      });
      ws1.send(Buffer.from([0x01, 0x02, 0x03]), { binary: true });
      const echoed = await echoPromise;
      assert.deepEqual([...echoed], [0xaa, 0x01, 0x02, 0x03]);

      // The same token again is refused: single use, whoever presents it.
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const replay = new WebSocket(
              `ws://127.0.0.1:${httpPort}/voice-relay/computer?t=${encodeURIComponent(validToken)}`,
              ["binary"],
              { headers: { Origin: "https://juno.example" } }
            );
            replay.on("open", () => {
              replay.close();
              resolve();
            });
            replay.on("error", reject);
          })
      );

      // Open 2 more viewers (total 3 allowed), each with its own token, offered
      // as a subprotocol so it is never in the URL.
      const openViewer = () =>
        new Promise<WebSocket>((resolve, reject) => {
          const w = new WebSocket(
            `ws://127.0.0.1:${httpPort}/voice-relay/computer`,
            ["binary", `juno-view.${mint()}`],
            { headers: { Origin: "https://juno.example" } }
          );
          w.once("open", () => resolve(w));
          w.once("error", reject);
        });

      const ws2 = await openViewer();
      // The token protocol is never chosen back: the relay answers "binary".
      assert.equal(ws2.protocol, "binary");
      const ws3 = await openViewer();
      assert.equal(computerView.getActiveViewerCount("agent_bridge_1"), 3);

      // 4th viewer should be rejected (429)
      await assert.rejects(() => openViewer());

      ws1.close();
      ws2.close();
      ws3.close();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });
});

/*
 * Version 2: a computer host's VNC tunnel (COMPUTERS_2026-10.md S3.3). The app
 * mints these (src/lib/computer/live-view.ts; tests/computer-view-token.test.ts
 * checks the two packages agree); here a token is sealed the same way so the
 * relay's bridge can be driven against a stub host.
 */
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { normalizeComputerHost, parseComputerHosts, unsealTunnelTicket } from "../src/computer-view.js";

function sealV2(fields: { a: string; u: string; m: string; exp: number; j: string; r: string }, inner: unknown, secret = TEST_SECRET): string {
  const aad = Buffer.from([2, fields.a, fields.u, fields.m, fields.exp, fields.j, fields.r].join("|"), "utf8");
  const key = Buffer.from(hkdfSync("sha256", secret, "juno-computer-view-v2", "tunnel-ticket", 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

function signV2(payload: Record<string, unknown>, secret = TEST_SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", secret).update("juno-computer-view-v2").digest();
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

const TICKET_A = "A".repeat(43);
let jti = 0;
function v2Token(r: string, opts: { m?: string; port?: number; ticket?: string; agent?: string } = {}): string {
  const fields = {
    a: opts.agent ?? "agent_tunnel",
    u: "user_1",
    m: opts.m ?? "control",
    exp: Math.floor(Date.now() / 1000) + 60,
    j: `jti-tunnel-${String((jti += 1)).padStart(4, "0")}`,
    r,
  };
  return signV2({ v: 2, ...fields, k: sealV2(fields, { t: opts.ticket ?? TICKET_A, p: opts.port ?? 5900 }) });
}

describe("relay/computer-view version 2: a computer host's tunnel", () => {
  it("v2 tokens open a tunnel only to a listed origin", () => {
    const token = v2Token("https://computers.example.test");
    assert.equal(verifyComputerViewToken(token, { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: [] }), null);
    assert.equal(
      verifyComputerViewToken(token, { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: ["https://other.example.test"] }),
      null
    );
    const grant = verifyComputerViewToken(token, { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: ["https://computers.example.test"] });
    assert.ok(grant && grant.v === 2 && grant.ticket === TICKET_A);
    const plain = v2Token("http://127.0.0.1:8750");
    assert.equal(verifyComputerViewToken(plain, { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: ["http://127.0.0.1:8750"] }), null);
    assert.equal(normalizeComputerHost("http://10.0.0.4:8750", "development"), null);
    assert.equal(normalizeComputerHost("https://computers.example.test/", "production"), "https://computers.example.test");
    assert.deepEqual(parseComputerHosts(" https://a.test ,, wss://b.test", "production"), ["https://a.test"]);
  });

  it("a sealed ticket cannot be read from the token", () => {
    const token = v2Token("https://computers.example.test");
    assert.ok(!token.includes(TICKET_A));
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Record<string, string>;
    assert.ok(!Buffer.from(payload.k, "base64url").toString("latin1").includes(TICKET_A));
    // Without the secret, nothing opens it.
    const aad = Buffer.from("anything");
    assert.equal(unsealTunnelTicket(payload.k, aad, "another-secret-0123456789abcdef0123"), null);
  });

  it("a sealed ticket moved into another token is refused (AAD)", () => {
    const host = "https://computers.example.test";
    const victim = JSON.parse(Buffer.from(v2Token(host, { agent: "agent_victim" }).split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const attacker = JSON.parse(Buffer.from(v2Token(host, { agent: "agent_attacker" }).split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const moved = signV2({ ...attacker, k: victim.k });
    assert.equal(verifyComputerViewToken(moved, { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: [host] }), null);
  });

  it("v2 needs watch or control and port 5900", () => {
    const host = "https://computers.example.test";
    const opts = { authSecret: TEST_SECRET, nodeEnv: "production", computerHosts: [host] };
    assert.equal(verifyComputerViewToken(v2Token(host, { m: "admin" }), opts), null);
    for (const port of [9222, 22, 5901]) {
      assert.equal(verifyComputerViewToken(v2Token(host, { port }), opts), null, String(port));
    }
    assert.equal(verifyComputerViewToken(v2Token(host, { ticket: "short" }), opts), null);
    assert.ok(verifyComputerViewToken(v2Token(host, { m: "watch" }), opts));
  });

  it("the relay sends the ticket as a header, offers no subprotocol, and bridges binary frames", async () => {
    const seen: Array<{ url: string | undefined; ticket: unknown; protocol: unknown }> = [];
    const stubHost = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const tunnels = new WebSocketServer({ noServer: true });
    stubHost.on("upgrade", (req, socket, head) => {
      seen.push({ url: req.url, ticket: req.headers["x-juno-tunnel-ticket"], protocol: req.headers["sec-websocket-protocol"] });
      if (req.url !== "/v1/tunnel" || req.headers["x-juno-tunnel-ticket"] !== TICKET_A) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      tunnels.handleUpgrade(req, socket, head, (ws) => {
        ws.send(Buffer.from("RFB 003.008\n", "ascii"));
        ws.on("message", (data) => ws.send(Buffer.concat([Buffer.from([0xbb]), Buffer.from(data as Buffer)])));
      });
    });
    await new Promise<void>((resolve) => stubHost.listen(0, "127.0.0.1", resolve));
    const hostOrigin = `http://127.0.0.1:${(stubHost.address() as AddressInfo).port}`;

    const computerView = createComputerViewUpgradeHandler({
      allowedOrigins: ["https://juno.example"],
      authSecret: TEST_SECRET,
      nodeEnv: "development",
      computerHosts: [hostOrigin],
    });
    const relayServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    relayServer.on("upgrade", (req, socket, head) => {
      if (!computerView.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    const relayPort = (relayServer.address() as AddressInfo).port;

    try {
      const viewer = new WebSocket(`ws://127.0.0.1:${relayPort}/voice-relay/computer`, ["binary", `juno-view.${v2Token(hostOrigin)}`], {
        headers: { Origin: "https://juno.example" },
      });
      const banner = await new Promise<Buffer>((resolve, reject) => {
        viewer.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
        viewer.once("error", reject);
      });
      assert.equal(banner.toString("ascii"), "RFB 003.008\n");
      const echo = new Promise<Buffer>((resolve) => viewer.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer))));
      viewer.send(Buffer.from([1, 2, 3]), { binary: true });
      assert.deepEqual([...(await echo)], [0xbb, 1, 2, 3]);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { url: "/v1/tunnel", ticket: TICKET_A, protocol: undefined }, "the ticket in the header, no subprotocol offered");
      viewer.close();

      // A host that refuses the ticket closes the viewer instead of leaving it open.
      const refused = new WebSocket(
        `ws://127.0.0.1:${relayPort}/voice-relay/computer`,
        ["binary", `juno-view.${v2Token(hostOrigin, { ticket: "B".repeat(43) })}`],
        { headers: { Origin: "https://juno.example" } }
      );
      const closeCode = await new Promise<number>((resolve) => refused.once("close", (code) => resolve(code)));
      assert.ok(closeCode > 0);
      // And an unlisted host is refused at the relay's own door.
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const w = new WebSocket(`ws://127.0.0.1:${relayPort}/voice-relay/computer`, ["binary", `juno-view.${v2Token("https://unlisted.example.test")}`], {
              headers: { Origin: "https://juno.example" },
            });
            w.once("open", () => {
              w.close();
              resolve();
            });
            w.once("error", reject);
          })
      );
    } finally {
      await new Promise<void>((resolve) => relayServer.close(() => resolve()));
      tunnels.close();
      stubHost.closeAllConnections();
      await new Promise<void>((resolve) => stubHost.close(() => resolve()));
    }
  });
});
