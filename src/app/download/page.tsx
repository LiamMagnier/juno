import type { Metadata } from "next";
import { DownloadView } from "@/components/download/download-view";
import { buildDownloadFeed } from "@/lib/download-feed";
import { PRODUCT_NAME } from "@/lib/brand/names";

// A literal for the same reason as the API route: route segment config is read
// by static analysis. Kept in step with DOWNLOAD_FEED_REVALIDATE.
export const revalidate = 60;

export const metadata: Metadata = {
  title: `Download ${PRODUCT_NAME}`,
  description:
    `${PRODUCT_NAME} for Mac: Chat and ${PRODUCT_NAME} Code in one native app. Every build lists its version, size and SHA-256 so you can check what you installed.`,
  alternates: { canonical: "/download" },
};

/**
 * The front door's download page.
 *
 * It reads the same release feed the app's own download menu and the Mac
 * updater read, and reports what is actually published, including whether
 * Apple has notarized the build, which decides whether it opens at all. (The
 * repository once shipped a committed, self-signed Juno.dmg that Gatekeeper
 * refused; docs/native/RELEASE.md says it must not be promoted, and nothing
 * here links it.) The page body is DownloadView, so the dev gallery can render
 * the published-build state from a fixture.
 */
export default async function DownloadPage() {
  return <DownloadView downloads={await buildDownloadFeed()} />;
}
