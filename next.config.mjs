/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type errors still fail the build; lint is run separately via `npm run lint`.
  eslint: { ignoreDuringBuilds: true },
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
