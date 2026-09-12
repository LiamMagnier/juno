import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppPage } from "@/components/ui/app-page";
import { PageHeader } from "@/components/ui/page-header";
import { JunoMark } from "@/components/brand/logo";
import { ActionIcons } from "@/lib/app-icons";
import { buildDownloadFeed } from "@/lib/download-feed";
import type { AppDownload } from "@/lib/app-downloads";
import { formatBytes } from "@/lib/utils";

// A literal for the same reason as the API route: route segment config is read
// by static analysis. Kept in step with DOWNLOAD_FEED_REVALIDATE.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Download Juno",
  description:
    "Juno for Mac, Windows and iPhone. Every build lists its version, size and SHA-256 so you can check what you installed.",
  alternates: { canonical: "/download" },
};

/**
 * The front door's download page.
 *
 * It exists because the two places that used to offer the Mac app — the landing
 * hero and the features list — both pointed at `public/downloads/Juno.dmg`, a
 * disk image committed to the repository whose enclosed app was self-signed,
 * carried no Team ID and had no notarization ticket. `docs/native/RELEASE.md`
 * describes that exact file as "rejected by Gatekeeper. It must not be
 * promoted." Both links promoted it.
 *
 * So the page reads the same release feed the app's own download menu and the
 * Mac updater read, and reports what is actually published — including whether
 * Apple has notarized the build, which decides whether it opens at all.
 */
export default async function DownloadPage() {
  const downloads = await buildDownloadFeed();

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <AppPage scroll={false} measure="reading" contentClassName="py-0">
        <header className="flex items-center justify-between gap-4 py-5 sm:py-6">
          <Link
            href="/"
            className="group inline-flex items-center gap-2 rounded-xs font-mono text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
          >
            <ArrowLeft
              className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5 group-focus-visible:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              aria-hidden
            />
            Back to Juno
          </Link>
          <Link
            href="/"
            aria-label="Juno"
            className="rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <JunoMark className="size-8" />
          </Link>
        </header>
      </AppPage>

      <AppPage scroll={false} measure="reading" contentClassName="pb-20 pt-6 sm:pt-8">
        <main>
          <PageHeader
            as="h1"
            eyebrow="Download"
            heading="Juno on your desktop"
            lede="Same account, same conversations, same projects. Every build below lists the version, the size and the SHA-256 of the exact file you get."
          />

          <ul className="mt-10 border-t border-border">
            {downloads.map((download) => (
              <DownloadRow key={download.platform} download={download} />
            ))}
          </ul>

          <p className="mt-8 text-caption text-muted-foreground">
            Builds are published as GitHub releases. The checksum beside each one is the digest GitHub
            recorded for that asset, so you can verify a download with <code className="font-mono">shasum -a 256</code>
            {" "}before you open it.
          </p>
        </main>
      </AppPage>
    </div>
  );
}

function DownloadRow({ download }: { download: AppDownload }) {
  // Only for a platform that has something to describe. An unavailable one says
  // why in the control on the right, and repeating it under the name put the
  // same four words on the row twice.
  const detail = download.available
    ? [download.version && `Version ${download.version}`, download.size && formatBytes(download.size)]
        .filter(Boolean)
        .join(" · ")
    : null;

  // Only macOS has this problem, and only while no notarized build exists.
  // Apple refuses an unnotarized download with "Apple could not verify … is free
  // of malware", offering only "Move to Trash" and "Done" — a dead end unless
  // you already know the way round it. Saying so here costs a reader nothing and
  // saves them assuming the file is malware.
  const blockedOnFirstOpen = download.available && download.notarized === false;

  return (
    <li className="border-b border-border py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="font-sans text-heading text-foreground">{download.label}</p>
          {detail && <p className="mt-1 font-mono text-caption text-muted-foreground">{detail}</p>}
          {/* No `/80` on the colour below: --muted-foreground is already tuned to
              the 4.5:1 floor, and a further 20% of transparency at 10.5px puts it
              under. The legal footer carries the same note. */}
          {download.sha256 && (
            <p className="mt-1 break-all font-mono text-micro text-muted-foreground">
              SHA-256 {download.sha256}
            </p>
          )}
        </div>

        {download.available && download.url ? (
          <a
            href={download.url}
            download
            className="pressable inline-flex h-9 shrink-0 items-center gap-2 rounded-control bg-primary px-3.5 font-sans text-ui font-medium text-primary-foreground transition-colors duration-fast ease-out-soft hover:bg-primary/90"
          >
            <ActionIcons.download className="size-4" aria-hidden />
            Download
          </a>
        ) : (
          <span className="inline-flex h-9 shrink-0 items-center rounded-control bg-secondary px-3.5 font-sans text-ui font-medium text-muted-foreground">
            {download.note ?? "Not available"}
          </span>
        )}
      </div>

      {blockedOnFirstOpen && (
        <p className="mt-3 max-w-prose text-ui leading-relaxed text-warning">
          This build is not notarized by Apple yet, so macOS blocks it the first time. Open it once from
          System Settings › Privacy &amp; Security, where the blocked file appears with an Open Anyway
          button. Updates after that install silently.
        </p>
      )}
    </li>
  );
}
