"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft } from "@/components/ui/icons";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, settingsHref } from "@/components/settings/settings-sections";
import { readReturnPath } from "@/components/settings/settings-modal-lazy";
import { transition } from "@/lib/motion";
import SettingsLoading from "./loading";

/**
 * Settings as a full window (ChatGPT's model, the owner's request): its own
 * left column — Back to app, search, the grouped sections — and the pane on
 * the ground, covering the app's sidebar rather than sharing the window with
 * it. Esc and ⌘, return to where the reader came from.
 */
function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = resolveSettingsSection(searchParams.get("section"));
  const back = React.useCallback(() => router.push(readReturnPath()), [router]);
  const reduce = useReducedMotion() ?? false;
  const mainRef = React.useRef<HTMLElement>(null);

  // A new section opens at its top. The pane is remounted per section, but the
  // scroller around it is not, so a switch used to land at whatever depth the
  // reader had scrolled the last section to. Before paint, so the rise-in
  // starts from the top rather than jumping there.
  const firstSection = React.useRef(true);
  React.useLayoutEffect(() => {
    if (firstSection.current) {
      firstSection.current = false;
      return;
    }
    const main = mainRef.current;
    if (main && main.scrollTop > 0) main.scrollTop = 0;
  }, [section]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // Esc inside an open menu or a field belongs to that control.
      if (target?.closest("[role=menu],[role=listbox],[role=dialog],input,textarea,select")) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  return (
    <div className="fixed inset-0 z-modal flex flex-col bg-background text-foreground md:flex-row motion-safe:animate-fade-in">
      {/* The column settles in from its own edge while the window fades up,
          so opening settings reads as a place arriving, not a page swap. */}
      <motion.aside
        initial={reduce ? false : { opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={transition.slow}
        className="@container/rail flex shrink-0 flex-col border-b border-border/60 bg-sidebar px-3 pb-3 pt-3 md:h-full md:w-64 md:border-b-0 md:border-r md:pt-4"
      >
        <button
          type="button"
          onClick={back}
          className="group mb-3 flex h-9 items-center gap-2.5 rounded-control px-2.5 text-nav text-sidebar-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-hover hover:text-foreground md:mb-1"
        >
          <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5" />
          Back to app
        </button>
        {/* The window's own name, in the document serif, over its search.
            Only as a column: the stacked strip is too short to carry it. */}
        <h1 className="ed-h3 sr-only text-foreground md:not-sr-only md:px-2.5 md:pb-4 md:pt-5">Settings</h1>
        <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
          <SettingsRail active={section} hrefFor={settingsHref} />
        </div>
      </motion.aside>
      <main ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {/* Keyed on the section: a new section rises in under a still rail,
            rather than its rows swapping in place. */}
        <div key={section} className="@container/pane mx-auto w-full max-w-[44rem] px-5 pb-24 pt-8 motion-safe:animate-rise-in sm:px-10 md:pt-16">
          <SettingsPane section={section} />
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <React.Suspense fallback={<SettingsLoading />}>
      <SettingsPageContent />
    </React.Suspense>
  );
}
