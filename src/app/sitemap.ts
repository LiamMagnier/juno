import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * Sitemap for the public surface only — the app itself (chat, settings, …)
 * is behind auth and disallowed in robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.appUrl.replace(/\/+$/, "");
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/sign-in`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/sign-up`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/roadmap`, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/legal/confidentialite`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/cgu`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/mentions-legales`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
