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
    // Allow rendering avatars/thumbnails served from the configured storage host.
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  // Baseline security headers. A full Content-Security-Policy is future work:
  // Next.js relies on inline scripts, so a real CSP needs per-request nonces.
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
