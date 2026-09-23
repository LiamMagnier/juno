"use client";

import * as React from "react";
import { MotionConfig } from "framer-motion";
import nextDynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  settingsHref,
  type SettingsSectionId,
} from "@/components/settings/settings-sections";
import { applyFontSize, readFontSize } from "@/components/settings/font-size";
import type { SettingsOpenedVia } from "@/components/settings/settings-modal";

/**
 * The settings modal's frame and dialog, fetched when it is first wanted
 * rather than with the shell.
 *
 * It was a static import in `(app)/layout.tsx`, so every app route downloaded
 * and compiled its whole dependency tree before it could hydrate, and that
 * tree is not small (Markdown previews pull react-markdown, highlight.js
 * grammars and KaTeX). `next/dynamic` with `ssr: false` is not allowed in a
 * Server Component, and the layout is one, so the boundary lives here, in the
 * smallest client component that can hold it.
 *
 * THE STATE LIVES HERE, NOT IN THE CHUNK. This component is in the shell, so
 * its listeners exist from hydration: the `juno:settings` event and ⌘, used
 * to be heard only once the lazy chunk had loaded, and an early click on the
 * sidebar's gear did nothing. The chunk mounts on the first open and is
 * fetched ahead of that when the browser is idle, so the first open does not
 * wait on the network.
 *
 * ON /settings THE PAGE IS THE SETTINGS. An open request there navigates the
 * page to the section instead of stacking the same content in a modal over
 * itself, and ⌘, is swallowed rather than acted on.
 *
 * `MotionConfig reducedMotion="user"` because the layout mounts this beside
 * `AppShell`, not inside it, so the shell's own MotionConfig never reaches the
 * modal.
 */
const SettingsModalImpl = nextDynamic(
  () => import("@/components/settings/settings-modal").then((m) => m.SettingsModal),
  { ssr: false }
);

export function SettingsModalLazy() {
  const router = useRouter();
  const pathname = usePathname();
  const onSettingsPage = pathname?.startsWith("/settings") ?? false;
  const onSettingsPageRef = React.useRef(onSettingsPage);
  React.useEffect(() => {
    onSettingsPageRef.current = onSettingsPage;
  }, [onSettingsPage]);

  const [open, setOpen] = React.useState(false);
  const [wanted, setWanted] = React.useState(false);
  const [section, setSection] = React.useState<SettingsSectionId>(DEFAULT_SETTINGS_SECTION);
  const [via, setVia] = React.useState<SettingsOpenedVia>("pointer");

  // Text size is a device preference, applied as early as the shell can:
  // before the lazy chunk, which is where it used to wait. The first paint
  // still uses the default size until the root layout applies it pre-paint.
  React.useLayoutEffect(() => applyFontSize(readFontSize()), []);

  React.useEffect(() => {
    const show = (next: SettingsSectionId, how: SettingsOpenedVia) => {
      if (onSettingsPageRef.current) {
        router.push(settingsHref(next));
        return;
      }
      setSection(next);
      setVia(how);
      setWanted(true);
      setOpen(true);
    };
    const handleOpen = (e: Event) => show(resolveSettingsSection((e as CustomEvent<string>).detail), "pointer");
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Claimed on /settings too, where it does nothing: the reader is
      // already in settings, and a shortcut let through here opened the
      // BROWSER's settings (Chrome and Firefox both bind ⌘,) in a new tab.
      e.preventDefault();
      if (onSettingsPageRef.current) return;
      setVia("keyboard");
      setWanted(true);
      setOpen((o) => !o);
    };
    window.addEventListener("juno:settings", handleOpen);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("juno:settings", handleOpen);
      window.removeEventListener("keydown", handleKey);
    };
  }, [router]);

  // Any navigation closes it: the reader went somewhere else.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Warm the chunk once the browser has nothing better to do.
  React.useEffect(() => {
    const load = () => void import("@/components/settings/settings-modal");
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(load, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(load, 2000);
    return () => window.clearTimeout(id);
  }, []);

  if (!wanted) return null;
  return (
    <MotionConfig reducedMotion="user">
      <SettingsModalImpl
        open={open}
        onOpenChange={setOpen}
        section={section}
        onSectionChange={setSection}
        via={via}
      />
    </MotionConfig>
  );
}
