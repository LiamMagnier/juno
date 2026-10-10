"use client";

import * as React from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Check, MessagesSquare } from "@/components/ui/icons";

/**
 * A Chat's own "Let conversations message each other" toggle, in its sidebar
 * menu (src/lib/cross-conversation). It reads the effective state when the
 * menu opens: the conversation's own choice, else the account setting.
 */
export function CrossMessagesMenuItem({ conversationId }: { conversationId: string }) {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void fetch(`/api/conversations/${encodeURIComponent(conversationId)}/cross-messages`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { enabled?: boolean } | null) => {
        if (!cancelled && body) setEnabled(!!body.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  return (
    <DropdownMenuItem
      disabled={enabled === null}
      onSelect={() => {
        if (enabled === null) return;
        void fetch(`/api/conversations/${encodeURIComponent(conversationId)}/cross-messages`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !enabled }),
        });
      }}
    >
      <MessagesSquare className="size-4" />
      <span className="flex-1">Messages from other conversations</span>
      {enabled ? <Check className="size-4" aria-label="On" /> : null}
    </DropdownMenuItem>
  );
}
