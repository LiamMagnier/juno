import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SANDBOX_ALLOW, buildSandboxDoc } from "../src/components/canvas/sandbox-frame";

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
  assert.doesNotMatch(SANDBOX_ALLOW, /allow-same-origin/);
  assert.match(SANDBOX_ALLOW, /\ballow-scripts\b/);
  // A popup would inherit the opaque origin and could not render the site it
  // was opened for, so external links are handed to the parent instead
  // (LINK_BRIDGE) and opened in a real tab.
  assert.doesNotMatch(SANDBOX_ALLOW, /allow-popups/);

  // And the attribute the component actually renders is that reviewed
  // constant — not a second, looser one added beside it.
  const source = readFileSync(
    new URL("../src/components/canvas/sandbox-frame.tsx", import.meta.url),
    "utf8",
  );
  const attributes = source.match(/sandbox=(?:\{[^}]*\}|"[^"]*")/g) ?? [];
  assert.deepEqual(attributes, ["sandbox={SANDBOX_ALLOW}"]);
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
