/**
 * Files on the agent's computer are binary-safe (docs/design/agents-v2/COMPUTERS_2026-10.md
 * S5.2): `computer_files` reads and writes any bytes with encoding base64,
 * byte for byte, through the fake, Docker (a stand-in binary) and the remote
 * host (a fake fetch); and a utf8 read of a file that is not text says so
 * instead of handing the model mojibake.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const { FakeProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { DockerProvider } = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const { RemoteComputerProvider } = req("../src/lib/computer/remote") as typeof import("@/lib/computer/remote");
type Provider = import("@/lib/computer/types").ComputerProvider;

const handle = { name: "juno-agent-agent_1", volume: "juno-agent-agent_1" };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SHOT = { mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 };

/** The `computer_files` tool wired to a provider the way the Work runner wires it. */
async function filesTool(provider: Pick<Provider, "readFile" | "writeFile" | "listFiles" | "fileInfo">) {
  const runtime = await import("../runner/agent-core/dist/work/index.js");
  const tools = runtime.computerTools({
    isHealthy: () => true,
    pageTakesPayment: () => false,
    currentUrl: () => "",
    screenEpoch: () => 0,
    screenshot: async () => SHOT,
    click: async () => SHOT,
    type: async () => SHOT,
    key: async () => SHOT,
    scroll: async () => SHOT,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    listFiles: (dir) => provider.listFiles(handle, dir),
    readFile: (p, maxBytes) => provider.readFile(handle, p, { maxBytes }),
    writeFile: (p, bytes) => provider.writeFile(handle, p, Buffer.from(bytes)),
    fileSize: async (p) => (await provider.fileInfo(handle, p))?.size ?? null,
  });
  const tool = tools.find((t) => t.spec.name === "computer_files")!;
  return (input: Record<string, unknown>) => tool.execute(input, { cwd: "/" });
}

describe("binary bytes round-trip byte for byte", () => {
  it("through the fake: base64 write, base64 read, the same sha256; and the bytes on the computer are the bytes sent", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const bytes = randomBytes(150 * 1024);
    bytes[10] = 0;
    bytes[11] = 0xff;
    const wrote = await files({ action: "write", path: "/home/agent/work/blob.bin", encoding: "base64", content: bytes.toString("base64") });
    assert.equal(wrote.isError ?? false, false, wrote.output);
    assert.equal(wrote.output, `Wrote ${bytes.byteLength} bytes to /home/agent/work/blob.bin.`);
    assert.equal(sha(await fake.readFile(handle, "/home/agent/work/blob.bin")), sha(bytes), "stored unchanged");
    const read = await files({ action: "read", path: "/home/agent/work/blob.bin", encoding: "base64" });
    assert.equal(sha(Buffer.from(read.output, "base64")), sha(bytes), "read back unchanged");
  });

  it("base64 reads keep the 200 KB cap on the raw bytes, and say so", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const bytes = randomBytes(300 * 1024);
    await fake.writeFile(handle, "/home/agent/work/big.bin", bytes);
    const read = await files({ action: "read", path: "/home/agent/work/big.bin", encoding: "base64" });
    const [encoded, note] = read.output.split("\n");
    assert.deepEqual(Buffer.from(encoded, "base64"), bytes.subarray(0, 200 * 1024));
    assert.match(note, /truncated at 200 KB/);
  });

  it("utf8 text still reads and writes as text, multi-byte characters included, even when the cap cuts one", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const text = "naïve café — 東京\n";
    const wrote = await files({ action: "write", path: "/home/agent/work/notes.md", content: text });
    assert.equal(wrote.output, `Wrote ${text.length} characters (${Buffer.byteLength(text)} bytes) to /home/agent/work/notes.md.`);
    assert.equal((await files({ action: "read", path: "/home/agent/work/notes.md" })).output, text);
    // 200 KB of a 3-byte character, cut in the middle of one: still text, never "binary".
    await fake.writeFile(handle, "/home/agent/work/long.txt", Buffer.from("東".repeat(70_000)));
    const long = await files({ action: "read", path: "/home/agent/work/long.txt" });
    assert.match(long.output, /\[File truncated at 200 KB\]$/);
    assert.equal(long.output.includes("binary"), false);
  });

  it("invalid base64 writes nothing; a dotfile or a path outside the work area is still refused", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const bad = await files({ action: "write", path: "/home/agent/work/x.bin", encoding: "base64", content: "not*base64" });
    assert.equal(bad.isError, true);
    assert.match(bad.output, /not valid base64/);
    for (const target of ["/home/agent/.bashrc", "/home/agent/work/.env", "/home/agent/notes.txt"]) {
      const refused = await files({ action: "write", path: target, encoding: "base64", content: "aGk=" });
      assert.equal(refused.isError, true, target);
    }
    assert.equal(fake.calls.some((c) => c.method === "writeFile"), false, "nothing was written");
    const odd = await files({ action: "read", path: "/home/agent/work/x", encoding: "latin1" });
    assert.equal(odd.isError, true);
  });

  describe("through Docker (a stand-in docker): stdin in, stdout out, no transcoding", () => {
    let dir: string;
    const savedPath = process.env.PATH;
    before(() => {
      dir = mkdtempSync(path.join(tmpdir(), "juno-s5-files-"));
      writeFileSync(
        path.join(dir, "docker"),
        [
          "#!/usr/bin/env python3",
          "import os, sys",
          "store = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'file.bin')",
          "argv = sys.argv[1:]",
          "command = argv[argv.index('--') + 1:] if '--' in argv else argv",
          "if 'realpath' in command: print(command[-1]); sys.exit(0)",
          "if 'mkdir' in command: sys.exit(0)",
          "if argv[:2] == ['exec', '-i']:",
          "    open(store, 'wb').write(sys.stdin.buffer.read()); sys.exit(0)",
          "if 'head' in command:",
          "    data = open(store, 'rb').read()[:int(command[2])]",
          "    sys.stdout.buffer.write(data); sys.exit(0)",
          "sys.exit(2)",
        ].join("\n")
      );
      chmodSync(path.join(dir, "docker"), 0o755);
      process.env.PATH = `${dir}:${savedPath}`;
    });
    after(() => {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    });

    it("a 1 MB random file round-trips with the same sha256", async () => {
      const provider = new DockerProvider();
      const bytes = randomBytes(1024 * 1024);
      await provider.writeFile(handle, "/home/agent/work/inbox/random.bin", bytes, { by: "person" });
      assert.equal(sha(readFileSync(path.join(dir, "file.bin"))), sha(bytes), "what docker exec -i received");
      const back = await provider.readFile(handle, "/home/agent/work/inbox/random.bin", { maxBytes: 2 * 1024 * 1024 });
      assert.equal(sha(back), sha(bytes));
    });
  });

  it("through the remote host (a fake fetch): the PUT body and the GET answer are the bytes, unchanged", async () => {
    let stored = Buffer.alloc(0);
    const seen: string[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push(`${init.method} ${url.pathname}?by=${url.searchParams.get("by") ?? ""}`);
      if (init.method === "PUT") {
        stored = Buffer.from(init.body as Uint8Array);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array(stored), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as unknown as typeof fetch;
    const provider = new RemoteComputerProvider({ origin: "http://127.0.0.1:8750", token: "a".repeat(64), fetchImpl });
    const bytes = randomBytes(1024 * 1024);
    await provider.writeFile(handle, "/home/agent/work/inbox/r.bin", bytes, { by: "person" });
    const back = await provider.readFile(handle, "/home/agent/work/inbox/r.bin", { maxBytes: 2 * 1024 * 1024 });
    assert.equal(sha(back), sha(bytes));
    assert.deepEqual(seen, [
      "PUT /v1/computers/juno-agent-agent_1/files/content?by=person",
      "GET /v1/computers/juno-agent-agent_1/files/content?by=",
    ]);
  });
});

