"use client";

import * as React from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import { NotificationRow } from "@/components/notifications/notification-row";
import type { NotificationsInbox } from "@/components/notifications/use-notifications";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { AppIcons } from "@/lib/app-icons";
import { enableWebPush, webPushStatus } from "@/lib/notify/web-push-client";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The notifications popover, opened from the sidebar's Notifications row.
 *
 * A popover and not a page (docs/design/TWO_PRODUCTS.md: no new
 * destinations). Every row goes somewhere that already exists: the chat a task
 * ran in, the agent that has ideas. The inbox is the list of those doors, not
 * a room of its own, which is why nothing here is answered in place: an
 * approval is decided on its card in the conversation, where the transcript it
 * is about is on screen.
 *
 * It opens to the right of the column like the More flyout. Below `md` the
 * column is the phone drawer, 280px wide with nothing to its right, so there it
 * drops under the row instead and takes the width of the screen.
 *
 * `children` is the trigger: the row, wrapped in `PopoverTrigger` by its owner.
 */
export function NotificationsPopover({
  inbox,
  open,
  onOpenChange,
  onNavigate,
  children,
}: {
  inbox: NotificationsInbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A row took the reader somewhere: close whatever holds the trigger (the phone drawer). */
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  const { features } = useApp();
  const headingId = React.useId();
  const { count, items, listState, hasEarlier, loadingEarlier, load, loadEarlier, markRead, markAllRead } = inbox;

  // Every open reads the first page again, so the list is never older than
  // the moment it was opened. Rows already on screen stay while it does.
  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  /*
   * THE ONE PLACE JUNO ASKS TO NOTIFY THIS BROWSER, and only as a quiet line
   * a person chooses to press. It shows while the browser has never been
   * asked (`default`); once someone has answered either way the answer is
   * theirs, and changing it lives in Settings. Nothing prompts on its own.
   */
  const publicKey = features.webPush ? (features.webPushPublicKey ?? null) : null;
  const [offerPush, setOfferPush] = React.useState(false);
  React.useEffect(() => {
    if (!open || !publicKey) return;
    // Answered already, either way: nothing to offer, and no need to ask the
    // server about a subscription on every open.
    if (typeof Notification === "undefined" || Notification.permission !== "default") {
      setOfferPush(false);
      return;
    }
    let cancelled = false;
    void webPushStatus(publicKey).then(({ state }) => {
      if (!cancelled) setOfferPush(state === "off");
    });
    return () => {
      cancelled = true;
    };
  }, [open, publicKey]);

  const turnOnPush = () => {
    if (!publicKey) return;
    setOfferPush(false);
    // Straight from the click, with nothing awaited first: the browser only
    // shows its permission prompt while the gesture that asked is live.
    void enableWebPush(publicKey).then((result) => {
      if (result.ok) {
        toast.success(`${PRODUCT_NAME} will notify you on this browser.`);
      } else if (result.reason === "denied") {
        toast(`Notifications are off for ${PRODUCT_NAME} in this browser.`, {
          description: "You can allow them in the browser’s site settings.",
        });
      } else if (result.reason === "failed") {
        toast.error("Couldn’t turn on notifications.", { description: "Try again from Settings, under Account." });
      }
    });
  };

  const openRow = (id: string, navigating: boolean) => {
    markRead(id);
    if (!navigating) return;
    onOpenChange(false);
    onNavigate();
  };

  // A layout choice about a floating layer and the window it floats in, read
  // when it opens. The shell makes the same call at the same width.
  const underRow = open && typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const unread = count?.unreadCount ?? items?.filter((n) => !n.readAt).length ?? 0;

  return (
    // Not modal, like the More flyout: the column around it stays live.
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      {children}
      <PopoverContent
        side={underRow ? "bottom" : "right"}
        align="start"
        sideOffset={underRow ? 4 : 12}
        collisionPadding={underRow ? 8 : 16}
        aria-labelledby={headingId}
        // Focus lands on the popover itself, which names it, rather than on
        // its first control: that is "Mark all as read", and a second Enter
        // from the keyboard that opened it should not clear the inbox.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        // `p-0` moves the padding onto the parts, so the list scrolls to the
        // card's own edge. The height is the room the window has, capped.
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 flex-col p-0"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 pl-4 pr-2">
          <h2 id={headingId} className="text-body font-medium text-foreground">
            Notifications
          </h2>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={markAllRead}>
              Mark all as read
            </Button>
          ) : null}
        </div>

        {items === null ? (
          listState === "failed" ? (
            <div className="p-1.5 pt-0">
              <EmptyState
                size="panel"
                tone="error"
                icon={AppIcons.notifications}
                title="Couldn’t load notifications"
                description="Check your connection and try again."
                action={
                  <Button variant="outline" size="sm" onClick={load}>
                    Try again
                  </Button>
                }
                className="rounded-control"
              />
            </div>
          ) : (
            <LoadingRows />
          )
        ) : items.length === 0 ? (
          <div className="p-1.5 pt-0">
            <EmptyState
              size="panel"
              icon={AppIcons.notifications}
              title="Nothing new"
              description={`${PRODUCT_NAME} tells you here when a task finishes, needs you, or an agent has something to share.`}
              className="rounded-control"
            />
          </div>
        ) : (
          <ScrollFade className="min-h-0 flex-1" viewportClassName="overscroll-contain px-1.5 pb-1.5">
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationRow notification={n} onOpen={(navigating) => openRow(n.id, navigating)} />
                </li>
              ))}
            </ul>
            {hasEarlier ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full text-muted-foreground"
                loading={loadingEarlier}
                onClick={loadEarlier}
              >
                Show earlier
              </Button>
            ) : null}
          </ScrollFade>
        )}

        {offerPush ? (
          <div className="shrink-0 border-t border-border/60 p-1.5">
            <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={turnOnPush}>
              Get notified on this browser
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Loading lines of uneven length on the rows' own pitch, so nothing moves when the rows arrive. */
const SKELETON_WIDTHS = ["64%", "78%", "52%"];

function LoadingRows() {
  return (
    <div className="px-1.5 pb-1.5">
      <p role="status" className="sr-only">
        Loading notifications
      </p>
      <div aria-hidden="true">
        {SKELETON_WIDTHS.map((width) => (
          <div key={width} className="flex items-start gap-2.5 px-2.5 py-2">
            <span className="skeleton size-5 shrink-0 rounded-full" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <span className="skeleton h-3 rounded-full" style={{ width }} />
              <span className="skeleton h-2.5 w-11/12 rounded-full" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
