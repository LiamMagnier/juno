"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Pause, Play } from "@/components/ui/icons";
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { Construction } from "@/components/home/construction";
import type { ClientAnnouncement } from "@/lib/announcements";
import { PROVIDERS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import "./announcement.css";

/** The fields the card draws. The admin preview passes a draft in this shape. */
export type AnnouncementView = Pick<
  ClientAnnouncement,
  "title" | "description" | "imageUrl" | "videoUrl" | "provider" | "modelName" | "newsLabel" | "newsHref" | "ctaLabel" | "ctaHref"
> & { startsAt?: string | null };

/**
 * `prefers-reduced-motion`, read as state after mount so the SSR markup does
 * not commit to either answer. `autoPlay`/`loop` are attributes the CSS
 * reduced-motion block cannot reach, so the video needs it as a value.
 */
export function useReducedMotionPref(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * What the frame shows with no media, while media loads, and if it fails: the
 * homepage's construction, drawn once on arrival, with the provider's mark as
 * the centre node. A broken or slow URL can therefore never leave an empty box.
 */
function MediaFallback({ provider, animate }: { provider: AnnouncementView["provider"]; animate: boolean }) {
  return (
    <div className="ann-fallback alv" aria-hidden="true">
      <div className="ann-fallback-drawing">
        <Construction animate={animate} ticks={false} />
      </div>
      <span className="ann-fallback-mark">
        {provider ? <ProviderLogo provider={provider} /> : <ContinuumMark size={28} tone="current" />}
      </span>
    </div>
  );
}

type MediaState = "loading" | "ready" | "failed";

/**
 * The media: a looping muted clip, an image, or the construction. The media
 * layer fades in over the construction once it can actually paint, so a slow
 * connection sees the drawing rather than a grey rectangle, and a failed load
 * simply never covers it.
 */
export function AnnouncementMedia({ announcement, animate = true }: { announcement: AnnouncementView; animate?: boolean }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const reduced = useReducedMotionPref();
  const [state, setState] = React.useState<MediaState>("loading");
  const [playing, setPlaying] = React.useState(false);
  const src = announcement.videoUrl || announcement.imageUrl || "";

  React.useEffect(() => {
    setState("loading");
  }, [src]);

  // An image that finished before hydration never fires onLoad.
  React.useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) setState(img.naturalWidth > 0 ? "ready" : "failed");
  }, [src]);

  // Autoplay, nudged: some browsers hold a muted autoplay until the element
  // is told to play. Reduced motion gets the first frame and a play control.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (reduced) {
      v.pause();
      return;
    }
    v.play().catch(() => {});
  }, [reduced, announcement.videoUrl]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const showFallback = state !== "ready" || !src;

  return (
    <div className="ann-media" data-media-state={src ? state : "none"}>
      {showFallback && <MediaFallback provider={announcement.provider} animate={animate} />}
      {announcement.videoUrl ? (
        <>
          <video
            ref={videoRef}
            key={announcement.videoUrl}
            src={announcement.videoUrl}
            poster={announcement.imageUrl ?? undefined}
            className="ann-media-layer"
            data-ready={state === "ready" ? "" : undefined}
            autoPlay={!reduced}
            loop
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            aria-hidden="true"
            onLoadedData={() => setState("ready")}
            onError={() => setState("failed")}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          {state === "ready" && (
            <button
              type="button"
              className="ann-media-control"
              onClick={toggle}
              aria-label={playing ? "Pause video" : "Play video"}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            </button>
          )}
        </>
      ) : announcement.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- /api/files URLs are session-authorised; the optimiser cannot fetch them.
        <img
          ref={imgRef}
          key={announcement.imageUrl}
          src={announcement.imageUrl}
          alt=""
          draggable={false}
          className="ann-media-layer"
          data-ready={state === "ready" ? "" : undefined}
          data-contain={announcement.imageUrl.includes("/provider-logos/") ? "" : undefined}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      ) : null}
    </div>
  );
}

function releaseDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // A fixed locale and zone: the admin preview is server-rendered, and a
  // reader-locale date would differ between the server and the browser.
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/**
 * The card's body. `inDialog` swaps the heading and description for Radix's
 * Title/Description so the dialog is labelled by them; the admin preview
 * renders the same markup outside a dialog with plain elements.
 */
