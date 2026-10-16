"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FilePlus } from "@/components/ui/icons";
import { Phrase, formatPhrase, usePhrase } from "@/lib/i18n-phrase";
import { requestJson } from "@/lib/artifact-response";

/*
 * "Make a copy" on a public artifact page: the visitor's own copy of the
 * version on the page, in a new chat of theirs with the canvas open on it, so
 * it can be changed straight away (POST /api/share/copy, src/lib/share-copy.ts).
 *
 * Signed out, it is a link to sign in that comes back here with `?copy=1`;
 * back on the page signed in, a dialog asks once more before anything is
 * made — arriving from a link never creates something on its own.
 */

export const SHARE_REMIX_COPY = {
  label: "Make a copy",
  making: "Making a copy…",
  signInLabel: "Sign in to make your own copy",
  title: "Make your own copy?",
  body: "This version goes into a new chat of yours, where you can change it. The original stays as it is.",
  cancel: "Not now",
  failed: "Couldn’t make a copy. Try again.",
} as const;

export function ShareCopyButton({
  token,
  signedIn,
  askOnArrival,
}: {
  token: string;
  signedIn: boolean;
  /** Back from sign-in with `?copy=1`: ask, then copy. */
  askOnArrival?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [asking, setAsking] = React.useState(!!askOnArrival && signedIn);
  const signInLabel = usePhrase(SHARE_REMIX_COPY.signInLabel);

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    const result = await requestJson("/api/share/copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!result.ok || typeof result.data.url !== "string") {
      setBusy(false);
      toast.error(result.ok ? formatPhrase(SHARE_REMIX_COPY.failed) : result.error);
      return;
    }
    setAsking(false);
    router.push(result.data.url);
  };

  if (!signedIn) {
    const back = `/share/${encodeURIComponent(token)}?copy=1`;
    return (
      <Button size="sm" variant="outline" asChild>
        <Link href={`/sign-in?callbackUrl=${encodeURIComponent(back)}`} aria-label={signInLabel} title={signInLabel}>
          <FilePlus className="size-3.5" aria-hidden />
          <Phrase text={SHARE_REMIX_COPY.label} />
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void copy()} loading={busy && !asking} data-share-copy="">
        <FilePlus className="size-3.5" aria-hidden />
        <Phrase text={busy ? SHARE_REMIX_COPY.making : SHARE_REMIX_COPY.label} />
      </Button>
      <Dialog open={asking} onOpenChange={(open) => !busy && setAsking(open)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Phrase text={SHARE_REMIX_COPY.title} />
            </DialogTitle>
            <DialogDescription>
              <Phrase text={SHARE_REMIX_COPY.body} />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              <Phrase text={SHARE_REMIX_COPY.cancel} />
            </Button>
            <Button onClick={() => void copy()} loading={busy}>
              <Phrase text={SHARE_REMIX_COPY.label} />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
