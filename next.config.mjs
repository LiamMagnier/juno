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
