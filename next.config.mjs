/**
 * The storage hosts images may legitimately be optimized from: the public bucket
 * URL when one is set, and the S3 endpoint itself for presigned URLs (which is
 * what getViewUrl falls back to when S3_PUBLIC_URL is absent).
 *
 * The endpoint contributes TWO hosts, because the presigner does not
 * necessarily use the one written in S3_ENDPOINT. With S3_FORCE_PATH_STYLE
 * unset or "false" — the default in src/lib/env.ts — the AWS SDK addresses the
 * bucket as a subdomain (`bucket.endpoint-host/key`) rather than a path
 * (`endpoint-host/bucket/key`). remotePatterns matches hostnames exactly unless
 * a wildcard is written, so allowing only the bare endpoint host would 400
 * every presigned image — precisely the case this function exists to cover.
 * Both forms are listed rather than a `*.` wildcard, which would also admit
 * every other bucket on the same provider.
 */
function storageImagePatterns() {
  const patterns = [];
  const seen = new Set();
  const allow = (hostname) => {
    if (!hostname || seen.has(hostname)) return;
    seen.add(hostname);
    patterns.push({ protocol: "https", hostname });
  };
  const bucket = process.env.S3_BUCKET;
  for (const [raw, isEndpoint] of [
    [process.env.S3_PUBLIC_URL, false],
    [process.env.S3_ENDPOINT, true],
  ]) {
    if (!raw) continue;
    try {
      const { protocol, hostname } = new URL(raw);
      if (protocol !== "https:") continue;
      allow(hostname);
      if (isEndpoint && bucket) allow(`${bucket}.${hostname}`);
    } catch {
      // Not a URL — nothing to allow.
    }
  }
  // These are baked in at BUILD time, and the build reads .env written from the
  // PROD_ENV secret while the VM keeps its own runtime .env — so a storage key
  // present on the VM but missing from PROD_ENV yields an empty list here and
  // silently 400s every image, with a green build and a green deploy. Say what
  // was allowed, so the deploy log can be checked against the running config.
  console.log(
    patterns.length
      ? `[next.config] storage image hosts: ${patterns.map((p) => p.hostname).join(", ")}`
      : "[next.config] storage image hosts: none (local-disk storage, or S3_* absent from the build env)",
  );
  return patterns;
}

/** @type {import('next').NextConfig} */
// The design-system galleries under src/app/dev/design and src/app/dev/directions
// load dozens of Google fonts for their typeface labs. They already 404 in
// production, but `next build` still compiled them, and one flaky font fetch
// failed whole releases (2026-10-01). Their pages are named page.dev.tsx, a
// page extension that only exists outside production builds.
const devOnlyPages = process.env.NODE_ENV !== "production";

