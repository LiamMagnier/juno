import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * Robots policy: only the public surface (landing, auth, legal) is crawlable;
 * everything behind auth and the API is disallowed.
 */
export default function robots(): MetadataRoute.Robots {
  const base = env.appUrl.replace(/\/+$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/chat",
          "/settings",
          "/profile",
          "/memory",
          "/projects",
          "/connections",
          "/library",
          "/artifacts",
          "/admin",
          "/upgrade",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
