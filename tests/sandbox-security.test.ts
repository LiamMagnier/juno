import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SANDBOX_ALLOW, buildSandboxDoc } from "../src/components/canvas/sandbox-frame";
import {
  SANDBOX_CODE_ORIGINS,
  SANDBOX_CONNECT_ORIGINS,
  SANDBOX_FLAGS,
  buildSandboxCsp,
  sandboxDirectives,
  type SandboxProfile,
} from "../src/lib/sandbox-policy";

/**
 * WHAT THIS TEST IS FOR, AFTER THE PREVIEW BECAME A PAGE AGAIN.
 *
 * It used to assert a narrow resource policy — `connect-src` pinned to one CDN,
 * `img-src data: blob:` — as though that list were the isolation. It is not,
 * and sandbox-frame.tsx now says so at length: the boundary is the iframe with
 * `sandbox` and NO `allow-same-origin`, which gives the document an opaque
 * origin, and a policy that lets a preview show a photograph from the web can
 * always be used to put a string in a URL. The old list broke every React
 * artifact (no `'unsafe-eval'`, which Babel needs) and every generated site's
 * images and webfonts, while head content injected before it loaded unpoliced
 * anyway.
 *
 * So this asserts the guarantees the code actually makes now:
 *
 *   1. the opaque origin, which is the whole boundary;
 *   2. the capabilities a preview never needs and an attack always does.
 *
 * It reads SANDBOX_ALLOW as a VALUE rather than grepping the file for
 * `sandbox="allow-scripts"`. The previous version matched on source text, so it
 * would have been satisfied by the words appearing in a comment and blind to
 * the attribute moving into a constant — which is exactly what happened.
 */

test("an artifact preview renders on an opaque origin", () => {
  // The one that matters. Without `allow-same-origin` the document cannot
  // reach the app's cookies, storage, DOM or session, whatever it loads.
  for (const [profile, flags] of Object.entries(SANDBOX_FLAGS)) {
    assert.doesNotMatch(flags, /allow-same-origin/, profile);
    assert.match(flags, /\ballow-scripts\b/, profile);
    // A popup would inherit the opaque origin and could not render the site it
    // was opened for, so external links are handed to the parent instead
    // (LINK_BRIDGE) and opened in a real tab.
    assert.doesNotMatch(flags, /allow-popups/, profile);
  }
  assert.equal(SANDBOX_ALLOW, SANDBOX_FLAGS.private);
  // A stranger's page on a public share gets no dialogs and hands out no files.
  assert.doesNotMatch(SANDBOX_FLAGS.public, /allow-modals|allow-downloads/);

  // And the attribute the component actually renders is that reviewed
  // constant — not a second, looser one added beside it.
  const source = readFileSync(
    new URL("../src/components/canvas/sandbox-frame.tsx", import.meta.url),
    "utf8",
  );
  const attributes = source.match(/sandbox=(?:\{[^}]*\}|"[^"]*")/g) ?? [];
  assert.deepEqual(attributes, ["sandbox={SANDBOX_FLAGS[profile]}"]);
});

test("no frame anywhere in the web app is given allow-same-origin", () => {
  // The Mermaid block and the Work site preview pass their own lists; this is
  // the line none of them may cross.
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = readFileSync(next, "utf8");
        if (/sandbox=(?:\{[^}]*|"[^"]*)allow-same-origin/.test(text) || /sandbox",\s*"[^"]*allow-same-origin/.test(text)) {
          offenders.push(next.pathname);
        }
      }
    }
  };
  walk(new URL("../src/", import.meta.url));
  assert.deepEqual(offenders, []);
});

test("an artifact preview gets no plugin, base-rewriting or form-posting capability", () => {
  const html = buildSandboxDoc(
    "HTML",
    `<img src="https://attacker.example/track.gif"><form action="https://attacker.example"></form>`,
  );
  assert.match(html, /Content-Security-Policy/);
  // Nothing is allowed that is not named.
  assert.match(html, /default-src 'none'/);
  // `base-uri`: rewriting every relative URL in the document at once.
  assert.match(html, /base-uri 'none'/);
  // `form-action`: the form above can be typed into and handled by the page's
  // own script, but cannot POST a password anywhere.
  assert.match(html, /form-action 'none'/);
  // `object-src`: plugin content, which no preview has ever needed.
  assert.match(html, /object-src 'none'/);
});

