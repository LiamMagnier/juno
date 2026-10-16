/**
 * computer.frame (SPEC §3.12): the web's Screen pane reads a session's stored
 * frames from the Mac's shots folder, and nothing else on the Mac.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import { FRAME_REF, MAX_FRAME_BYTES, readComputerFrame } from "../src/mcp/computer-frame.js";
import { WireError } from "../src/sessions/session-manager.js";
import { TestClient, fakeBinDir, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

/** A shots folder laid out as ComputerScreenshotStore writes it, plus a secret beside it. */
function shotsFixture() {
  const home = tempDir("shots-home");
  const root = path.join(home, "shots");
  mkdirSync(path.join(root, "claude:t7"), { recursive: true, mode: 0o700 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  writeFileSync(path.join(root, "claude:t7", "toolu_1.jpg"), jpeg);
  writeFileSync(path.join(root, "claude:t7", "toolu_2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const secret = path.join(home, "secret.jpg");
  writeFileSync(secret, Buffer.from("not yours"));
  return { home, root, jpeg, secret };
}

function refusal(run: () => unknown): WireError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof WireError, `expected a WireError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

test("computer.frame returns the stored bytes for a valid ref", () => {
  const { root, jpeg } = shotsFixture();
  const frame = readComputerFrame("alevr-shot://claude:t7/toolu_1.jpg", { root });
  assert.equal(frame.mime, "image/jpeg");
  assert.equal(frame.bytes, jpeg.length);
  assert.deepEqual(Buffer.from(frame.data, "base64"), jpeg);
  assert.equal(readComputerFrame("alevr-shot://claude:t7/toolu_2.png", { root }).mime, "image/png");
});

test("computer.frame refuses ../ traversal and every ref outside the shots folder", () => {
  const { root } = shotsFixture();
  for (const ref of [
    "alevr-shot://../secret.jpg",
    "alevr-shot://claude:t7/../../secret.jpg",
    "alevr-shot://../../secret/x.jpg",
    "alevr-shot://claude:t7/..%2F..%2Fsecret.jpg",
    "alevr-shot://./toolu_1.jpg",
    "alevr-shot://claude:t7/.hidden.jpg",
    "alevr-shot:///etc/passwd",
    "alevr-shot://claude:t7/sub/toolu_1.jpg",
    "alevr-shot://claude:t7/toolu_1.jpg/",
    "alevr-shot://claude:t7/toolu_1.txt",
    "alevr-shot://claude t7/toolu_1.jpg",
    "file:///etc/passwd",
    "/etc/passwd",
    "https://example.com/x.jpg",
    "",
    42,
    null,
  ]) {
    assert.equal(refusal(() => readComputerFrame(ref, { root })).code, "bad_request", String(ref));
  }
  assert.equal(FRAME_REF.test("alevr-shot://claude:t7/toolu_1.jpg"), true);
  assert.equal(FRAME_REF.test(`alevr-shot://${"a".repeat(121)}/x.jpg`), false, "a part is at most 120 characters, as the store writes it");
});

test("computer.frame refuses symlinks: the file, the session folder and the shots folder itself", () => {
  const { home, root, secret } = shotsFixture();
  symlinkSync(secret, path.join(root, "claude:t7", "link.jpg"));
  assert.equal(refusal(() => readComputerFrame("alevr-shot://claude:t7/link.jpg", { root })).code, "bad_request");

  const outside = path.join(home, "elsewhere");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "toolu_9.jpg"), Buffer.from("elsewhere"));
  symlinkSync(outside, path.join(root, "linked-session"));
  assert.equal(refusal(() => readComputerFrame("alevr-shot://linked-session/toolu_9.jpg", { root })).code, "bad_request");

  const linkedRoot = path.join(home, "linked-shots");
  symlinkSync(root, linkedRoot);
  assert.equal(refusal(() => readComputerFrame("alevr-shot://claude:t7/toolu_1.jpg", { root: linkedRoot })).code, "bad_request");
});

test("computer.frame refuses oversized files and folders, and says when a frame is gone", () => {
  const { root } = shotsFixture();
  writeFileSync(path.join(root, "claude:t7", "big.jpg"), Buffer.alloc(2048));
  const big = refusal(() => readComputerFrame("alevr-shot://claude:t7/big.jpg", { root, maxBytes: 1024 }));
  assert.equal(big.code, "bad_request");
  assert.match(big.message, /too large/);
  assert.ok(MAX_FRAME_BYTES <= 4 * 1024 * 1024, "a frame fits the relay's 8 MB host push as base64");

  mkdirSync(path.join(root, "claude:t7", "dir.jpg"));
  assert.equal(refusal(() => readComputerFrame("alevr-shot://claude:t7/dir.jpg", { root })).code, "bad_request");
  assert.equal(refusal(() => readComputerFrame("alevr-shot://claude:t7/missing.jpg", { root })).code, "not_found");
  assert.equal(refusal(() => readComputerFrame("alevr-shot://nobody/toolu_1.jpg", { root })).code, "not_found");
});

test("computer.frame over the wire: bytes for a valid ref, a bad_request for traversal", async () => {
  const { root, jpeg } = shotsFixture();
  const server = await startEnvServer({
    dataDir: tempDir("data"),
    searchDirs: [fakeBinDir()],
    logger: silentLogger,
    probeOnStart: false,
    computerUse: { available: () => false, shotsDir: root },
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);

  const frame = await client.command<{ mime: string; data: string; bytes: number }>("computer.frame", { ref: "alevr-shot://claude:t7/toolu_1.jpg" });
  assert.equal(frame.mime, "image/jpeg");
  assert.deepEqual(Buffer.from(frame.data, "base64"), jpeg);

  await assert.rejects(
    client.command("computer.frame", { ref: "alevr-shot://claude:t7/../../secret.jpg" }),
    (error: Error & { code?: string }) => error.code === "bad_request",
  );
});
