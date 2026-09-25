import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIGNED_URL_ASSUMED_LIFETIME_MS,
  SIGNED_URL_MIN_REMAINING_MS,
  SIGNED_URL_REUSE_MS,
  buildDownloadFeed,
  resetDownloadFeedCache,
} from "@/lib/download-feed";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { downloadHref, downloadLink, isUpdaterDownloadUrl, type AppDownload } from "@/lib/app-downloads";
import { GET as feedRoute } from "../src/app/api/downloads/route";
import { GET as redirectRoute } from "../src/app/download/[platform]/route";
import DownloadPage from "../src/app/download/page";

/*
 * The release feed against a scripted GitHub.
 *
 * LiamMagnier/juno went private, and the feed read it anonymously: GitHub
 * answered 404, /api/downloads said "Not published yet", and no installed Mac
 * app ever saw another update. These tests pin the repair — a read-only token
 * lists the releases, a private asset goes out as the signed URL GitHub
 * redirects its API download to, and nothing about that URL can be served
 * after it has died — and that with no token nothing changed at all.
 */

const REPO = "LiamMagnier/juno";
const TOKEN = "github_pat_test_only";
const DIGEST = "ab".repeat(32);
const DMG_ID = 544640518;
const MANIFEST_ID = 544640521;
const T0 = Date.parse("2026-09-22T20:47:06Z");

function release(version: string, opts: { prerelease?: boolean; draft?: boolean; idOffset?: number } = {}) {
  const offset = opts.idOffset ?? 0;
  const asset = (id: number, name: string, extra: Record<string, unknown>) => ({
    id,
    name,
    browser_download_url: `https://github.com/${REPO}/releases/download/v${version}/${name}`,
    ...extra,
  });
  return {
    tag_name: `v${version}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: "2026-09-20T00:00:00Z",
    assets: [
      asset(DMG_ID + offset, `Juno-${version}.dmg`, { size: 23_958_367, digest: `sha256:${DIGEST}` }),
      asset(MANIFEST_ID + offset, `Juno-${version}.release.json`, { size: 854 }),
    ],
  };
}

const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** GitHub's signed-asset shape, with the clocks under the test's control. */
function signedUrl(assetId: string, issuedAt: number, jwtSeconds: number, sasSeconds = 3_000): string {
  const jwt = [b64u({ typ: "JWT", alg: "HS256" }), b64u({ exp: Math.floor(issuedAt / 1000) + jwtSeconds }), "c2ln"].join(".");
  const se = new Date(issuedAt + sasSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `https://release-assets.githubusercontent.com/github-production-release-asset/1/${assetId}-5a1d` +
    `?sp=r&sv=2018-11-09&sr=b&spr=https&se=${encodeURIComponent(se)}` +
    `&rscd=attachment%3B+filename%3DJuno.dmg&rsct=application%2Foctet-stream&sig=c2ln%2Bsig%3D&jwt=${jwt}` +
    `&response-content-disposition=attachment%3B%20filename%3DJuno.dmg`
  );
}

interface Call {
  url: string;
  /** Next's typing of RequestInit already carries `next: { revalidate }`. */
  init: RequestInit;
  authorization: string | null;
}

