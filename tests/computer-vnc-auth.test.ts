/**
 * The test-only RFB client in tests/helpers/vnc-auth.ts, which the real-container
 * suite (tests/computer-real-e2e.test.ts) uses to log in to a computer's x11vnc
 * through the relay. Its DES is checked against the FIPS 81 / FIPS 46 worked
 * vectors, and the VNC answers against OpenSSL's own DES-ECB (legacy provider),
 * computed once with `openssl enc -des-ecb -nopad -provider legacy` and pasted here.
 * The handshake runs against a scripted server, both the accepted and the refused path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkReader, desEncryptBlock, rfbHandshake, vncAuthResponse } from "./helpers/vnc-auth";

describe("the test-only VNC authentication", () => {
  it("DES matches the standard's worked examples", () => {
    assert.equal(desEncryptBlock(Buffer.from("133457799bbcdff1", "hex"), Buffer.from("0123456789abcdef", "hex")).toString("hex"), "85e813540f0ab405");
    assert.equal(desEncryptBlock(Buffer.from("0e329232ea6d0d73", "hex"), Buffer.from("8787878787878787", "hex")).toString("hex"), "0000000000000000");
  });

  it("a VNC answer is DES-ECB under the bit-reversed, padded password, as OpenSSL computes it", () => {
    const counting = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    assert.equal(vncAuthResponse("Vw123456", counting).toString("hex"), "23abde9a4c148355cc277041dac791e4");
    assert.equal(vncAuthResponse("abc", Buffer.from("ffeeddccbbaa99887766554433221100", "hex")).toString("hex"), "1644884249e9149e362672340bc2cd41");
    // Only the first 8 characters count, as in every RFB implementation.
    assert.deepEqual(vncAuthResponse("Vw123456-and-more", counting), vncAuthResponse("Vw123456", counting));
    assert.throws(() => vncAuthResponse("x", Buffer.alloc(8)));
  });

  /** A server that offers VNC authentication and checks the answer against `password`. */
  function scriptedServer(password: string) {
    const toClient = chunkReader();
    const fromClient = chunkReader();
    const challenge = Buffer.from("0f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex");
    const transcript: string[] = [];
    const server = (async () => {
      toClient.push(Buffer.from("RFB 003.008\n", "latin1"));
      transcript.push(`client version ${(await fromClient.read(12)).toString("latin1").trim()}`);
      toClient.push(Buffer.from([1, 2]));
      transcript.push(`chose ${(await fromClient.read(1))[0]}`);
      toClient.push(challenge);
      const answer = await fromClient.read(16);
      const ok = answer.equals(vncAuthResponse(password, challenge));
      const result = Buffer.alloc(4);
      result.writeUInt32BE(ok ? 0 : 1);
      toClient.push(result);
      if (!ok) {
        const reason = Buffer.from("Authentication failed", "utf8");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(reason.length);
        toClient.push(Buffer.concat([length, reason]));
        return;
      }
      transcript.push(`shared ${(await fromClient.read(1))[0]}`);
      const name = Buffer.from("computer:0", "utf8");
      const init = Buffer.alloc(24);
      init.writeUInt16BE(1280, 0);
      init.writeUInt16BE(800, 2);
      init.writeUInt32BE(name.length, 20);
      toClient.push(Buffer.concat([init, name]));
    })();
    return { transport: { read: toClient.read, write: (bytes: Buffer) => fromClient.push(bytes) }, transcript, server };
  }

  it("logs in with the right password and reads the screen size and name", async () => {
    const { transport, transcript, server } = scriptedServer("Ctl12345");
    const result = await rfbHandshake(transport, "Ctl12345", 2_000);
    await server;
    assert.deepEqual(result, { ok: true, version: "RFB 003.008", width: 1280, height: 800, name: "computer:0" });
    assert.deepEqual(transcript, ["client version RFB 003.008", "chose 2", "shared 1"]);
  });

  it("reports a refused password with the server's reason", async () => {
    const { transport, server } = scriptedServer("Ctl12345");
    const result = await rfbHandshake(transport, "wrong-pw", 2_000);
    await server;
    assert.deepEqual(result, { ok: false, version: "RFB 003.008", stage: "auth", reason: "Authentication failed" });
  });

  it("a reader rejects on close and on timeout instead of hanging", async () => {
    const reader = chunkReader();
    reader.push(Buffer.from("ab"));
    const pending = reader.read(4, 2_000);
    reader.close("socket closed");
    await assert.rejects(pending, /closed \(socket closed\) after 2 of 4 bytes/);
    await assert.rejects(chunkReader().read(1, 50), /timed out/);
  });
});
