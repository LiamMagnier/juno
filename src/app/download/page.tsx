import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Laptop, Monitor, Smartphone, type IconComponent } from "@/components/ui/icons";
import { AppPage } from "@/components/ui/app-page";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { JunoMark } from "@/components/brand/logo";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { buildDownloadFeed } from "@/lib/download-feed";
import type { AppDownload, DownloadPlatform } from "@/lib/app-downloads";
import { staggerDelay } from "@/lib/motion";
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
 * One glyph per platform, hung in the row's margin so the three rows scan as
 * a column of devices before they are read as a column of names. The device,
 * not a vendor logo: these name where the app runs, and Apple's and
 * Microsoft's marks are theirs to draw.
 */
const PLATFORM_ICON: Record<DownloadPlatform, IconComponent> = {
  macos: Laptop,
  windows: Monitor,
  ios: Smartphone,
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
          {/* The arrow nudges back on hover and on keyboard focus: the
              glyph's own articulation (`nudge-l`, globals.css), played because
              it sits in a link. It was a second, hand-written translate on top
              of that, so the two stacked and the arrow jumped twice as far. */}
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-xs font-mono text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to Juno
          </Link>
          <Link
            href="/"
            aria-label="Juno"
            className="pressable rounded-control motion-reduce:transition-none motion-reduce:active:scale-100"
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

          {/* Dealt on the base rung under the header, the contract's list
              entrance; three rows, so the last lands ~90ms after the first. */}
          <ul className="mt-10 border-t border-border">
            {downloads.map((download, i) => (
              <DownloadRow key={download.platform} download={download} index={i} />
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

function DownloadRow({ download, index }: { download: AppDownload; index: number }) {
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
  const PlatformIcon = PLATFORM_ICON[download.platform];

  return (
    <li
      style={staggerDelay(index)}
      className="border-b border-border py-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
    >
      {/* `items-center`: the action sits level with the whole description
          (name, version, checksum), not with the first line of it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* mt-0.5 centres the 20px glyph on the heading's 23px line. */}
          <PlatformIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
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
        </div>

        {download.available && download.url ? (
          // The product's primary button, so the press, the hover and the
          // glyph's nudge downward are the ones every other primary action
          // has. The hand-built anchor it replaces carried `transition-colors`
          // after `.pressable`, which overrode the press timing and made the
          // dip snap instead of travel.
          <Button asChild className="shrink-0">
            <a href={download.url} download>
              <ActionIcons.download aria-hidden />
              Download
            </a>
          </Button>
        ) : (
          <span className="inline-flex h-9 shrink-0 items-center rounded-control bg-secondary px-3.5 font-sans text-ui font-medium text-muted-foreground coarse:h-11">
            {download.note ?? "Not available"}
          </span>
        )}
      </div>

      {/* pl-8: the platform glyph (20) plus its gap (12), so the note starts
          on the name's left edge. The warning glyph is the product's one mark
          for "needs attention, nothing is broken". */}
      {blockedOnFirstOpen && (
        <p className="mt-3 flex max-w-prose gap-2 pl-8 text-ui leading-relaxed text-warning">
          <StatusIcons.warning className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            This build is not notarized by Apple yet, so macOS blocks it the first time. Open it once from
            System Settings › Privacy &amp; Security, where the blocked file appears with an Open Anyway
            button. Updates after that install silently.
          </span>
        </p>
      )}
    </li>
  );
}
