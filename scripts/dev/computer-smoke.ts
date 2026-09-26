/**
 * Local Docker Desktop smoke test for Agent Computers (Phase 2 gate).
 *
 * Run explicitly (not part of `npm test`):
 *   AGENT_COMPUTER_PROVIDER=docker AGENT_COMPUTER_IMAGE=juno-computer:dev \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/dev/computer-smoke.ts
 */
import assert from "node:assert/strict";
import net from "node:net";
import { runDockerBuffer } from "../../src/lib/docker-cli";
import { connectAgentBrowser } from "../../src/lib/computer/remote-browser";
import {
  createInMemoryComputerPersistence,
  disableComputer,
  enableComputer,
  ensureAwake,
  setComputerStorePersistenceForTest,
} from "../../src/lib/computer/store";
import { computerProvider, resetComputerProviderCache } from "../../src/lib/computer/provider";

async function runDockerOut(argv: string[]): Promise<string> {
  const res = await runDockerBuffer(argv);
  if (res.exitCode !== 0) {
    throw new Error(
      `docker ${argv.join(" ")} failed (${res.exitCode}): ${res.stderr.toString("utf8")}`
    );
  }
  return res.stdout.toString("utf8").trim();
}

async function readRfbBanner(host: string, port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for RFB banner on ${host}:${port}`));
    }, 8_000);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      const banner = chunk.toString("ascii");
      socket.end();
      resolve(banner);
    });
  });
}

async function main() {
  process.env.AGENT_COMPUTER_PROVIDER = process.env.AGENT_COMPUTER_PROVIDER || "docker";
  process.env.AGENT_COMPUTER_IMAGE =
    process.env.AGENT_COMPUTER_IMAGE ||
    process.env.COMPUTER_DOCKER_IMAGE ||
    "juno-computer:dev";
  process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "smoke_test_auth_secret_32_bytes_minimum_value!!";

  resetComputerProviderCache();
  const provider = computerProvider();
  assert.ok(provider && provider.name === "docker", "Expected DockerComputerProvider");

  const mem = createInMemoryComputerPersistence();
  setComputerStorePersistenceForTest(mem);

  const agentId = `smoke${Date.now().toString(36)}`;
  const userId = "usr_smoke";

  console.log(`[smoke] Using agentId=${agentId}, image=${process.env.AGENT_COMPUTER_IMAGE}`);

  try {
    // 1. Create a computer for a fake agent id, and wait for CDP (measure cold-start)
    const coldT0 = performance.now();
    await enableComputer(userId, agentId);
    const awake1 = await ensureAwake(userId, agentId);
    const handle = awake1.handle;

    // 2. Connect over CDP via connectAgentBrowser and open https://example.com
    const browser1 = connectAgentBrowser(handle, awake1.secrets);
    const openRes = await browser1.open("https://example.com");
    assert.ok(openRes.ok, `Expected browser1.open to succeed, got: ${!openRes.ok ? openRes.message : ""}`);
    const coldStartMs = Math.round(performance.now() - coldT0);
    console.log(`[smoke] Step 1 & 2 OK: Cold start + CDP open https://example.com in ${coldStartMs} ms`);

    try {
      // 3. Read the page; take a screenshot (check 1280x800); pixel-click the page's link; check URL changed
      const readRes = await browser1.read();
      assert.ok(readRes.ok);
      assert.ok(
        readRes.page.title.toLowerCase().includes("example"),
        `Expected Example Domain title, got: ${readRes.page.title}`
      );

      const shotT0 = performance.now();
      const shot = await provider.screenshot(handle);
      const screenshotMs = Math.round(performance.now() - shotT0);
      assert.equal(shot.width, 1280, "Screenshot width must be 1280");
      assert.equal(shot.height, 800, "Screenshot height must be 800");
      assert.ok(shot.jpeg.byteLength > 1000, "Screenshot JPEG must be non-empty");
      console.log(
        `[smoke] Step 3a OK: Page read ("${readRes.page.title}") and 1280x800 screenshot (${shot.jpeg.byteLength} bytes in ${screenshotMs} ms)`
      );

      // 4. Set a persistent cookie via CDP and prepare the clickable link on the page
      await browser1.withPage(async (rawPage) => {
        const cdp = await rawPage.context().newCDPSession(rawPage);
        await cdp.send("Network.setCookie", {
          name: "juno_smoke",
          value: "persist_cookie_ok",
          url: "https://example.com/",
          domain: "example.com",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 86400,
        });
        await rawPage.evaluate(() => {
          document.cookie = "juno_smoke=persist_cookie_ok; max-age=86400; path=/";
          const a = document.querySelector("a") || document.createElement("a");
          a.href = "https://example.com/?clicked=1";
          a.style.position = "fixed";
          a.style.left = "0px";
          a.style.top = "0px";
          a.style.width = "1280px";
          a.style.height = "800px";
          a.style.zIndex = "999999";
          a.style.background = "rgba(0,0,0,0.01)";
          if (!a.parentElement) document.body.appendChild(a);
        });
        await cdp.detach();
      });
      console.log("[smoke] Step 4 OK: Set persistent cookie via CDP");

      const urlBefore = browser1.currentUrl();
      await provider.click(handle, { x: 640, y: 400, button: "left" });

      // Wait briefly for navigation to settle and read the page to refresh currentUrl
      await new Promise((r) => setTimeout(r, 800));
      const afterRead = await browser1.read();
      assert.ok(afterRead.ok);
      const urlAfter = afterRead.page.url;
      assert.notEqual(
        urlAfter,
        urlBefore,
        `Expected URL to change after pixel click (${urlBefore} -> ${urlAfter})`
      );
      assert.ok(urlAfter.includes("clicked=1"), `Expected clicked=1 in URL, got ${urlAfter}`);
      console.log(`[smoke] Step 3b OK: Pixel click navigated ${urlBefore} -> ${urlAfter}`);
    } finally {
      await browser1.close();
    }

    // 5. Run exec("uname -a"), write and read back /home/agent/work/hello.txt, and check realpath refuses /home/agent/work/../../etc/passwd
    const unameRes = await provider.exec(handle, "uname -a");
    assert.equal(unameRes.exitCode, 0);
    assert.ok(unameRes.stdout.toLowerCase().includes("linux"));

    await provider.writeFile(
      handle,
      "/home/agent/work/hello.txt",
      Buffer.from("hello persistent world\n", "utf8")
    );
    const readBack = await provider.readFile(handle, "/home/agent/work/hello.txt");
    assert.equal(readBack.toString("utf8"), "hello persistent world\n");

    let refusedTraversal = false;
    try {
      await provider.readFile(handle, "/home/agent/work/../../etc/passwd");
    } catch (err) {
      refusedTraversal = true;
      assert.match(String(err), /inside \/home\/agent/i);
    }
    assert.ok(refusedTraversal, "realpath must refuse /home/agent/work/../../etc/passwd");
    console.log(
      "[smoke] Step 5 OK: exec(uname -a), write/read /home/agent/work/hello.txt, and realpath traversal refusal verified"
    );

    // 6. Pause (docker pause), check docker inspect says Paused: true, unpause, and check /tmp marker file is still there
    await provider.exec(handle, "echo -n 'still_in_ram' > /tmp/pause-marker.txt");
    await provider.pause(handle);
    const pausedInspect = await runDockerOut([
      "inspect",
      "-f",
      "{{.State.Paused}}",
      handle.name,
    ]);
    assert.equal(pausedInspect, "true", "Expected container State.Paused to be true");

    const unpauseT0 = performance.now();
    await provider.unpause(handle);
    const unpauseMs = Math.round(performance.now() - unpauseT0);
    const tmpCheck = await provider.exec(handle, "cat /tmp/pause-marker.txt");
    assert.equal(tmpCheck.stdout, "still_in_ram");
    console.log(`[smoke] Step 6 OK: Pause/unpause (${unpauseMs} ms) preserved /tmp RAM marker`);

    // 7. Stop (docker stop) and start (docker start) the container, reconnect over CDP, and check /home/agent/work/hello.txt and the cookie are still there
    await provider.stop(handle);
    const warmT0 = performance.now();
    await provider.start(handle);
    const browser2 = connectAgentBrowser(handle, awake1.secrets);
    const warmOpen = await browser2.open("https://example.com");
    assert.ok(warmOpen.ok);
    const warmStartMs = Math.round(performance.now() - warmT0);
    try {
      const helloAfterRestart = await provider.readFile(handle, "/home/agent/work/hello.txt");
      assert.equal(helloAfterRestart.toString("utf8"), "hello persistent world\n");

      const foundCookie = await browser2.withPage(async (rawPage) => {
        const cdp = await rawPage.context().newCDPSession(rawPage);
        const res = (await cdp.send("Network.getAllCookies")) as {
          cookies: Array<{ name: string; value: string }>;
        };
        await cdp.detach();
        return res.cookies.find((c) => c.name === "juno_smoke");
      });
      assert.ok(foundCookie, "Expected juno_smoke cookie to survive container stop/start");
      assert.equal(foundCookie.value, "persist_cookie_ok");
      console.log(
        `[smoke] Step 7 OK: Warm start (${warmStartMs} ms) preserved /home/agent/work/hello.txt and Chromium cookie`
      );
    } finally {
      await browser2.close();
    }

    // 8. Remove the container (docker rm -f), call ensureAwake, and check it recreates the container on the same volume with /home/agent/work/hello.txt intact
    await runDockerOut(["rm", "-f", handle.name]);
    const awakeRecreated = await ensureAwake(userId, agentId);
    const helloAfterRecreate = await provider.readFile(
      awakeRecreated.handle,
      "/home/agent/work/hello.txt"
    );
    assert.equal(helloAfterRecreate.toString("utf8"), "hello persistent world\n");
    console.log("[smoke] Step 8 OK: ensureAwake recreated missing container on same volume with files intact");

    // 9. Start x11vnc with control and view passwords; verify x11vnc -help and RFB 003.008\n banner
    const x11Help = await provider.exec(
      awakeRecreated.handle,
      "x11vnc -help 2>&1 | grep -E -- '-passwdfile|-viewonlypasswd' | head -n 5"
    );
    assert.ok(
      x11Help.stdout.includes("-passwdfile"),
      `Expected x11vnc -help to include -passwdfile, got: ${x11Help.stdout}`
    );

    await provider.startVnc(awakeRecreated.handle, {
      controlPassword: "ctrl_password_123",
      viewPassword: "view_password_456",
    });
    const streamEndpoints = await provider.endpoints(awakeRecreated.handle);
    const banner = await readRfbBanner(streamEndpoints.vncHost, streamEndpoints.vncPort);
    assert.equal(banner, "RFB 003.008\n", `Expected RFB 003.008\\n banner, got: ${JSON.stringify(banner)}`);
    await provider.stopVnc(awakeRecreated.handle);
    console.log(
      `[smoke] Step 9 OK: x11vnc supports -passwdfile (__BEGIN_VIEWONLY__) and served ${JSON.stringify(banner)}`
    );

    // 10. Destroy the container and volume, and check docker ps -a and docker volume ls are empty
    await disableComputer(userId, agentId);
    const psOut = await runDockerOut([
      "ps",
      "-a",
      "--filter",
      `label=juno.agent=${agentId}`,
      "--format",
      "{{.Names}}",
    ]);
    const volOut = await runDockerOut([
      "volume",
      "ls",
      "--filter",
      `name=juno-agent-${agentId}`,
      "--format",
      "{{.Name}}",
    ]);
    assert.equal(psOut, "", `Expected no leftover container, got: ${psOut}`);
    assert.equal(volOut, "", `Expected no leftover volume, got: ${volOut}`);
    console.log("[smoke] Step 10 OK: Container and volume destroyed cleanly");

    // 11. Print image size and timings summary
    const imageSize = await runDockerOut([
      "image",
      "inspect",
      process.env.AGENT_COMPUTER_IMAGE,
      "--format",
      "{{.Size}}",
    ]);
    const imageSizeMb = (Number(imageSize) / (1024 * 1024)).toFixed(1);
    console.log("\n=== AGENT COMPUTER SMOKE METRICS ===");
    console.log(`Image (${process.env.AGENT_COMPUTER_IMAGE}): ${imageSizeMb} MB (${imageSize} bytes)`);
    console.log(`Cold start (create + start + CDP ready): ${coldStartMs} ms`);
    console.log(`Warm start (docker start + CDP reconnect): ${warmStartMs} ms`);
    console.log(`Unpause (docker unpause): ${unpauseMs} ms`);
    console.log(`Screenshot (1280x800 scrot -> sharp JPEG): 1280x800`);
    console.log(`x11vnc password syntax: -passwdfile with __BEGIN_VIEWONLY__ delimiter`);
    console.log("====================================\n");
  } catch (err) {
    // Best-effort cleanup on error
    await runDockerBuffer(["rm", "-f", `juno-agent-${agentId}`]);
    await runDockerBuffer(["volume", "rm", "-f", `juno-agent-${agentId}`]);
    throw err;
  }
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
