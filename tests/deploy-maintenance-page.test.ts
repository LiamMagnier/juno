import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The "Updating, back in a moment" page (deploy/maintenance/updating.html)
 * and how deploy/nginx.conf.template serves it: to page navigations only,
 * for errors nginx itself produced, never to /api/*.
 *
 * nginx is not installed on CI, so these are structural checks. The template
 * was also run under real nginx (nginx -t, and every case below against a
 * scripted upstream); that harness lives with the R3 evidence, not here.
 */

const template = readFileSync(new URL("../deploy/nginx.conf.template", import.meta.url), "utf8");
const page = readFileSync(new URL("../deploy/maintenance/updating.html", import.meta.url), "utf8");

/** The directives inside `<header> { … }`, comments and blank lines dropped, braces matched. */
function block(source: string, header: string, from = 0): string[] {
  const start = source.indexOf(header, from);
  assert.ok(start > -1, `missing: ${header}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  return source
    .slice(open + 1, end)
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/** The live (uncommented) part of the template. */
const live = template
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
/** Where the HTTPS server starts: its `location /` is the app's (the port-80 one only redirects). */
const https = live.indexOf("listen 443 ssl");

test("/api/* proxies exactly like the pages and never gets the page", () => {
  const api = block(live, "location /api/ {");
  const pages = block(live, "location / {", https);
  assert.ok(!api.some((d) => d.startsWith("error_page")), "no error page for the API");
  const withoutErrorPage = pages.filter((d) => !d.startsWith("error_page"));
  assert.deepEqual([...api].sort(), [...withoutErrorPage].sort(), "the two blocks must stay in step");
  assert.ok(api.includes("proxy_pass http://127.0.0.1:3000;"));
  assert.ok(api.includes("proxy_read_timeout 3600s;"), "the SSE ceiling holds for the chat stream");
});

test("only nginx's own errors are replaced, and only for page navigations", () => {
  assert.ok(!/proxy_intercept_errors\s+on/.test(live), "an error the app wrote always passes through as written");
  const pages = block(live, "location / {", https);
  assert.ok(pages.includes("error_page 502 503 504 =503 $juno_unavailable;"));
  for (const other of ["location /_next/static/ {", "location /voice-relay {"]) {
    assert.ok(!block(live, other).some((d) => d.startsWith("error_page")), other);
  }
  const nav = block(live, 'map "$request_method:$http_sec_fetch_mode:$http_rsc:$http_accept" $juno_page_navigation {');
  assert.deepEqual(nav, [
    "default                          0;",
    '"~^(GET|HEAD):navigate::"        1;',
    '"~^(GET|HEAD):::[^:]*text/html"  1;',
  ]);
  const target = block(live, "map $juno_page_navigation $juno_unavailable {");
  assert.deepEqual(target, ["1        /__juno_updating;", "default  @juno_bad_gateway;"]);
});

test("the page location is internal, uncached, and falls back to the plain 502", () => {
  const updating = block(live, "location = /__juno_updating {");
  assert.ok(updating.includes("internal;"));
  assert.ok(updating.includes("root /var/www/juno-maintenance;"));
  assert.ok(updating.includes('add_header Cache-Control "no-store" always;'));
  assert.ok(updating.some((d) => /^add_header Retry-After "\d+" always;$/.test(d)));
  assert.ok(updating.some((d) => d.startsWith("add_header Content-Security-Policy \"default-src 'none';")));
  assert.ok(updating.includes("try_files /updating.html @juno_bad_gateway;"), "not installed: as before");
  assert.deepEqual(block(live, "location @juno_bad_gateway {"), ["return 502;"]);
  // The install step the template names is the path it serves.
  assert.ok(template.includes("sudo install -D -m 644 deploy/maintenance/updating.html /var/www/juno-maintenance/updating.html"));
  const guide = readFileSync(new URL("../deploy/VM_SETUP_GUIDE.md", import.meta.url), "utf8");
  assert.ok(guide.includes("deploy/maintenance/updating.html /var/www/juno-maintenance/updating.html"));
});

test("the page is small, static, self-contained and reloads itself shortly", () => {
  assert.ok(Buffer.byteLength(page) < 8_192, `${Buffer.byteLength(page)} bytes`);
  const refresh = page.match(/<meta http-equiv="refresh" content="(\d+)">/);
  assert.ok(refresh, "a meta refresh, so no script is needed");
  const seconds = Number(refresh[1]);
  assert.ok(seconds >= 3 && seconds <= 15, `${seconds}s`);
  const retryAfter = Number(block(live, "location = /__juno_updating {").find((d) => d.startsWith("add_header Retry-After"))?.match(/"(\d+)"/)?.[1]);
  assert.equal(retryAfter, seconds, "the header and the page agree on when to come back");
  assert.ok(!/<script/i.test(page), "no scripts: the page's own CSP forbids them");
  assert.ok(!/(src|href)="(https?:)?\/\//i.test(page), "no external requests: nothing may depend on what is down");
  assert.ok(!/<link\b/i.test(page));
  assert.ok(page.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(page.includes("@media (prefers-color-scheme: dark)"), "both colour schemes");
  assert.ok(page.includes('<meta name="robots" content="noindex">'));
  assert.ok(page.includes('<html lang="en">'));
});

test("the page's words are true and use the product's name", () => {
  const visible = page.replace(/<!--[\s\S]*?-->/g, "").replace(/<style>[\s\S]*?<\/style>/, "");
  assert.ok(visible.includes("Updating, back in a moment"));
  assert.ok(visible.includes("Alevr"));
  assert.ok(!/\bJuno\b/.test(visible), "the codename never reaches a reader");
  // It never claims more than nginx knows: the app is not answering, most
  // often because of an update.
  assert.ok(visible.includes("usually because an update is being installed"));
  assert.ok(!/will be back in \d|\bdown for maintenance until\b/i.test(visible), "no promised time");
});