interface FakeGitHub {
  calls: Call[];
  /** Asset API requests that asked for the Location rather than the bytes. */
  signings(): Call[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let clock = T0;
const now = () => clock;
const realFetch = globalThis.fetch;

/**
 * A GitHub that knows one repository, answers anonymous callers only when it
 * is public, refuses a wrong token with 401 the way GitHub does, and redirects
 * an asset download to a signed URL when asked not to follow.
 */
function installGitHub(opts: {
  isPrivate: boolean;
  releases?: unknown[];
  manifest?: string | null;
  location?: (assetId: string) => string;
  repoLookup?: "ok" | "fail";
  jwtSeconds?: number;
}): FakeGitHub {
  const calls: Call[] = [];
  const releases = opts.releases ?? [release("1.5.4")];
  const manifest = opts.manifest === undefined ? JSON.stringify({ version: "1.5.4", notarized: true }) : opts.manifest;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const authorization = new Headers(init.headers).get("authorization");
    calls.push({ url, init, authorization });
    if (authorization && authorization !== `Bearer ${TOKEN}`) return json({ message: "Bad credentials" }, 401);
    const visible = !opts.isPrivate || authorization === `Bearer ${TOKEN}`;

    if (url.startsWith(`https://api.github.com/repos/${REPO}/releases?`)) {
      return visible ? json(releases) : json({ message: "Not Found" }, 404);
    }
    if (url === `https://api.github.com/repos/${REPO}`) {
      if (opts.repoLookup === "fail") return json({ message: "Server Error" }, 500);
      return visible ? json({ full_name: REPO, private: opts.isPrivate }) : json({ message: "Not Found" }, 404);
    }
    const assetMatch = /^https:\/\/api\.github\.com\/repos\/LiamMagnier\/juno\/releases\/assets\/(\d+)$/.exec(url);
    if (assetMatch) {
      if (!visible) return json({ message: "Not Found" }, 404);
      if (init.redirect === "manual") {
        const location = opts.location?.(assetMatch[1]) ?? signedUrl(assetMatch[1], clock, opts.jwtSeconds ?? 1_800);
        return new Response(null, { status: 302, headers: { location } });
      }
      // Followed: what arrives is the asset's bytes. Only the manifest is ever read this way.
      return manifest === null ? new Response("", { status: 500 }) : new Response(manifest, { status: 200 });
    }
    if (url.startsWith(`https://github.com/${REPO}/releases/download/`)) {
      if (opts.isPrivate) return new Response("Not Found", { status: 404 });
      return manifest === null ? new Response("", { status: 404 }) : new Response(manifest, { status: 200 });
    }
    // The Windows repository does not exist.
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return {
    calls,
    signings: () => calls.filter((call) => /\/releases\/assets\/\d+$/.test(call.url) && call.init.redirect === "manual"),
  };
}

const mac = (downloads: AppDownload[]) => {
  const row = downloads.find((download) => download.platform === "macos");
  assert.ok(row, "the feed always carries a macOS row");
  return row;
};

beforeEach(() => {
  clock = T0;
  resetDownloadFeedCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JUNO_RELEASES_GITHUB_TOKEN;
});

/* ── No credential: exactly the old feed ─────────────────────────────────── */

test("without a token a public repository is read anonymously and keeps its github.com links", async () => {
  const github = installGitHub({ isPrivate: false });
  const row = mac(await buildDownloadFeed({ token: null, now }));

  assert.equal(row.available, true);
  assert.equal(row.url, `https://github.com/${REPO}/releases/download/v1.5.4/Juno-1.5.4.dmg`);
  assert.equal(row.urlExpiresAt, null);
  assert.equal(row.version, "1.5.4");
  assert.equal(row.size, 23_958_367);
  assert.equal(row.sha256, DIGEST);
  assert.equal(row.notarized, true);

  // The same three requests as ever, none of them carrying a credential: the
  // two listings and the manifest by its public URL. No visibility lookup and
  // no asset API call.
  assert.deepEqual(
    github.calls.map((call) => call.url.replace(/\?.*$/, "")),
    [
      `https://api.github.com/repos/${REPO}/releases`,
      "https://api.github.com/repos/LiamMagnier/juno-windows/releases",
      `https://github.com/${REPO}/releases/download/v1.5.4/Juno-1.5.4.release.json`,
    ],
  );
  assert.ok(github.calls.every((call) => call.authorization === null));
  const listing = github.calls[0];
  assert.deepEqual(listing.init.headers, { accept: "application/vnd.github+json", "user-agent": "juno-downloads" });
  assert.deepEqual(listing.init.next, { revalidate: 60 });
});

test("without a token a private repository is still reported as not published", async () => {
  installGitHub({ isPrivate: true });
  const row = mac(await buildDownloadFeed({ token: null, now }));
  assert.equal(row.available, false);
  assert.equal(row.url, null);
  assert.equal(row.note, "Not published yet");
  assert.equal(row.notarized, null);
});

test("the token is read from JUNO_RELEASES_GITHUB_TOKEN, and an empty one is no token", async () => {
  process.env.JUNO_RELEASES_GITHUB_TOKEN = "   ";
  let github = installGitHub({ isPrivate: true });
  assert.equal(mac(await buildDownloadFeed({ now })).available, false);
  assert.ok(github.calls.every((call) => call.authorization === null));

  process.env.JUNO_RELEASES_GITHUB_TOKEN = TOKEN;
  github = installGitHub({ isPrivate: true });
  assert.equal(mac(await buildDownloadFeed({ now })).available, true);
  assert.equal(github.calls[0].authorization, `Bearer ${TOKEN}`);
});

/* ── A private repository with a token ───────────────────────────────────── */

test("a private release is listed with the token and handed out as its signed URL", async () => {
  const github = installGitHub({ isPrivate: true });
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));

  assert.equal(row.available, true);
  assert.equal(row.version, "1.5.4");
  // What an installed app compares after downloading: straight from the listing.
  assert.equal(row.size, 23_958_367);
  assert.equal(row.sha256, DIGEST);
  assert.equal(row.notarized, true);

  // The URL is the Location GitHub redirected the API download to, untouched.
  assert.equal(row.url, signedUrl(String(DMG_ID), T0, 1_800));
  assert.ok(row.url && isUpdaterDownloadUrl(row.url), "a URL the v1.5.4 updater's allow-list accepts");
  // The earlier of the two clocks the URL carries: the JWT's 30 minutes, not the SAS's 50.
  assert.equal(row.urlExpiresAt, new Date(T0 + 1_800_000).toISOString());

  const [signing] = github.signings();
  assert.equal(signing.url, `https://api.github.com/repos/${REPO}/releases/assets/${DMG_ID}`);
  assert.equal(signing.authorization, `Bearer ${TOKEN}`);
  assert.equal(new Headers(signing.init.headers).get("accept"), "application/octet-stream");
  // Never through Next's data cache, which would serve a stale entry once more
  // after its window — a dead link, for a signed URL.
  assert.equal(signing.init.cache, "no-store");
  assert.equal(signing.init.next, undefined);
});

