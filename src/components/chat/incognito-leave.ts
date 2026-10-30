/**
 * Leaving an incognito chat that has something in it asks first (spec §6.1,
 * decision D30): "End this incognito chat?" with End chat, Keep chatting and
 * Don't ask again, stored on this device.
 *
 * Asked only on in-app navigation: the band's Leave incognito, the header
 * toggle, New chat (every door that sends `juno:new-chat`), and a click on a
 * link inside the app (a sidebar row, the product switch). Closing the tab or
 * reloading asks nothing, because `beforeunload` cannot carry this copy.
 *
 * Pure helpers here (tests/chat-polish.test.ts); the dialog is
 * incognito-leave-dialog.tsx and the wiring is in chat-view.tsx.
 */

/** Per device, like the interface preferences (src/lib/ui-prefs.ts). */
export const INCOGNITO_LEAVE_KEY = "alevr:incognito-leave-confirm:v1";

/** The copy, named so the i18n catalog generator picks each string up whole. */
export const INCOGNITO_LEAVE_COPY = {
  title: "End this incognito chat?",
  body: "It isn’t saved, so leaving ends it.",
  end: "End chat",
  keep: "Keep chatting",
  dontAsk: "Don’t ask again",
} as const;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function deviceStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the person ticked Don't ask again on this device. Storage that throws reads as "ask". */
export function incognitoLeaveConfirmOff(storage: StorageLike | null = deviceStorage()): boolean {
  try {
    return storage?.getItem(INCOGNITO_LEAVE_KEY) === "off";
  } catch {
    return false;
  }
}

/** Remembers Don't ask again. A storage that refuses keeps asking, which is the safe side. */
export function setIncognitoLeaveConfirmOff(storage: StorageLike | null = deviceStorage()): void {
  try {
    storage?.setItem(INCOGNITO_LEAVE_KEY, "off");
  } catch {
    /* private browsing with storage disabled: the dialog keeps asking */
  }
}

/** Whether leaving now should ask: only an incognito chat with something in it. */
export function incognitoLeaveNeedsConfirm(input: { privateMode: boolean; hasContent: boolean; suppressed: boolean }): boolean {
  return input.privateMode && input.hasContent && !input.suppressed;
}

/** The parts of a click and its link that decide whether it navigates inside the app. */
export interface LeaveClick {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface LeaveLink {
  /** The `href` attribute as written. */
  href: string | null;
  target: string | null;
  download: boolean;
}

/**
 * Where a click on a link takes the person, when it leaves this page inside
 * the app; null when it does not (a new tab, a download, another site, a
 * fragment on this page, the page itself) or the click was not a plain
 * primary click. Modified clicks open elsewhere and leave this chat in place.
 */
export function inAppLeaveHref(click: LeaveClick, link: LeaveLink, here: { origin: string; pathname: string; search: string }): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (!link.href || link.download) return null;
  if (link.target && link.target !== "_self") return null;
  const raw = link.href.trim();
  if (!raw || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(raw, `${here.origin}${here.pathname}${here.search}`);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The same page (a fragment on it, or itself again) is not leaving.
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
