import { env } from "@/lib/env";

/**
 * Absolute public URL for a public-link token: a legacy share or an artifact
 * publication. Both live under `/share/{token}`, so the page, its poster, the
 * Report link and the admin lookup (`parseShareToken`) serve both kinds.
 */
export function shareUrl(token: string): string {
  return `${env.appUrl.replace(/\/+$/, "")}/share/${token}`;
}
