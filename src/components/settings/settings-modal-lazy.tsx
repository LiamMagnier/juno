"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  settingsHref,
  type SettingsSectionId,
} from "@/components/settings/settings-sections";
import { applyFontSize, readFontSize } from "@/components/settings/font-size";

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

const RETURN_KEY = "alevr:settings-return";

function rememberReturnPath() {
  try {
    window.sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
  } catch {
    // Storage blocked: "Back to app" falls back to /chat.
  }
}

/** Where "Back to app" goes: the page settings was opened from, else /chat. */
export function readReturnPath(): string {
  try {
    const path = window.sessionStorage.getItem(RETURN_KEY);
    if (path && path.startsWith("/") && !path.startsWith("/settings")) return path;
  } catch {
    // ignore
  }
  return "/chat";
}

export function SettingsModalLazy() {
  const router = useRouter();
  const pathname = usePathname();
  const onSettingsPage = pathname?.startsWith("/settings") ?? false;
  const onSettingsPageRef = React.useRef(onSettingsPage);
  React.useEffect(() => {
    onSettingsPageRef.current = onSettingsPage;
  }, [onSettingsPage]);

  // Text size is a device preference, applied as early as the shell can:
  // before the lazy chunk, which is where it used to wait. The first paint
  // still uses the default size until the root layout applies it pre-paint.
  React.useLayoutEffect(() => applyFontSize(readFontSize()), []);

  React.useEffect(() => {
    // Settings is a full window now (ChatGPT's model), not a dialog over the
    // chat: every entry point navigates to /settings, remembering where the
    // reader came from so "Back to app" returns there.
    const show = (next: SettingsSectionId) => {
      if (!onSettingsPageRef.current) rememberReturnPath();
      router.push(settingsHref(next));
    };
    const handleOpen = (e: Event) => show(resolveSettingsSection((e as CustomEvent<string>).detail));
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Claimed on /settings too, where it does nothing: the reader is
      // already in settings, and a shortcut let through here opened the
      // BROWSER's settings (Chrome and Firefox both bind ⌘,) in a new tab.
      e.preventDefault();
      if (onSettingsPageRef.current) {
        router.push(readReturnPath());
        return;
      }
      rememberReturnPath();
      router.push(settingsHref(DEFAULT_SETTINGS_SECTION));
    };
    window.addEventListener("juno:settings", handleOpen);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("juno:settings", handleOpen);
      window.removeEventListener("keydown", handleKey);
    };
  }, [router]);

  // Settings opens as a page; warm the whole route while idle. A default
  // prefetch of a dynamic route stops at its loading boundary, so opening
  // Settings still waited on the server behind a skeleton; the full kind
  // brings the page itself, and opening it is instant.
  React.useEffect(() => {
    const load = () =>
      router.prefetch(settingsHref(DEFAULT_SETTINGS_SECTION), { kind: PrefetchKind.FULL });
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(load, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(load, 2000);
    return () => window.clearTimeout(id);
  }, [router]);

  return null;
}
