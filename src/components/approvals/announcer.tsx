"use client";

import * as React from "react";
import { isApplePlatform } from "@/components/ui/platform";
import { isGoToApproval } from "@/lib/composer-keys";
import { useUiLocale } from "@/lib/i18n-format";
import { shellString } from "@/lib/strings";

/*
 * THE APPROVAL ANNOUNCER (spec C16, §10): one per window.
 *
 *   - The first request is announced ASSERTIVELY: "Approval needed: {title}".
 *   - Further requests within 2s are batched into ONE polite announcement:
 *     "{n} approvals waiting", n counting every request in the burst.
 *   - At most one assertive announcement per 10s; a request inside that
 *     window opens a polite burst instead.
 *
 * There is no live region while an answer streams (§10); this is the only
 * other speaker besides the title and completion announcers.
 *
 * `createApprovalAnnouncer` is the clock-driven rule, tested with an injected
 * clock; `ApprovalAnnouncerProvider` (mounted once, in providers.tsx) owns the
 * two visually hidden live regions and the ⌥⌘A / Alt+Shift+A chord that
 * focuses the latest approval.
 */

export const ANNOUNCE_BATCH_MS = 2000;
export const ASSERTIVE_GAP_MS = 10_000;

export type Politeness = "assertive" | "polite";

export interface AnnouncerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: AnnouncerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ApprovalAnnouncerCore {
  /** An approval arrived with this title. */
  request(title: string): void;
  dispose(): void;
}

export function createApprovalAnnouncer(
  speak: (message: string, politeness: Politeness) => void,
  { clock = realClock, locale = () => "en" }: { clock?: AnnouncerClock; locale?: () => string } = {},
): ApprovalAnnouncerCore {
  let lastAssertiveAt = -Infinity;
  let burst: { count: number; announcedFirst: boolean; timer: unknown } | null = null;

  const closeBurst = () => {
    if (!burst) return;
    const { count, announcedFirst } = burst;
    burst = null;
    // The first of the burst was already spoken; say the total only if more joined it.
    if (count > (announcedFirst ? 1 : 0)) speak(shellString("approval.announceMany", { n: count }, locale()), "polite");
  };

  return {
    request(title) {
      const now = clock.now();
      if (burst) {
        burst.count += 1;
        return;
      }
      if (now - lastAssertiveAt >= ASSERTIVE_GAP_MS) {
        lastAssertiveAt = now;
        speak(shellString("approval.announceOne", { title }, locale()), "assertive");
        burst = { count: 1, announcedFirst: true, timer: clock.setTimeout(closeBurst, ANNOUNCE_BATCH_MS) };
        return;
      }
      // Inside the 10s assertive limit: a polite burst, spoken once at its end.
      burst = { count: 1, announcedFirst: false, timer: clock.setTimeout(closeBurst, ANNOUNCE_BATCH_MS) };
    },
    dispose() {
      if (burst) clock.clearTimeout(burst.timer);
      burst = null;
    },
  };
}

/** The approvals on the page, in document order (ApprovalActions marks its container). */
export const APPROVAL_CONTAINER_SELECTOR = "[data-approval-container]:not([data-approval-resolved])";

/** Focuses the latest open approval; returns whether there was one. */
export function focusLatestApproval(doc: Document = document): boolean {
  const all = doc.querySelectorAll<HTMLElement>(APPROVAL_CONTAINER_SELECTOR);
  const latest = all[all.length - 1];
  if (!latest) return false;
  latest.focus({ preventScroll: false });
  latest.scrollIntoView?.({ block: "nearest" });
  return true;
}

const AnnouncerContext = React.createContext<ApprovalAnnouncerCore | null>(null);

const noop: ApprovalAnnouncerCore = { request: () => {}, dispose: () => {} };

/** The window's announcer; a no-op outside the provider (a test, an isolated gallery). */
export function useApprovalAnnouncer(): ApprovalAnnouncerCore {
  return React.useContext(AnnouncerContext) ?? noop;
}

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function ApprovalAnnouncerProvider({ children }: { children: React.ReactNode }) {
  const locale = useUiLocale();
  const localeRef = React.useRef(locale);
  localeRef.current = locale;
  const polite = React.useRef<HTMLDivElement>(null);
  const assertive = React.useRef<HTMLDivElement>(null);

  const core = React.useMemo(
    () =>
      createApprovalAnnouncer(
        (message, politeness) => {
          const region = (politeness === "assertive" ? assertive : polite).current;
          if (!region) return;
          // Clear, then set on the next frame, so the same words are spoken again.
          region.textContent = "";
          requestAnimationFrame(() => {
            region.textContent = message;
          });
        },
        { locale: () => localeRef.current },
      ),
    [],
  );
  React.useEffect(() => () => core.dispose(), [core]);

  // ⌥⌘A (Alt+Shift+A on Windows and Linux) focuses the latest approval, from anywhere.
  React.useEffect(() => {
    const apple = isApplePlatform();
    const onKey = (event: KeyboardEvent) => {
      if (!isGoToApproval(event, apple)) return;
      if (focusLatestApproval()) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <AnnouncerContext.Provider value={core}>
      {children}
      <div ref={polite} aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN} data-approval-announcer="polite" />
      <div ref={assertive} aria-live="assertive" aria-atomic="true" style={VISUALLY_HIDDEN} data-approval-announcer="assertive" />
    </AnnouncerContext.Provider>
  );
}