const nextConfig = {
  reactStrictMode: true,
  pageExtensions: devOnlyPages ? ["dev.tsx", "tsx", "ts", "jsx", "js"] : ["tsx", "ts", "jsx", "js"],
  poweredByHeader: false,
  /*
   * THE CLIENT ROUTER CACHE, turned back on.
   *
   * Next 15 changed the default for dynamic routes to `staleTimes.dynamic: 0`,
   * which means a client-side navigation to a route it rendered three seconds
   * ago is re-fetched from the server in full. Every route in this app is under
   * a `force-dynamic` layout, so that default applies to all of them — and the
   * one navigation people make constantly is Chat → Code → Chat.
   *
   * Measured on a warm local build with the database in the same process, a
   * mode switch took 110-210ms and issued 16-20 SQL round trips. On a hosted
   * Postgres at 20-40ms per round trip, that is most of a second of nothing,
   * every time, for a screen the browser was showing a moment earlier.
   *
   * 30 seconds, not longer: this is the window in which a bounce back to the
   * mode you just left is free. Past it the data is re-fetched, so a routine
   * that fired or a session that finished still appears on the next visit
   * rather than being hidden behind a stale shell. Anything that must be live
   * NOW — a streaming reply, the sidebar's run signals — already arrives over
   * its own channel and does not go through this cache.
   */
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
    /*
     * THE REQUEST BODY CEILING WHILE MIDDLEWARE RUNS.
     *
     * src/middleware.ts runs on every /api route, and when it does Next 15
     * clones the request body for it and hands the route handler only the
     * first `middlewareClientMaxBodySize` bytes — 10 MB by default. Past that
     * the body is silently TRUNCATED (one console.warn on the server), so
     * `req.formData()` throws "Failed to parse body as FormData" and every
     * upload route answered "No file provided." for any file over 10 MB.
     * That is why announcement videos never uploaded, and why larger chat
     * attachments failed the same way.
     *
     * 120 MB matches nginx's `client_max_body_size 120m`
     * (deploy/nginx.conf.template), so the proxy stays the one place the
     * ceiling is set; each route still enforces its own, smaller limit.
     * Pinned by tests/announcement-media.test.ts.
     */
    middlewareClientMaxBodySize: "120mb",
  },
  // bcryptjs is pure JS but we keep it external to the server bundle to avoid
  // any bundler edge cases with its dynamic requires.
  //
  // @napi-rs/canvas is external for a harder reason: it is a NATIVE module.
  // Its entry point picks a `.node` binary at runtime from the platform
  // triple, which a bundler cannot follow — inlined, it resolves to nothing
  // and PDF thumbnails and `inspect_image` both silently turn themselves off
  // (they degrade rather than throw, so the symptom would be an absence, not
  // an error). Left external, Next's file tracing copies the binary that this
  // platform actually installed.
  serverExternalPackages: ["bcryptjs", "@napi-rs/canvas"],
  images: {
    /*
     * hostname: "**" made /_next/image an open proxy: any visitor could make
     * the server fetch an arbitrary HTTPS URL and serve the bytes back from
     * Juno's own origin.
     *
     * What actually needs to be here is small. Source-citation favicons do NOT
     * — they render through a plain <img> pointed at each source's own origin
     * (see src/components/chat/source-chip.tsx), deliberately bypassing the
     * optimizer, so arbitrary hosts were never needed for them. Attachments and
     * avatars stored locally resolve to relative /api/files/... URLs, which
     * remotePatterns does not govern either.
     *
     * That leaves Google account avatars and, when S3 is configured, the
     * storage host.
     *
     * Note these are baked in at BUILD time. Changing S3_PUBLIC_URL or
     * S3_ENDPOINT requires a rebuild, not just a restart, or images from the
     * new host will 400.
     */
    remotePatterns: [
      // Google is the only OAuth provider configured (src/lib/auth.ts); it
      // serves avatars from lh3/lh4/lh5/lh6.googleusercontent.com.
      { protocol: "https", hostname: "*.googleusercontent.com" },
      ...storageImagePatterns(),
    ],
  },
  // Baseline security headers. The Content-Security-Policy is NOT here — it
  // needs a per-request nonce, so it is built in src/middleware.ts and is
  // enforcing on document responses.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Voice mode needs the microphone; everything else stays off.
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), microphone=(self)" },
          // Ignored over plain http (dev); enforced once served over https.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      {
        // Everything but the artifact preview shell, which sets both of these
        // itself (src/lib/sandbox-shell.ts) and where a header here would win
        // over the route's. It is framed by the app from a separate origin
        // when NEXT_PUBLIC_SANDBOX_ORIGIN is set and names who may frame it in
        // its own `frame-ancestors`, so SAMEORIGIN would refuse it; and a
        // preview's CDN requests carry no referrer at all.
        source: "/:path((?!sandbox/).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The push-only service worker (public/sw.js). Revalidated on every
        // update check so a fix to it reaches browsers on their next visit
        // rather than whenever a cached copy expires; allowed to control the
        // whole origin, which is the scope the page registers it with.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
  async rewrites() {
    if (process.env.RENDER_BACKEND_URL) {
      return [
        {
          source: "/api/:path*",
          destination: `${process.env.RENDER_BACKEND_URL}/api/:path*`,
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
