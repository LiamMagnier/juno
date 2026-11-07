"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ActionIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, settingsHref } from "@/components/settings/settings-sections";
import { readReturnPath } from "@/components/settings/settings-modal-lazy";
import { useModalLayer } from "@/components/ui/modal-layer";
import SettingsLoading from "./loading";
import { useReducedMotion } from "@/lib/motion-preference";
import { duration, ease, transition } from "@/lib/motion";
import "@/components/settings/settings-window.css";

/** The window's settle: Apple's spring vocabulary, no bounce. */
const WINDOW_SPRING = { type: "spring", duration: duration.slow, bounce: 0 } as const;
/** It leaves faster than it came: the reader has already decided. */
const WINDOW_EXIT = { duration: duration.fast, ease: ease.in } as const;

/**
 * Settings as a WINDOW over the app (System Settings, ChatGPT and Claude all
 * draw it this way): a scrim over the shell, and one rounded window holding
 * the section rail and the pane. On a phone it is the whole screen.
 *
 * It is a layer, so it is modal like one (modal-layer.ts): the shell behind
 * is inert, scroll stays in the window, and focus goes back to whatever
 * opened Settings when it closes. Esc, ⌘, the close button and a click on
 * the scrim all close it, and closing plays its exit before the route
 * changes, so the window leaves instead of vanishing.
 */
function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = resolveSettingsSection(searchParams.get("section"));
  const reduce = useReducedMotion() ?? false;
  const mainRef = React.useRef<HTMLElement>(null);
  const layerRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(true);
  useModalLayer(layerRef, true);

  const close = React.useCallback(() => setOpen(false), []);
  const leave = React.useCallback(() => router.push(readReturnPath()), [router]);

  // A new section opens at its top. Before paint, so the pane's rise-in
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
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div ref={layerRef} tabIndex={-1} className="settings-layer fixed inset-0 z-modal outline-none">
      <AnimatePresence onExitComplete={leave}>
        {open && (
          <motion.div
            key="scrim"
            aria-hidden="true"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: transition.base }}
            exit={{ opacity: 0, transition: WINDOW_EXIT }}
            className="settings-scrim absolute inset-0 hidden md:block"
          />
        )}
        {open && (
          <div key="frame" className="pointer-events-none absolute inset-0 md:flex md:items-center md:justify-center">
          <motion.div
            key="window"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.965, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: reduce ? transition.base : WINDOW_SPRING }}
            exit={reduce ? { opacity: 0, transition: WINDOW_EXIT } : { opacity: 0, scale: 0.985, transition: WINDOW_EXIT }}
            className="settings-window pointer-events-auto flex h-full w-full flex-col overflow-hidden bg-background text-foreground md:h-[min(52rem,calc(100dvh-3rem))] md:w-[min(68rem,calc(100vw-3rem))] md:flex-row md:rounded-panel"
          >
            <aside className="@container/rail settings-rail-col relative flex shrink-0 flex-col px-3 pb-3 pt-3 md:h-full md:w-[15.5rem] md:pb-4 md:pt-4">
              <div className="mb-3 flex h-9 items-center justify-between pl-2.5 md:mb-4">
                <h1 className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-foreground">Settings</h1>
                {/* Mobile has no scrim to click, so the close lives here too. */}
                <Pressable kind="icon" size="md" onClick={close} aria-label="Close settings" className="text-muted-foreground md:hidden">
                  <ActionIcons.dismiss className="size-4" aria-hidden="true" />
                </Pressable>
              </div>
              <div className="settings-rail-in min-h-0 flex-1 overflow-y-auto no-scrollbar">
                <SettingsRail active={section} hrefFor={settingsHref} />
              </div>
            </aside>
            <main ref={mainRef} className="settings-main relative min-h-0 min-w-0 flex-1 overflow-y-auto">
              <Pressable
                kind="icon"
                size="md"
                onClick={close}
                aria-label="Close settings"
                className="sticky right-4 top-4 z-10 float-right mr-4 mt-4 hidden text-muted-foreground md:inline-flex"
              >
                <ActionIcons.dismiss className="size-4" aria-hidden="true" />
              </Pressable>
              <div className="@container/pane mx-auto w-full max-w-[42rem] px-5 pb-24 pt-6 sm:px-10 md:pt-12">
                <SettingsPane section={section} />
              </div>
            </main>
          </motion.div>
          </div>
        )}
      </AnimatePresence>
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
