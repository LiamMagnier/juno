import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { GET as shellRoute } from "@/app/sandbox/v1/[profile]/route";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { SandboxProfileProvider } from "@/components/canvas/sandbox-document-frame";
import { buildCsp } from "@/lib/csp";
import { SANDBOX_SHELL_PATH, documentPolicyFor, sandboxShellUrl, type SandboxProfile } from "@/lib/sandbox-policy";

/**
 * AUDIT X-01: A PREVIEW MUST NOT INHERIT THE APP'S POLICY.
 *
 * From fb3a42b5 (26 Aug 2026) to this fix, every scripted preview on the web —
 * React, HTML, Tailwind, Mermaid, the console, public shares, Work sites — was
 * dead. The app sends an enforcing CSP with a per-request nonce and
 * `'strict-dynamic'`; the preview was an `<iframe srcdoc>`; and a srcdoc
 * document (like about:blank, blob: and data: ones) gets a CLONE of its
 * parent's policy container. An artifact's inline scripts carry no nonce, so
 * the browser refused all of them, and the preview's own meta policy could only
 * ever tighten that. A comment in the middleware said the frame was
 * "unaffected", and nothing checked.
 *
 * The frame now loads the preview shell by URL, and the shell's response
 * carries its own policy. These tests fail if any link in that chain breaks:
 *
 *   1. a frame goes back to srcdoc / blob: / data: (inheritance by construction);
 *   2. SandboxFrame stops loading the shell by URL;
 *   3. the middleware puts the app's nonce policy on the shell response;
 *   4. the shell's own policy stops allowing an artifact's inline scripts.
 *
 * tests/sandbox-origin-browser.test.ts proves the same end to end in Chromium.
 */

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Code only: comments are allowed to say "srcdoc" — this file's subject does. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("no frame in the web app is a srcdoc, blob: or data: document", () => {
  // Each of these inherits the embedding page's policy container (HTML spec,
  // "determining navigation params policy container"), so each would put a
  // preview back under the nonce policy.
  const inheriting = [
    { pattern: /\bsrcDoc\s*=/, what: "a srcDoc attribute" },
    { pattern: /\.srcdoc\s*=/, what: "an assignment to .srcdoc" },
    { pattern: /setAttribute\(\s*["']srcdoc["']/, what: "setAttribute('srcdoc')" },
    { pattern: /<iframe[^>]*\bsrc=\{[^}]*createObjectURL/, what: "an iframe src from createObjectURL" },
    { pattern: /<iframe[^>]*\bsrc=["'{`]+data:/, what: "an iframe src with a data: URL" },
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const { pattern, what } of inheriting) {
      if (pattern.test(code)) offenders.push(`${path.relative(ROOT, file)}: ${what}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These frames inherit the app's Content-Security-Policy, whose nonce blocks every inline script in them.\n" +
      "Render previews through SandboxDocumentFrame (src/components/canvas/sandbox-document-frame.tsx) instead:\n  " +
      offenders.join("\n  ")
  );
});

/** The attributes of the one iframe in a server-rendered tree. */
function iframeAttributes(element: React.ReactElement): Map<string, string> {
  const html = renderToStaticMarkup(element);
  const tag = /<iframe\b([^>]*)>/.exec(html);
  assert.ok(tag, `expected an iframe, rendered: ${html.slice(0, 200)}`);
  const attrs = new Map<string, string>();
  for (const m of tag[1].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs.set(m[1].toLowerCase(), m[2] ?? "");
  return attrs;
}

test("SandboxFrame is an opaque-origin frame that loads nothing until it can listen", () => {
  const attrs = iframeAttributes(React.createElement(SandboxFrame, { type: "HTML", content: "<p>hello</p>" }));
  assert.equal(attrs.has("srcdoc"), false, "a srcdoc frame inherits the app policy");
  // Server-rendered with no src: a shell in the HTML would say "ready" before
  // React hydrated, and never be answered (the browser test covers this).
  assert.equal(attrs.has("src"), false, "the frame starts loading before the page can answer it");
  assert.match(attrs.get("sandbox") ?? "", /\ballow-scripts\b/);
  assert.doesNotMatch(attrs.get("sandbox") ?? "", /allow-same-origin/);

  // Once armed, the src is the shell URL for the profile — by URL, never a
  // local scheme.
  const source = stripComments(
    readFileSync(path.join(ROOT, "src/components/canvas/sandbox-document-frame.tsx"), "utf8")
  );
  assert.match(source, /src=\{armed \? sandboxShellUrl\(effectiveProfile\) : undefined\}/);
  assert.equal(sandboxShellUrl("private", null), `${SANDBOX_SHELL_PATH}/private`);
  assert.equal(sandboxShellUrl("public", "https://preview.example.test"), `https://preview.example.test${SANDBOX_SHELL_PATH}/public`);
});

test("a preview inside a public share takes the public profile", () => {
  const attrs = iframeAttributes(
    React.createElement(
      SandboxProfileProvider as React.FC<{ profile: SandboxProfile; children?: React.ReactNode }>,
      { profile: "public" },
      React.createElement(SandboxFrame, { type: "HTML", content: "<p>hello</p>" })
    )
  );
  // No dialogs or downloads from a stranger's page.
  assert.equal(attrs.get("sandbox"), "allow-scripts allow-forms allow-pointer-lock");
});

/** What the real middleware does to a document request. */
function throughMiddleware(url: string, host = new URL(url).host) {
  const res = middleware(new NextRequest(url, { headers: { host } }));
  return { status: res.status, csp: res.headers.get("content-security-policy") };
}

test("the middleware sends the app's nonce policy on app pages and NOT on the preview shell", () => {
  const app = throughMiddleware("http://localhost:3000/share/abcdefghijklmnopqrstuvwxyz012345");
  assert.match(app.csp ?? "", /'nonce-[^']+'/);
  assert.match(app.csp ?? "", /'strict-dynamic'/);

  for (const profile of ["private", "public"] as const) {
    const shell = throughMiddleware(`http://localhost:3000${SANDBOX_SHELL_PATH}/${profile}`);
    assert.equal(shell.status, 200);
    assert.equal(
      shell.csp,
      null,
      "the middleware put a policy on the preview shell; two policies both apply, so the nonce one would block every artifact script again"
    );
  }
});

test("with a separate preview origin, each host serves only its own half", () => {
  const sandboxOrigin = "https://preview.example.test";
  const decide = (pathname: string, host: string) => documentPolicyFor({ pathname, host, sandboxOrigin });
  assert.equal(decide("/sandbox/v1/private", "preview.example.test"), "sandbox");
  // No second copy of the app — or its sign-in page — on the preview host.
  assert.equal(decide("/", "preview.example.test"), "not-found");
  assert.equal(decide("/api/share", "preview.example.test"), "not-found");
  assert.equal(decide("/sign-in", "preview.example.test"), "not-found");
  // And the app host stops serving the shell.
  assert.equal(decide("/sandbox/v1/private", "juno.example.test"), "not-found");
  assert.equal(decide("/chat", "juno.example.test"), "app");

  // The app's own policy must let its frames load from there.
  const csp = buildCsp({ nonce: "n", sandboxOrigin });
  assert.match(csp, /frame-src 'self' blob: https:\/\/preview\.example\.test(;|$)/);
});

async function shellResponse(profile: string): Promise<Response> {
  return shellRoute(new Request(`http://localhost:3000${SANDBOX_SHELL_PATH}/${profile}`), {
    params: Promise.resolve({ profile }),
  });
}

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();

test("the shell's own policy lets an artifact's inline scripts run, and inherits nothing", async () => {
  for (const profile of ["private", "public"]) {
    const res = await shellResponse(profile);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.doesNotMatch(csp, /'nonce-/, `${profile}: a nonce here blocks every inline artifact script`);
    assert.doesNotMatch(csp, /'strict-dynamic'/, `${profile}: strict-dynamic discards 'unsafe-inline'`);
    const scripts = directive(csp, "script-src") ?? "";
    assert.match(scripts, /'unsafe-inline'/, `${profile}: artifacts are inline scripts`);
    assert.match(scripts, /'unsafe-eval'/, `${profile}: the React runtime evaluates Babel output`);
    // The isolation, repeated on the response so a top-level visit gets it too.
    const sandbox = directive(csp, "sandbox") ?? "";
    assert.match(sandbox, /\ballow-scripts\b/);
    assert.doesNotMatch(sandbox, /allow-same-origin|allow-top-navigation/);
    assert.equal(directive(csp, "frame-ancestors"), "'self'");
    // And it is a document, not something to sniff.
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const body = await res.text();
    assert.match(body, /juno:sandbox-render/);
  }
});

test("an unknown profile is not a shell", async () => {
  assert.equal((await shellResponse("admin")).status, 404);
});
