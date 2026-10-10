"use client";

import { CrossMessageRow, type CrossMessageRowData } from "@/components/chat/cross-message-row";

const RECEIVED: CrossMessageRowData = {
  id: "r1",
  direction: "received",
  peerTitle: "Fix the cart total",
  peerHref: null,
  text: "The cart total fix is merged in 4f2a. Rounding now happens once, at checkout.",
};

const SENT: CrossMessageRowData = {
  id: "s1",
  direction: "sent",
  peerTitle: "Release notes",
  peerHref: "/chat/c_notes",
  text: "Add the cart total fix (4f2a) under Fixes.",
  status: "queued",
};

const NOTICE: CrossMessageRowData = { id: "n1", direction: "notice", peerTitle: "Release notes", peerHref: "/chat/c_notes", text: "" };

export function CrossConversationGallery() {
  return (
    <main className="min-h-dvh bg-background px-4 py-12 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-6" data-testid="cross-gallery">
        <div className="flex justify-end">
          <p className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-body">Ask the cart session whether the fix is merged.</p>
        </div>
        <section data-testid="received">
          <CrossMessageRow row={RECEIVED} />
          <p className="text-body leading-relaxed">
            It is merged in 4f2a: the total now rounds once, at checkout. I will add it to the release notes.
          </p>
        </section>
        <section data-testid="sent">
          <CrossMessageRow row={SENT} />
        </section>
        <section data-testid="notice">
          <CrossMessageRow row={NOTICE} />
        </section>
      </div>
    </main>
  );
}
