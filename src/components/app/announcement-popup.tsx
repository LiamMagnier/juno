"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProviderLogo } from "@/components/brand/provider-logo";
import type { ClientAnnouncement } from "@/lib/announcements";

function AnnouncementVisual({ announcement }: { announcement: ClientAnnouncement }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // Nudge autoplay: some browsers block it until the element is ready even when muted.
  React.useEffect(() => {
    const v = videoRef.current;
    if (v) v.play().catch(() => {});
  }, []);

  if (announcement.videoUrl) {
    return (
      <video
        ref={videoRef}
        src={announcement.videoUrl}
        poster={announcement.imageUrl ?? undefined}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        // Clean hero clip — no player chrome. Tapping replays if a browser paused it.
        onClick={() => videoRef.current?.play().catch(() => {})}
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
        <ProviderLogo provider={announcement.provider} className="h-20 w-20 rounded-[24%]" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted text-primary">
      <Sparkles className="h-16 w-16" />
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
        className="max-h-[calc(100dvh-1rem)] max-w-4xl overflow-y-auto overscroll-contain rounded-panel p-0 border border-border/85 bg-background shadow-glass lg:overflow-hidden"
      >
        <DialogClose className="absolute right-4 top-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/70 text-muted-foreground backdrop-blur-sm transition-all duration-fast ease-out-soft hover:bg-background hover:text-foreground hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-11 coarse:w-11">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
        <div className="grid gap-8 p-6 lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]">
          <div className="h-64 overflow-hidden rounded-md bg-muted sm:h-80 lg:h-[26rem] w-full shrink-0">
            <AnnouncementVisual announcement={announcement} />
          </div>
          <div className="flex min-h-0 flex-col justify-between gap-6 py-2 lg:min-h-[26rem] pr-2">
            <DialogHeader className="text-left">
              <div className="flex items-start justify-between gap-4 pr-12">
                <div>
                  {announcement.modelName && (
                    <div className="mb-2 font-mono text-label uppercase text-primary">{announcement.modelName}</div>
                  )}
                  <DialogTitle className="font-serif text-2xl font-normal leading-tight sm:text-3xl text-foreground">{announcement.title}</DialogTitle>
                </div>
                {announcement.provider && <ProviderLogo provider={announcement.provider} className="h-10 w-10 rounded-[24%] border-0 shadow-none shrink-0" />}
              </div>
              <DialogDescription className="max-w-xl pt-4 text-base leading-relaxed text-muted-foreground lg:max-w-md lg:pt-6">
                {announcement.description}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center justify-end gap-3 mt-6">
              {announcement.newsHref ? (
                <Button
                  variant="outline"
                  onClick={() => followHref(announcement.newsHref)}
                  className="h-10 gap-1.5 rounded-md px-5 font-sans text-[14px] font-semibold hover:bg-muted"
                >
                  {announcement.newsLabel || "Read The News"}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={dismiss}
                  className="h-10 rounded-md px-5 font-sans text-[14px] font-semibold text-muted-foreground hover:text-foreground"
                >
                  Not now
                </Button>
              )}
              {announcement.ctaLabel && announcement.ctaHref && (
                <Button
                  onClick={() => followHref(announcement.ctaHref)}
                  className="group h-10 gap-1.5 rounded-md px-5 font-sans text-[14px] font-semibold shadow-soft hover:-translate-y-px active:translate-y-0"
                >
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
