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
          // NOTE: /share is deliberately NOT robots-blocked — share pages carry
          // per-page noindex,nofollow, and crawlers can only honor that if
          // they're allowed to fetch the page (robots-blocked URLs can still
          // surface in results as URL-only entries).
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
