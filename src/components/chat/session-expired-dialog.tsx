"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/components/app/app-provider";
import {
  currentSessionExpired,
  dismissSessionExpired,
  signInUrlFor,
  stashUnsentTurn,
  subscribeSessionExpired,
  takeUnsentTurn,
} from "@/lib/chat/session-expired";

/** Copy, named so scripts/generate-i18n-catalog.mjs picks it up. */
const sessionEndedTitle = "Your session ended";
const sessionEndedKeepsMessage =
  "Sign in again to keep going. Your message wasn’t sent. It will be waiting in the message box when you’re back.";
const sessionEndedCopyFirstMessage =
  "Sign in again to keep going. Your message wasn’t sent, and this browser can’t hold it for you, so copy it first if you want to keep it.";
const sessionEndedReturnsMessage = "Sign in again to keep going. You’ll come back to this chat.";
const sessionEndedIncognitoMessage =
  "Sign in again to keep going. Incognito chats aren’t kept, so copy your message first if you want to keep it.";
const unsentRestoredMessage = "Your unsent message is back in the message box.";

function tabStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this tab can carry the words across the sign-in redirect at all. */
function storageWorks(): boolean {
  const storage = tabStorage();
  if (!storage) return false;
  try {
    const probe = "juno:session-expired:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Your session ended": what a send that came back 401 shows
 * (lib/chat/session-expired.ts), in place of the route's 401 text in the
 * assistant's bubble.
 *
 * Sign in again keeps the unsent words in this tab, goes through sign-in and
 * comes back to the same page; this component, mounted there again, hands the
 * words to the composer. Not now closes it: the unsent turn stays in the
 * transcript with its Retry send, and the composer keeps whatever it held.
 */
export function SessionExpiredDialog() {
  const { user } = useApp();
  const turn = React.useSyncExternalStore(subscribeSessionExpired, currentSessionExpired, () => null);
  const [leaving, setLeaving] = React.useState(false);
  const canKeep = React.useMemo(() => (turn ? storageWorks() : false), [turn]);

  // Back from sign-in: the stashed words go into the message box, after
  // whatever the composer restored on its own. A tick later than mount, so
  // the composer's listener (registered in the same commit) is in place.
  React.useEffect(() => {
    if (!user?.id) return;
    const restored = takeUnsentTurn(tabStorage(), {
      pathname: window.location.pathname,
      userId: user.id,
      now: Date.now(),
    });
    if (!restored?.text) return;
    const text = restored.text;
    // Deliberately not cancelled by a cleanup: the stash is taken (and
    // removed) on the first run, so a second run — React's development
    // double-invoke, a remount — finds nothing, and a cleanup that cleared
    // this timer would lose the words.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: { text, append: true } }));
      toast(unsentRestoredMessage);
    }, 0);
  }, [user?.id]);

  const signInAgain = React.useCallback(() => {
    if (!turn) return;
    setLeaving(true);
    if (turn.text) stashUnsentTurn(tabStorage(), turn, user?.id ?? "", Date.now());
    window.location.assign(signInUrlFor(turn.returnTo));
  }, [turn, user?.id]);

  const description = turn?.incognito
    ? sessionEndedIncognitoMessage
    : !turn?.text
      ? sessionEndedReturnsMessage
      : canKeep
        ? sessionEndedKeepsMessage
        : sessionEndedCopyFirstMessage;

  return (
    <Dialog
      open={turn !== null}
      onOpenChange={(open) => {
        if (!open && !leaving) dismissSessionExpired();
      }}
    >
      <DialogContent className="max-w-sm" data-session-expired="">
        <DialogHeader>
          <DialogTitle>{sessionEndedTitle}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dismissSessionExpired()} disabled={leaving}>
            Not now
          </Button>
          <Button onClick={signInAgain} loading={leaving}>
            Sign in again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
