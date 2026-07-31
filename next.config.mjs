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
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Type-checking runs in the editor and on the dev machine before pushing. On
  // the 1 GB build VM, Next's type-check worker OOMs (it ignores
  // --max-old-space-size), so we skip it during the production build. Catch type
  // errors locally with `npx tsc --noEmit`.
  typescript: { ignoreBuildErrors: true },
  // bcryptjs is pure JS but we keep it external to the server bundle to avoid
  // any bundler edge cases with its dynamic requires.
  serverExternalPackages: ["bcryptjs"],
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
  // currently Report-Only (see the note there before promoting it to enforcing).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Voice mode needs the microphone; everything else stays off.
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), microphone=(self)" },
          // Ignored over plain http (dev); enforced once served over https.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
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