/*
 * THE EGRESS POLICY (src/lib/sandbox-policy.ts).
 *
 * Previews run scripts again, so what they can reach is a decision, written
 * down once and asserted here: code from an allowlist of CDNs, requests only to
 * the package CDNs, no form posts, and — on a public share, where the person at
 * the keyboard did not write the page — no images or frames from arbitrary
 * hosts either.
 */

const directivesOf = (profile: SandboxProfile) =>
  new Map(
    sandboxDirectives(profile).map((d) => {
      const [name, ...rest] = d.split(/\s+/);
      return [name, rest] as const;
    }),
  );

test("no profile lets a preview send a request to an arbitrary host", () => {
  for (const profile of ["private", "public", "static"] as const) {
    const d = directivesOf(profile);
    for (const name of ["script-src", "style-src", "font-src", "connect-src", "worker-src"]) {
      const sources = d.get(name) ?? [];
      assert.ok(sources.length > 0, `${profile}: ${name} is missing`);
      assert.ok(!sources.includes("https:") && !sources.includes("http:") && !sources.includes("*"), `${profile}: ${name} allows any host`);
    }
    // Requests go to the package CDNs and nowhere else (PyPI only for the
    // private Python console).
    for (const source of d.get("connect-src") ?? []) {
      if (source === "data:" || source === "blob:" || source === "'none'") continue;
      assert.ok(
        SANDBOX_CONNECT_ORIGINS.includes(source) || (profile === "private" && /pypi|pythonhosted/.test(source)),
        `${profile}: connect-src allows ${source}`,
      );
    }
    for (const source of d.get("script-src") ?? []) {
      if (source.startsWith("'") || source === "blob:") continue;
      assert.ok(SANDBOX_CODE_ORIGINS.includes(source), `${profile}: script-src allows ${source}`);
    }
    assert.deepEqual(d.get("form-action"), ["'none'"]);
    assert.deepEqual(d.get("base-uri"), ["'none'"]);
    assert.deepEqual(d.get("object-src"), ["'none'"]);
    assert.deepEqual(d.get("default-src"), ["'none'"]);
  }
});

test("a public share allows nothing from an arbitrary host at all", () => {
  for (const profile of ["public", "static"] as const) {
    const policy = sandboxDirectives(profile).join("; ");
    assert.doesNotMatch(policy, /(^|\s)https?:(\s|;|$)/, `${profile}: a scheme-wide source on a public page`);
    assert.deepEqual(directivesOf(profile).get("frame-src"), ["'none'"]);
  }
  // With scripted public previews off, a shared page's document runs nothing
  // and sends nothing.
  assert.deepEqual(directivesOf("static").get("script-src"), ["'none'"]);
  assert.deepEqual(directivesOf("static").get("connect-src"), ["'none'"]);
  // Your own previews keep photographs from the web — the documented trade.
  assert.ok(directivesOf("private").get("img-src")?.includes("https:"));
});

test("the shell's header repeats the isolation and says who may frame it", () => {
  for (const profile of ["private", "public"] as const) {
    const csp = buildSandboxCsp({ profile, frameAncestors: ["https://juno.example.test"] });
    assert.match(csp, /frame-ancestors https:\/\/juno\.example\.test(;|$)/);
    const sandbox = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("sandbox "));
    assert.ok(sandbox, `${profile}: no sandbox directive`);
    assert.doesNotMatch(sandbox, /allow-same-origin|allow-top-navigation/);
    assert.doesNotMatch(csp, /;;|\s;/);
  }
  // Nobody framing it at all is 'none', never an empty directive.
  assert.match(buildSandboxCsp({ profile: "public", frameAncestors: [] }), /frame-ancestors 'none'/);
});

test("each preview document carries its profile's policy as a meta, first in the head", () => {
  const html = buildSandboxDoc("HTML", "<html><head><script src=\"https://cdn.example/x.js\"></script></head><body></body></html>", null, "public");
  const meta = html.indexOf("Content-Security-Policy");
  assert.ok(meta !== -1 && meta < html.indexOf("cdn.example"), "author head content loaded before the policy");
  assert.match(html, /frame-src 'none'/);
});
