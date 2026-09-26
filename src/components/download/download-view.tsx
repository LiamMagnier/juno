import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, Globe, Monitor, Smartphone } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { ProductShot, hasProductShot } from "@/components/landing/product-shot";
import { Plate } from "@/components/landing/plate";
import { LandingColumn } from "@/components/landing/section";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { downloadLink, type AppDownload, type DownloadPlatform } from "@/lib/app-downloads";
import { staggerDelay } from "@/lib/motion";
import { formatBytes } from "@/lib/utils";

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
        .join("  ·  ")
    : null;
  const blocked = Boolean(mac?.available && mac.notarized === false);

  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      <SiteHeader />

      <main>
        <LandingColumn contentClassName="flex flex-col items-center pb-10 pt-10 text-center sm:pb-14 sm:pt-16">
          <h1 style={staggerDelay(0, "loose")} className={`text-balance font-serif text-hero font-medium tracking-tight ${ENTER}`}>
            Download Juno for Mac
          </h1>
          <p
            style={staggerDelay(1, "loose")}
            className={`mt-4 max-w-[32rem] text-pretty text-body-lg text-muted-foreground ${ENTER}`}
          >
            Chat and Juno Code in one native app. Same account, same conversations, same projects.
          </p>
          <div style={staggerDelay(2, "loose")} className={`mt-8 flex flex-col items-center ${ENTER}`}>
            {macLink ? (
              <Button asChild size="lg">
                <a {...macLink}>
                  <ActionIcons.download aria-hidden />
                  Download for macOS
                </a>
              </Button>
            ) : (
              <span className="inline-flex h-11 items-center rounded-field bg-secondary px-6 text-body font-medium text-muted-foreground">
                {mac?.note ?? "Mac build not published yet"}
              </span>
            )}
            {macFacts && <p className="mt-3 font-mono text-caption text-muted-foreground">{macFacts}</p>}
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
        </LandingColumn>

        <div style={staggerDelay(3, "loose")} className={`mx-auto w-full max-w-[80rem] px-3 sm:px-6 ${ENTER}`}>
          <MacStage />
        </div>

        <LandingColumn contentClassName="py-16 sm:py-24">
          <h2 className="font-serif text-display font-medium tracking-tight">Also on your other devices</h2>
          <div className="mt-8 grid gap-4 lg:grid-cols-12">
            <div className="stage flex min-h-72 flex-col justify-end rounded-stage lg:col-span-7 lg:row-span-2">
              <Plate name="path" dim sizes="(min-width: 1024px) 700px, 100vw" imageClassName="object-[50%_65%]" />
              <div className="relative m-3 flex flex-col gap-4 rounded-panel bg-card/85 p-5 backdrop-blur-xl sm:m-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <div className="flex items-start gap-3.5">
                  <Smartphone className="mt-0.5 size-5 shrink-0 text-foreground" aria-hidden />
                  <div>
                    <h3 className="text-heading">iPhone and iPad</h3>
                    <p className="mt-1 text-body text-muted-foreground">Voice, camera and your projects, synced.</p>
                  </div>
                </div>
                <PlatformAction download={ios} fallback="On the App Store soon" />
              </div>
            </div>

            <OtherCell
              icon={Globe}
              title="In your browser"
              body="Nothing to install. Everything you do syncs with the apps."
              action={
                <Button asChild variant="secondary" size="sm">
                  <Link href="/sign-in">
                    Open Juno
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              }
            />
            <OtherCell
              icon={Monitor}
              title="Windows"
              body="A native Windows app is on the way. Until then, Juno runs in any browser."
              action={<PlatformAction download={windows} fallback="Not published yet" />}
            />
          </div>

          <details className="group mt-10 rounded-card border border-border/70 px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xs text-body font-medium">
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
    <div className="surface-raised flex flex-col justify-between gap-5 rounded-stage p-6 lg:col-span-5">
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
 * The Mac app on the valley plate: the real window when the snapshot render
 * exists, otherwise the app's own icon, large, the way a store page shows it.
 * No live chat preview here: that needs the model registry, which is
 * server-only, and this page is also rendered by the feed tests.
 */
const MAC_SHOT = "mac-chat-empty";

function MacStage() {
  const shot = hasProductShot(MAC_SHOT);
  return (
    <div className="stage rounded-stage">
      <Plate name="valley" priority sizes="(min-width: 1280px) 1200px, 100vw" imageClassName="object-[30%_50%] sm:object-center" />
      {shot ? (
        <div className="relative px-4 pt-10 sm:px-[7%] sm:pt-[6%]">
          <div className="scroll-settle stage-window mx-auto max-w-[62rem] overflow-hidden rounded-t-panel">
            <ProductShot
              name={MAC_SHOT}
              alt="Juno for Mac, ready for a new conversation"
              width={2400}
              height={1500}
              priority
              sizes="(min-width: 1280px) 1000px, 92vw"
            />
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-[22rem] items-center justify-center sm:min-h-[30rem]">
          <Image
            src="/brand/app-icon-mac.png"
            alt="The Juno app icon"
            width={512}
            height={512}
            priority
            className="scroll-settle size-36 drop-shadow-2xl sm:size-48"
          />
        </div>
      )}
    </div>
  );
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
    <span className="inline-flex h-8 w-fit shrink-0 items-center rounded-full bg-secondary px-3 text-ui font-medium text-muted-foreground">
      {label}
    </span>
  );
}
