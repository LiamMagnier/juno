"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { JunoMark } from "@/components/brand/logo";
import { ProviderLogo } from "@/components/brand/provider-logo";
import type { ClientAnnouncement } from "@/lib/announcements";

function AnnouncementVisual({ announcement }: { announcement: ClientAnnouncement }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  // The one thing in the shell that loops forever in the user's peripheral
  // vision. `prefers-reduced-motion` has to reach it too: read after mount so
  // the SSR markup does not commit to either answer.
  const [reducedMotion, setReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", sync);
    sync();
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Nudge autoplay: some browsers block it until the element is ready even when muted.
  React.useEffect(() => {
    const v = videoRef.current;
    if (v && !reducedMotion) v.play().catch(() => {});
  }, [reducedMotion]);

  if (announcement.videoUrl) {
    return (
      <video
        ref={videoRef}
        src={announcement.videoUrl}
        poster={announcement.imageUrl ?? undefined}
        // Reduced motion gets the poster frame and a real control bar instead of
        // a clip that restarts every few seconds behind the text being read.
        autoPlay={!reducedMotion}
        muted
        loop={!reducedMotion}
        controls={reducedMotion}
        playsInline
        preload="auto"
        // Clean hero clip — no player chrome. Tapping replays if a browser paused it.
        onClick={() => !reducedMotion && videoRef.current?.play().catch(() => {})}
        className="h-full w-full cursor-default bg-muted object-cover"
      />
    );
  }

  if (announcement.imageUrl) {
    const logoLike = announcement.imageUrl.includes("/provider-logos/");
    return (
      <img
        src={announcement.imageUrl}
        alt=""
        className={logoLike ? "h-full w-full bg-muted object-contain p-12" : "h-full w-full object-cover"}
        draggable={false}
      />
    );
  }

  if (announcement.provider) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <ProviderLogo provider={announcement.provider} className="h-20 w-20" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted text-foreground/70">
      <JunoMark className="h-14 w-14" />
    </div>
  );
}

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
            const dismissedList = JSON.parse(localStorage.getItem("juno:dismissed_announcements") || "[]");
            if (dismissedList.includes(data.announcement.id)) {
              return;
            }
          } catch (e) {}

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
      const dismissedList = JSON.parse(localStorage.getItem("juno:dismissed_announcements") || "[]");
      if (!dismissedList.includes(announcement.id)) {
        dismissedList.push(announcement.id);
        localStorage.setItem("juno:dismissed_announcements", JSON.stringify(dismissedList));
      }
    } catch (e) {}

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
        else setOpen(true);
      }}
    >
      <DialogContent
        hideClose
        className="max-h-[calc(100dvh-1rem)] max-w-4xl overflow-y-auto overscroll-contain p-0 lg:overflow-hidden"
      >
        {/* shadow-pop, not Tailwind's stock shadow-sm. `shadow-sm` is
            `0 1px 2px rgb(0 0 0 / 0.05)` — off the theme-aware --shadow-* ladder
            and invisible at 5% black on the dark theme, which is precisely where
            this button floats over arbitrary bright media and most needs an edge. */}
        <DialogCloseButton className="z-20 bg-popover/85 shadow-pop backdrop-blur-sm" />
        <div className="grid gap-8 p-6 lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]">
          {/* Full --border. At /50 on dark this hairline resolved to ~8%, DARKER
              than both the --muted fill inside it and the --popover shell around
              it, so the frame read as a groove rather than an edge. */}
          <div className="h-64 w-full shrink-0 overflow-hidden rounded-card border border-border bg-muted sm:h-80 lg:h-[26rem]">
            <AnnouncementVisual announcement={announcement} />
          </div>
          <div className="flex min-h-0 flex-col justify-between gap-6 py-2 pr-2 lg:min-h-[26rem]">
            <DialogHeader className="text-left">
              <div className="flex items-start justify-between gap-4 pr-12">
                <div>
                  {announcement.modelName && (
                    <div className="mb-2 font-mono text-label uppercase text-muted-foreground">{announcement.modelName}</div>
                  )}
                  {/* `font-serif text-title` — the scale's rung for a modal
                      heading, and the family every sibling modal already uses.
                      `xl`/`2xl` are Tailwind defaults, not rungs on this
                      project's scale, and this was the one modal title in the
                      shell set in the UI face. */}
                  <DialogTitle className="font-serif text-title leading-tight text-foreground">
                    {announcement.title}
                  </DialogTitle>
                </div>
                {announcement.provider && (
                  <ProviderLogo provider={announcement.provider} className="h-10 w-10 shrink-0 border-0 shadow-none" />
                )}
              </div>
              <DialogDescription className="max-w-xl pt-4 text-body leading-relaxed text-muted-foreground lg:max-w-md lg:pt-6">
                {announcement.description}
              </DialogDescription>
            </DialogHeader>

            {/* No `mt-6`: the parent column is already `justify-between gap-6`,
                so the margin stacked a second 24px onto the gap and the action
                row sat further from the copy than any other modal's does. */}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {announcement.newsHref ? (
                <Button variant="outline" onClick={() => followHref(announcement.newsHref)}>
                  {announcement.newsLabel || "Read more"}
                </Button>
              ) : (
                <Button variant="ghost" onClick={dismiss} className="text-muted-foreground hover:text-foreground">
                  Not now
                </Button>
              )}
              {announcement.ctaLabel && announcement.ctaHref && (
                <Button onClick={() => followHref(announcement.ctaHref)} className="group gap-1.5">
                  {announcement.ctaLabel}
                  <ArrowRight className="h-4 w-4 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