test("the feed answers when the fetch it runs under keeps a clone of every response, as Next's does", async () => {
  // Next's server fetch hands the caller a response it has already cloned and
  // keeps the clone. Cancelling the caller's body then only settles once the
  // clone is cancelled too, which never happens — so a feed that awaited
  // `body.cancel()` on the signing redirect hung for every visitor in
  // production while it passed here, where fetch was never wrapped.
  installGitHub({ isPrivate: true });
  const github = globalThis.fetch;
  const kept: Response[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    let response = await github(input, init);
    // GitHub's real 302 carries a short body; an empty one would hide the bug.
    if (response.status === 302 && response.body === null) {
      response = new Response("Found. Redirecting to the signed URL.", { status: 302, headers: response.headers });
    }
    kept.push(response.clone());
    return response;
  }) as typeof fetch;

  const settled = await Promise.race([
    buildDownloadFeed({ token: TOKEN, now }).then(mac),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  assert.notEqual(settled, "hung", "the feed must not wait on a body a wrapping fetch has cloned");
  assert.equal((settled as AppDownload).available, true);
  assert.equal((settled as AppDownload).url, signedUrl(String(DMG_ID), T0, 1_800));
  assert.ok(kept.length > 0);
});

test("every GitHub request behind the feed carries a timeout", async () => {
  const github = installGitHub({ isPrivate: true });
  await buildDownloadFeed({ token: TOKEN, now });
  assert.ok(github.calls.length > 0);
  for (const call of github.calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `${call.url} has no timeout signal`);
  }
});