export function AnnouncementCard({
  announcement,
  inDialog = false,
  onNews,
  onCta,
  onDismiss,
  animate = true,
}: {
  announcement: AnnouncementView;
  inDialog?: boolean;
  onNews?: () => void;
  onCta?: () => void;
  onDismiss?: () => void;
  animate?: boolean;
}) {
  const Title = inDialog ? DialogTitle : "h2";
  const Description = inDialog ? DialogDescription : "p";
  const date = releaseDate(announcement.startsAt);
  const providerLabel = announcement.provider ? PROVIDERS[announcement.provider]?.label : null;
  const annotation = announcement.modelName || providerLabel;
  const hasCta = Boolean(announcement.ctaLabel && announcement.ctaHref);
  const inert = !inDialog;

  return (
    <>
      <AnnouncementMedia announcement={announcement} animate={animate} />
      <div className="ann-copy">
        {(annotation || date) && (
          <p className="ann-annot ann-rise" style={{ ["--i" as string]: 0 }}>
            {announcement.provider && <ProviderLogo provider={announcement.provider} />}
            {annotation && <span>{annotation}</span>}
            {date && <time dateTime={announcement.startsAt ?? undefined}>{date}</time>}
          </p>
        )}
        <Title className="ann-title ann-rise" style={{ ["--i" as string]: 1 }}>
          {announcement.title}
        </Title>
        <Description className="ann-body ann-rise" style={{ ["--i" as string]: 2 }}>
          {announcement.description}
        </Description>
        <div className="ann-actions ann-rise" style={{ ["--i" as string]: 3 }}>
          {announcement.newsHref ? (
            <button
              type="button"
              className="ann-btn ann-btn-secondary"
              onClick={onNews}
              tabIndex={inert ? -1 : undefined}
              aria-disabled={inert || undefined}
            >
              {announcement.newsLabel || "Read more"}
            </button>
          ) : (
            <button
              type="button"
              className="ann-btn ann-btn-quiet"
              onClick={onDismiss}
              tabIndex={inert ? -1 : undefined}
              aria-disabled={inert || undefined}
            >
              Not now
            </button>
          )}
          {hasCta && (
            <button
              type="button"
              className="ann-btn ann-btn-primary"
              onClick={onCta}
              tabIndex={inert ? -1 : undefined}
              aria-disabled={inert || undefined}
            >
              {announcement.ctaLabel}
              <ArrowRight aria-hidden />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** The dialog around the card. Separate from the fetch so the dev gallery can drive it. */
export function AnnouncementDialog({
  announcement,
  open,
  onOpenChange,
  onFollow,
}: {
  announcement: AnnouncementView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFollow: (href?: string | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        // Focus lands on the dialog itself (Radix gives it tabIndex -1), so a
        // screen reader announces the labelled dialog and no button opens
        // wearing a focus ring it was never asked for. Tab reaches the controls.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className={cn(
          // flex, not the primitive's grid: a grid row shrinks the 16:9 media
          // to fit max-h, and the copy then rode up over the frame.
          "ann flex max-h-[calc(100dvh-2rem)] max-w-[40rem] flex-col gap-0 overflow-y-auto overscroll-contain p-0 sm:p-0"
        )}
      >
        <AnnouncementCard
          announcement={announcement}
          inDialog
          onNews={() => onFollow(announcement.newsHref)}
          onCta={() => onFollow(announcement.ctaHref)}
          onDismiss={() => onOpenChange(false)}
        />
        {/* Over the media's corner, on the floating chip, so it stays findable over any frame. */}
        <DialogCloseButton className="right-3.5 top-3.5 z-20 bg-popover/85 shadow-pop backdrop-blur-sm" />
      </DialogContent>
    </Dialog>
  );
}

const DISMISSED_KEY = "juno:dismissed_announcements";

export function AnnouncementPopup() {
  const router = useRouter();
  const pathname = usePathname();
  const [announcement, setAnnouncement] = React.useState<ClientAnnouncement | null>(null);
  const [open, setOpen] = React.useState(false);
  const dismissedRef = React.useRef<string | null>(null);

  const [onboardingDone, setOnboardingDone] = React.useState(true);

  // Don't compete with the first-run onboarding overlay for clicks.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setOnboardingDone(!window.__junoOnboardingActive);
    const start = () => setOnboardingDone(false);
    const end = () => setOnboardingDone(true);
    window.addEventListener("juno:onboarding-start", start);
    window.addEventListener("juno:onboarding-end", end);
    return () => {
      window.removeEventListener("juno:onboarding-start", start);
      window.removeEventListener("juno:onboarding-end", end);
    };
  }, []);

  React.useEffect(() => {
    if (pathname?.startsWith("/admin")) return;
    const controller = new AbortController();

    fetch("/api/announcements", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.announcement) {
          try {
            const dismissedList = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
            if (dismissedList.includes(data.announcement.id)) return;
          } catch {}
          setAnnouncement(data.announcement);
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [pathname]);

  // Open only once onboarding has stood down (or was never showing).
  React.useEffect(() => {
    if (announcement && onboardingDone && dismissedRef.current !== announcement.id) {
      setOpen(true);
    }
  }, [announcement, onboardingDone]);

  const dismiss = React.useCallback(async () => {
    if (!announcement || dismissedRef.current === announcement.id) return;
    dismissedRef.current = announcement.id;
    setOpen(false);

    try {
      const dismissedList = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
      if (!dismissedList.includes(announcement.id)) {
        dismissedList.push(announcement.id);
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissedList));
      }
    } catch {}

    await fetch(`/api/announcements/${announcement.id}/dismiss`, { method: "POST" }).catch(() => {});
  }, [announcement]);

  const followHref = async (href?: string | null) => {
    await dismiss();
    if (!href) return;
    if (href.startsWith("/")) {
      router.push(href);
    } else {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };

  if (!announcement) return null;

  return (
    <AnnouncementDialog
      announcement={announcement}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
        else setOpen(true);
      }}
      onFollow={followHref}
    />
  );
}
