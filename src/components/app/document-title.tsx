"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { useApp } from "@/components/app/app-provider";
import { titleForPath, truncateTitle } from "@/lib/route-title";

/**
 * Sets `document.title` for every authenticated route. Renders nothing.
 *
 * Every tab, bookmark and OS window-switcher entry used to read "Juno": the
 * root layout declares a `%s · Juno` template, but exactly one of the 39
 * authenticated pages exports metadata, and 25 of the rest are `"use client"`
 * so they cannot. With three Juno tabs open there was no way to tell a
 * conversation from Settings from the Library.
 *
 * It reads the conversation out of the provider rather than taking a prop,
 * because the title of a new chat is written by the model a second or two after
 * the first reply starts — the tab has to follow that rename, and only the
 * provider's list sees it land.
 *
 * Deliberately imperative and deliberately client-only: this never reaches the
 * SSR HTML or a link preview. That is correct here (every `(app)` route is
 * behind auth and `force-dynamic`) and wrong anywhere else — marketing and
 * legal pages need real `metadata` exports.
 */
export function DocumentTitle() {
  const pathname = usePathname();
  const { activeConversationId, conversations } = useApp();

  const conversationTitle =
    pathname.startsWith("/chat/") && activeConversationId
      ? conversations.find((c) => c.id === activeConversationId)?.title?.trim() || null
      : null;

  React.useEffect(() => {
    const name = titleForPath(pathname);
    const desired = conversationTitle
      ? `${truncateTitle(conversationTitle)} · Juno`
      : // "Juno · Juno" is what the template would produce for the new-chat
        // screen, which has no subject of its own yet.
        name === "Juno"
        ? "Juno"
        : `${name} · Juno`;

    const apply = () => {
      if (document.title !== desired) document.title = desired;
    };
    apply();

    // …and then hold it. Next renders its own <title> from the metadata tree
    // and React inserts it into <head> during hydration — AFTER this effect
    // has run on a hard load. Measured: the tab showed "Library · Juno" at
    // ~500ms and settled back on "Juno", i.e. it was wrong for exactly the case
    // that matters most, opening a bookmark or a pasted link. Re-asserting on
    // head mutations is deterministic where a setTimeout would be a guess.
    // Writing document.title mutates the <title> text node and re-enters this
    // callback once; the equality check above ends it there.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname, conversationTitle]);

  return null;
}