test("a private manifest is read through the API, and still fails closed", async () => {
  let github = installGitHub({ isPrivate: true });
  assert.equal(mac(await buildDownloadFeed({ token: TOKEN, now })).notarized, true);
  const read = github.calls.find(
    (call) => call.url.endsWith(`/releases/assets/${MANIFEST_ID}`) && call.init.redirect !== "manual",
  );
  assert.ok(read, "the manifest is fetched from the API endpoint, not its github.com URL");
  assert.equal(read.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(read.init.next, { revalidate: 60 });
  assert.ok(!github.calls.some((call) => call.url.endsWith(".release.json")), "never the 404ing github.com URL");

  // The same fail-closed rules as a public manifest: unreadable, missing the
  // field, or not literally true all answer false.
  for (const manifest of [null, "not json", JSON.stringify({ version: "1.5.4" }), JSON.stringify({ notarized: "yes" })]) {
    resetDownloadFeedCache();
    github = installGitHub({ isPrivate: true, manifest });
    const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
    assert.equal(row.available, true);
    assert.equal(row.notarized, false, `manifest ${manifest}`);
  }
});

test("prereleases stay out of the default feed when the listing is authenticated", async () => {
  installGitHub({
    isPrivate: true,
    releases: [release("1.5.4"), release("1.6.0-beta.1", { prerelease: true, idOffset: 10 }), release("1.7.0", { draft: true, idOffset: 20 })],
  });
  assert.equal(mac(await buildDownloadFeed({ token: TOKEN, now })).version, "1.5.4");
  resetDownloadFeedCache();
  assert.equal(mac(await buildDownloadFeed({ token: TOKEN, now, includePrerelease: true })).version, "1.6.0-beta.1");
});

test("a public repository read with a token keeps its permanent links", async () => {
  const github = installGitHub({ isPrivate: false });
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
  assert.equal(row.url, `https://github.com/${REPO}/releases/download/v1.5.4/Juno-1.5.4.dmg`);
  assert.equal(row.urlExpiresAt, null);
  assert.equal(github.signings().length, 0);
});

test("when visibility cannot be confirmed the asset is signed, which works either way", async () => {
  installGitHub({ isPrivate: false, repoLookup: "fail" });
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
  assert.equal(row.url, signedUrl(String(DMG_ID), T0, 1_800));
});

test("a revoked token is never worse than no token", async () => {
  const github = installGitHub({ isPrivate: false });
  const row = mac(await buildDownloadFeed({ token: "github_pat_revoked", now }));
  assert.equal(row.available, true);
  assert.equal(row.url, `https://github.com/${REPO}/releases/download/v1.5.4/Juno-1.5.4.dmg`);
  // Refused once with the token, then read anonymously.
  const listings = github.calls.filter((call) => call.url.startsWith(`https://api.github.com/repos/${REPO}/releases?`));
  assert.deepEqual(listings.map((call) => call.authorization), ["Bearer github_pat_revoked", null]);
});

test("a signed URL the updater would refuse is not offered at all", async () => {
  for (const location of [
    "https://evil.example.com/Juno.dmg",
    "http://release-assets.githubusercontent.com/x",
    "https://release-assets.githubusercontent.com.evil.example/x",
    "not a url",
  ]) {
    resetDownloadFeedCache();
    installGitHub({ isPrivate: true, location: () => location });
    const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
    assert.equal(row.available, false, location);
    assert.equal(row.url, null);
    assert.equal(row.note, "Temporarily unavailable");
  }
});

test("a signing GitHub refuses leaves the release unavailable rather than linking a 404", async () => {
  installGitHub({ isPrivate: true });
  const listed = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    init?.redirect === "manual" ? json({ message: "Not Found" }, 404) : listed(input, init)) as typeof fetch;
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
  assert.equal(row.available, false);
  assert.equal(row.url, null);
  assert.equal(row.sha256, null);
});

/* ── The cache never outlives the URL ────────────────────────────────────── */

test("a signed URL is reused for at most a minute", async () => {
  const github = installGitHub({ isPrivate: true });
  const first = mac(await buildDownloadFeed({ token: TOKEN, now })).url;

  clock = T0 + 30_000;
  assert.equal(mac(await buildDownloadFeed({ token: TOKEN, now })).url, first);
  assert.equal(github.signings().length, 1);

  clock = T0 + SIGNED_URL_REUSE_MS;
  const third = mac(await buildDownloadFeed({ token: TOKEN, now })).url;
  assert.equal(github.signings().length, 2);
  assert.notEqual(third, first);
});

test("a short-lived signed URL is re-signed before its last minutes, not handed out into them", async () => {
  // Four and a half minutes of life: reusable while four remain, then not.
  const github = installGitHub({ isPrivate: true, jwtSeconds: 270 });
  await buildDownloadFeed({ token: TOKEN, now });
  clock = T0 + 29_000;
  await buildDownloadFeed({ token: TOKEN, now });
  assert.equal(github.signings().length, 1);
  clock = T0 + 31_000;
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
  assert.equal(github.signings().length, 2);
  assert.equal(row.urlExpiresAt, new Date(T0 + 31_000 + 270_000).toISOString());
});

