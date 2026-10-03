"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { AnnouncementDialog, AnnouncementCard, type AnnouncementView } from "@/components/app/announcement-popup";

const BASE: AnnouncementView = {
  title: "Introducing Claude Opus 5.5",
  description:
    "Anthropic's most capable model yet: stronger long-horizon coding, sharper research, and better judgement on hard problems. It's in the model picker now.",
  imageUrl: null,
  videoUrl: null,
  provider: "anthropic",
  modelName: "Opus 5.5",
  newsLabel: "Read the news",
  newsHref: "https://www.anthropic.com/news",
  ctaLabel: "Try it now",
  ctaHref: "/chat",
  startsAt: "2026-10-02T09:00:00.000Z",
};

const FIXTURES: Record<string, { label: string; view: AnnouncementView }> = {
  video: { label: "Video", view: { ...BASE, videoUrl: "/dev/announcement-media/orbit.mp4", imageUrl: "/dev/announcement-media/orbit-poster.jpg" } },
  image: { label: "Image", view: { ...BASE, imageUrl: "/dev/announcement-media/orbit-poster.jpg" } },
  logo: { label: "Provider logo image", view: { ...BASE, imageUrl: "/provider-logos/light/anthropic.png" } },
  none: { label: "No media", view: BASE },
  plain: {
    label: "No media, no provider",
    view: { ...BASE, provider: null, modelName: null, newsHref: null, title: "Projects now keep their own memory", ctaLabel: "Open Projects", ctaHref: "/projects" },
  },
  long: {
    label: "Long title",
    view: {
      ...BASE,
      videoUrl: "/dev/announcement-media/orbit.mp4",
      title: "Introducing Claude Opus 5.5, with a one-million-token context window and native computer use across every workspace",
      description:
        "A longer description to check the measure.\n\nIt keeps paragraphs, wraps at a readable width, and the dialog scrolls inside itself on short screens instead of pushing its actions off the page.",
    },
  },
  broken: { label: "Broken video URL", view: { ...BASE, videoUrl: "/dev/announcement/missing.mp4" } },
};

export function AnnouncementGallery({ initial, theme }: { initial: string; theme?: "light" | "dark" }) {
  const { setTheme, resolvedTheme } = useTheme();
  React.useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const [key, setKey] = React.useState(FIXTURES[initial] ? initial : "video");
  const [open, setOpen] = React.useState(true);
  const fixture = FIXTURES[key];

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-display">Announcement</h1>
          <p className="text-caption text-muted-foreground">Dev gallery. The dialog renders against fixtures; the panel below is the admin preview.</p>
        </div>
        <button type="button" className="text-caption underline" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          Theme: {mounted ? resolvedTheme : ""}
        </button>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Fixtures">
        {Object.entries(FIXTURES).map(([k, f]) => (
          <button
            key={k}
            type="button"
            data-fixture={k}
            onClick={() => {
              setKey(k);
              setOpen(true);
            }}
            className="rounded-control border border-border px-3 py-1.5 text-caption hover:bg-accent aria-pressed:bg-accent"
            aria-pressed={k === key}
          >
            {f.label}
          </button>
        ))}
      </nav>
      <section className="ann ann-preview w-full max-w-[40rem] overflow-hidden rounded-panel overlay-glass" aria-label="Admin preview">
        <AnnouncementCard key={key} announcement={fixture.view} animate={false} />
      </section>
      <AnnouncementDialog key={`d-${key}`} announcement={fixture.view} open={open} onOpenChange={setOpen} onFollow={() => setOpen(false)} />
    </main>
  );
}
