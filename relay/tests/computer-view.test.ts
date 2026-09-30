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