test("across an hour of requests, no URL is ever served with less than four minutes to run", async () => {
  // GitHub's two observed lifetimes: 30 minutes for a DMG, 5 for a small asset.
  for (const jwtSeconds of [1_800, 300]) {
    resetDownloadFeedCache();
    installGitHub({ isPrivate: true, jwtSeconds });
    for (clock = T0; clock < T0 + 60 * 60_000; clock += 7_000) {
      const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
      assert.ok(row.urlExpiresAt);
      assert.ok(
        Date.parse(row.urlExpiresAt) - clock >= SIGNED_URL_MIN_REMAINING_MS,
        `served at +${(clock - T0) / 1000}s with ${(Date.parse(row.urlExpiresAt) - clock) / 1000}s left`,
      );
    }
  }
});

test("a signed URL whose expiry cannot be read is assumed to live five minutes", async () => {
  installGitHub({
    isPrivate: true,
    location: (id) => `https://release-assets.githubusercontent.com/github-production-release-asset/1/${id}?sig=abc`,
  });
  const row = mac(await buildDownloadFeed({ token: TOKEN, now }));
  assert.equal(row.urlExpiresAt, new Date(T0 + SIGNED_URL_ASSUMED_LIFETIME_MS).toISOString());
});

test("a manual updater check is never answered with a reused URL", async () => {
  const github = installGitHub({ isPrivate: true });
  await buildDownloadFeed({ token: TOKEN, now });
  clock = T0 + 5_000;
  await buildDownloadFeed({ token: TOKEN, now, forceRefresh: true });
  assert.equal(github.signings().length, 2);
  const forced = github.calls.filter((call) => call.url.startsWith(`https://api.github.com/repos/${REPO}/releases?`)).at(-1);
  assert.equal(forced?.init.cache, "no-store");
});

test("a burst of requests shares one signing", async () => {
  const github = installGitHub({ isPrivate: true });
  const rows = await Promise.all(Array.from({ length: 8 }, () => buildDownloadFeed({ token: TOKEN, now })));
  assert.equal(github.signings().length, 1);
  assert.equal(new Set(rows.map((downloads) => mac(downloads).url)).size, 1);
});

/* ── The surfaces ────────────────────────────────────────────────────────── */