describe("a utf8 read of binary says so", () => {
  it("names the path, the size and the start of the sha256, and says how to read it", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), randomBytes(2000)]);
    await fake.writeFile(handle, "/home/agent/work/chart.png", png);
    const read = await files({ action: "read", path: "/home/agent/work/chart.png" });
    assert.equal(read.isError ?? false, false);
    assert.equal(
      read.output,
      `/home/agent/work/chart.png is a binary file (2 KB, sha256 ${sha(png).slice(0, 12)}). Read it with encoding base64, or publish it.`
    );
  });

  it("invalid UTF-8 without a NUL is binary too; a large one gives its real size", async () => {
    const fake = new FakeProvider();
    const files = await filesTool(fake);
    const latin1 = Buffer.from("caf\xe9 cr\xe8me", "latin1");
    await fake.writeFile(handle, "/home/agent/work/old.txt", latin1);
    assert.match((await files({ action: "read", path: "/home/agent/work/old.txt" })).output, /is a binary file \(10 bytes, sha256 [0-9a-f]{12}\)/);
    const big = randomBytes(3 * 1024 * 1024);
    await fake.writeFile(handle, "/home/agent/work/big.zip", big);
    const read = await files({ action: "read", path: "/home/agent/work/big.zip" });
    assert.match(read.output, /is a binary file \(3\.0 MB, sha256 of its first 200 KB [0-9a-f]{12}\)/);
  });

  it("an older host that answers text keeps working as before", async () => {
    const runtime = await import("../runner/agent-core/dist/work/index.js");
    const tools = runtime.computerTools({
      isHealthy: () => true,
      pageTakesPayment: () => false,
      currentUrl: () => "",
      screenEpoch: () => 0,
      screenshot: async () => SHOT,
      click: async () => SHOT,
      type: async () => SHOT,
      key: async () => SHOT,
      scroll: async () => SHOT,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      listFiles: async () => [],
      readFile: async () => "plain text",
      writeFile: async () => undefined,
    });
    const tool = tools.find((t) => t.spec.name === "computer_files")!;
    assert.equal((await tool.execute({ action: "read", path: "/home/agent/work/a.txt" }, { cwd: "/" })).output, "plain text");
  });
});
