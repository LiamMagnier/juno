import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, Globe, Monitor, Smartphone } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LandingColumn } from "@/components/landing/section";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { downloadLink, type AppDownload, type DownloadPlatform } from "@/lib/app-downloads";
import { staggerDelay } from "@/lib/motion";
import { formatBytes } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { Construction } from "@/components/home/construction";
import { OpenMacAppButton } from "@/components/download/open-mac-app-button";
import "@/components/home/alv-base.css";

/**
 * The download page's body, fed the release feed by the route (app/download)
 * and a fixture by the dev gallery (app/dev/download), so the published-build
 * state can be looked at without a GitHub token.
 *
 * Anatomy, after the best download pages: one primary action with the facts a
 * careful reader wants right under it (version, size), the app itself on a
 * painted stage, the other platforms as their own cells, and the checksum
 * story folded into a disclosure for the people who want it. The Mac build's
 * notarization note stays visible whenever it applies: it is the difference
 * between the app opening and not.
 */

const ENTER = "motion-safe:animate-rise-in [animation-fill-mode:backwards]";

export function DownloadView({ downloads }: { downloads: AppDownload[] }) {
  const by = (p: DownloadPlatform) => downloads.find((d) => d.platform === p);
  const mac = by("macos");
  const ios = by("ios");
  const windows = by("windows");
  const macLink = mac ? downloadLink(mac) : null;
  const macFacts = mac?.available
    ? [mac.version && `Version ${mac.version}`, mac.size && formatBytes(mac.size), "macOS 26 or later"]
        .filter(Boolean)
    : null;
  const blocked = Boolean(mac?.available && mac.notarized === false);

  return (
    <div className="alevr-public alv relative min-h-dvh bg-background text-foreground">
      <SiteHeader />

      <main>
        <LandingColumn contentClassName="alevr-download-intro"><div className="alevr-download-copy">
          <h1 style={staggerDelay(0, "loose")} className={`alevr-download-title font-serif ${ENTER}`}>
            {`Download ${PRODUCT_NAME} for Mac`}
          </h1>
          <p
            style={staggerDelay(1, "loose")}
            className={`mt-4 max-w-[32rem] text-pretty text-body-lg text-muted-foreground ${ENTER}`}
          >
            {`Chat and ${PRODUCT_NAME} Code in one native app. Same account, same conversations, same projects.`}
          </p>
          <div style={staggerDelay(2, "loose")} className={`mt-8 flex flex-col items-start ${ENTER}`}>
            <div className="flex flex-wrap items-center gap-3">
              {macLink ? (
                <Button asChild size="lg">
                  <a {...macLink}>
                    <ActionIcons.download aria-hidden />
                    Download for Mac
                  </a>
                </Button>
              ) : (
                <span className="text-body text-muted-foreground">
                  {mac?.note ?? "Mac build not published yet"}
                </span>
              )}
              <OpenMacAppButton />
            </div>
            {macFacts && <div className="alevr-release-facts mt-4">{macFacts.map(fact => <p key={String(fact)} className="text-caption text-muted-foreground">{fact}</p>)}</div>}
          </div>
          {blocked && (
            <p
              style={staggerDelay(3, "loose")}
              className={`mt-6 flex max-w-lg gap-2 rounded-field bg-warning/10 px-4 py-3 text-left text-ui leading-relaxed text-warning ${ENTER}`}
            >
              <StatusIcons.warning className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This build is not notarized by Apple yet, so macOS blocks it the first time. Open it once from System
                Settings › Privacy &amp; Security, where it appears with an Open Anyway button. Updates after that
                install silently.
              </span>
            </p>
          )}
          </div><div className="alevr-download-material"><MacStage /></div>
        </LandingColumn>

        <LandingColumn contentClassName="py-16 sm:py-24">
          <h2 className="font-serif text-display font-medium tracking-tight">Also on your other devices</h2>
          <div className="alevr-download-platforms mt-10">
            <OtherCell
              icon={Smartphone}
              title="iPhone and iPad"
              body="Voice, camera and your projects, synced."
              action={<PlatformAction download={ios} fallback="On the App Store soon" />}
            />

            <OtherCell
              icon={Globe}
              title="In your browser"
              body="Nothing to install. Everything you do syncs with the apps."
              action={
                <Button asChild variant="secondary" size="sm">
                  <Link href="/sign-in">
                    {`Open ${PRODUCT_NAME}`}
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              }
            />
            <OtherCell
              icon={Monitor}
              title="Windows"
              body={`A native Windows app is on the way. Until then, ${PRODUCT_NAME} runs in any browser.`}
              action={<PlatformAction download={windows} fallback="Not published yet" />}
            />
          </div>

          <details className="group mt-10 rounded-card border border-border/70 px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-xs text-body font-medium">
              Verify your download
              <ChevronDown
                className="size-4 text-muted-foreground transition-transform duration-fast ease-out-soft group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <div className="mt-3 space-y-3 text-body text-muted-foreground">
              <p>
                Builds are published as GitHub releases. The checksum below is the digest GitHub recorded for the
                asset, so you can check the file with <code className="font-mono text-foreground">shasum -a 256</code>{" "}
                before you open it.
              </p>
              {downloads
                .filter((d) => d.available && d.sha256)
                .map((d) => (
                  <p key={d.platform} className="break-all font-mono text-caption">
                    <span className="text-foreground">{d.label}</span> {d.version && `${d.version} `}SHA-256 {d.sha256}
                  </p>
                ))}
            </div>
          </details>
        </LandingColumn>
      </main>

      <SiteFooter />
    </div>
  );
}

function OtherCell({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="alevr-download-platform border-t border-border py-8">
      <div className="flex items-start gap-3.5">
        <Icon className="mt-0.5 size-5 shrink-0 text-foreground" aria-hidden />
        <div>
          <h3 className="text-heading">{title}</h3>
          <p className="mt-1 text-body text-muted-foreground">{body}</p>
        </div>
      </div>
      <div>{action}</div>
    </div>
  );
}

/**
 * The same authored photograph as the public front door and sign-in.
 * No live chat preview here: that needs the model registry, which is
 * server-only, and this page is also rendered by the feed tests.
 */
function MacStage() {
  return <div className="alv-download-stage alv-deep" aria-hidden="true">
    <div className="alv-download-construction"><Construction /></div>
    <Image src="/brand/app-icon-mac.png" alt="" width={168} height={168} priority className="alv-download-icon" />
  </div>;
}

function PlatformAction({ download, fallback }: { download?: AppDownload; fallback: string }) {
  if (!download) return <Unavailable label={fallback} />;
  const link = downloadLink(download);
  if (link) {
    return (
      <Button asChild variant="secondary" size="sm" className="shrink-0">
        <a {...link}>
          <ActionIcons.download aria-hidden />
          Download
        </a>
      </Button>
    );
  }
  return <Unavailable label={download.note ?? fallback} />;
}

function Unavailable({ label }: { label: string }) {
  return (
    <span className="shrink-0 text-ui text-muted-foreground">
      {label}
    </span>
  );
}