test("/api/downloads carries the signed URL and is never cached", async () => {
  clock = Date.now();
  process.env.JUNO_RELEASES_GITHUB_TOKEN = TOKEN;
  installGitHub({ isPrivate: true });
  const response = await feedRoute(new Request("http://localhost/api/downloads"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { downloads: AppDownload[] };
  const row = mac(body.downloads);
  assert.equal(row.available, true);
  assert.ok(row.url?.startsWith("https://release-assets.githubusercontent.com/"));
  assert.equal(row.sha256, DIGEST);

  for (const file of ["../src/app/api/downloads/route.ts", "../src/app/download/[platform]/route.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /export const dynamic = "force-dynamic";/, file);
  }
});

test("the redirect route signs a fresh URL at the moment of the click", async () => {
  // The routes run on the real clock; so does this GitHub, for them.
  clock = Date.now();
  process.env.JUNO_RELEASES_GITHUB_TOKEN = TOKEN;
  const github = installGitHub({ isPrivate: true });
  const response = await redirectRoute(new Request("http://localhost/download/macos?version=1.5.4"), {
    params: Promise.resolve({ platform: "macos" }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const location = response.headers.get("location");
  assert.ok(location?.startsWith(`https://release-assets.githubusercontent.com/github-production-release-asset/1/${DMG_ID}-`));
  assert.equal(github.signings().length, 1);
  // Stable only, like every public surface.
  assert.ok(github.calls.every((call) => !call.url.includes("channel")));
});

test("the redirect route never hands over a file other than the one the page described", async () => {
  clock = Date.now();
  process.env.JUNO_RELEASES_GITHUB_TOKEN = TOKEN;
  installGitHub({ isPrivate: true, releases: [release("1.5.5"), release("1.5.4", { idOffset: 10 })] });
  const stale = await redirectRoute(new Request("http://localhost/download/macos?version=1.5.4"), {
    params: Promise.resolve({ platform: "macos" }),
  });
  assert.equal(stale.status, 303);
  assert.equal(new URL(stale.headers.get("location") ?? "").pathname, "/download");

  // Nothing to download, and a platform that does not exist.
  const windows = await redirectRoute(new Request("http://localhost/download/windows"), {
    params: Promise.resolve({ platform: "windows" }),
  });
  assert.equal(windows.status, 303);
  const linux = await redirectRoute(new Request("http://localhost/download/linux"), {
    params: Promise.resolve({ platform: "linux" }),
  });
  assert.equal(linux.status, 404);
});

test("the pages link through the redirect route for a signed URL, and straight to a permanent one", () => {
  const signed: AppDownload = {
    platform: "macos",
    label: "macOS",
    url: signedUrl(String(DMG_ID), T0, 1_800),
    urlExpiresAt: new Date(T0 + 1_800_000).toISOString(),
    version: "1.5.4",
    size: 1,
    sha256: DIGEST,
    available: true,
    notarized: true,
  };
  assert.equal(downloadHref(signed), "/download/macos?version=1.5.4");
  assert.equal(
    downloadHref({ ...signed, url: "https://github.com/x/y.dmg", urlExpiresAt: null }),
    "https://github.com/x/y.dmg",
  );
  assert.equal(downloadHref({ ...signed, available: false, url: null }), null);

  // `download` only on the permanent link. On the same-origin route it would
  // make the browser save the /download page the route falls back to.
  assert.deepEqual(downloadLink(signed), { href: "/download/macos?version=1.5.4" });
  assert.deepEqual(downloadLink({ ...signed, url: "https://github.com/x/y.dmg", urlExpiresAt: null }), {
    href: "https://github.com/x/y.dmg",
    download: true,
  });
  assert.equal(downloadLink({ ...signed, available: false, url: null }), null);

  // Neither surface renders the feed's own URL into a link, or decides on the
  // `download` attribute for itself. The menu only renders inside an open
  // Radix portal, which a server render never mounts, so its anchor is held
  // to the helper here; the page's is rendered below.
  for (const file of ["../src/app/download/page.tsx", "../src/components/app/download-menu.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /const link = downloadLink\(download\);/, file);
    assert.match(source, /<a \{\.\.\.link\}>/, file);
    assert.doesNotMatch(source, /href=\{download\.url\}/, file);
    assert.doesNotMatch(source, /<a\b[^>]*\sdownload[\s=>]/, file);
  }
});

/** The page's download anchors, as their `href` and whether they carry `download`. */
function downloadAnchors(html: string): { href: string; download: boolean }[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)]
    .map((match) => match[1])
    .filter((attributes) => /\bhref="(?:\/download\/|https:)/.test(attributes))
    .map((attributes) => ({
      href: (/\bhref="([^"]*)"/.exec(attributes)?.[1] ?? "").replace(/&amp;/g, "&"),
      download: /\sdownload(?:=""|\s|$)/.test(attributes),
    }));
}

/**
 * The /download page, rendered. `tsx` compiles JSX the classic way (the repo's
 * tsconfig says `preserve`, which is Next's to handle), so a file that never
 * imports React, as a Next page need not, looks for it globally.
 */
async function renderDownloadPage(): Promise<string> {
  const scope = globalThis as { React?: typeof React };
  scope.React ??= React;
  return renderToStaticMarkup(await DownloadPage());
}

test("the /download page links a private release through the route as a plain link", async () => {
  // The page reads the feed on the real clock, with the token from the environment.
  clock = Date.now();
  process.env.JUNO_RELEASES_GITHUB_TOKEN = TOKEN;
  installGitHub({ isPrivate: true });
  const html = await renderDownloadPage();

  // With `download`, a same-origin link saves whatever the route answers, and
  // when that is its 303 back to /download the visitor gets download.html.
  assert.deepEqual(downloadAnchors(html), [{ href: "/download/macos?version=1.5.4", download: false }]);
  assert.doesNotMatch(html, /githubusercontent\.com/, "the signed URL itself is never rendered");
});

test("the /download page keeps a public release's permanent link exactly as it was", async () => {
  installGitHub({ isPrivate: false });
  const html = await renderDownloadPage();
  assert.deepEqual(downloadAnchors(html), [
    { href: `https://github.com/${REPO}/releases/download/v1.5.4/Juno-1.5.4.dmg`, download: true },
  ]);
});
