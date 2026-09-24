"use client";

import * as React from "react";
import { toast } from "sonner";
import { useVisiblePoll } from "@/components/agents/use-agents";
import { WORK_POLL_MS, WORK_SYNC_EVENT } from "@/components/work/work-transport";
import { onWorkerNotificationsChanged } from "@/lib/notify/web-push-client";
import type { ClientNotification, NotificationsCount } from "@/lib/notify/types";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  announceNotificationsChanged,
  fetchNotifications,
  fetchNotificationsCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/components/notifications/notifications-transport";
import {
  appendPage,
  countAfterRead,
  countFromPage,
  withAllRead,
  withRead,
  withUnread,
} from "@/components/notifications/inbox-model";

/*
 * THE INBOX, as two reads with two rhythms.
 *
 * The dot is a count, polled. One indexed count every thirty seconds while the
 * tab is visible, the rhythm the Needs-you fold already keeps: anything
 * blocking is in that fold and on the agents' faces well before this dot
 * matters, so a faster poll would buy nothing a person could notice. It is
 * re-read at once whenever something says the answer moved: the tab coming
 * back into view, a Work task changing, an agent changing, this inbox marking
 * something read, or the service worker receiving a push.
 *
 * The list is read only when the popover opens, and again on every open. It
 * is never polled: a list nobody is looking at is a request whose answer is
 * thrown away.
 *
 * No toasts and no live announcements from here. A run that stops for a
 * person is already announced by the sidebar's Needs-you poll, and saying it
 * twice teaches people to ignore both.
 */

const PAGE_SIZE = 20;

export type InboxListState = "idle" | "loading" | "ready" | "failed";

export interface NotificationsInbox {
  /** The dot. Null until the first count lands. */
  count: NotificationsCount | null;
  /** The popover's rows. Null until the first page lands. */
  items: ClientNotification[] | null;
  listState: InboxListState;
  /** There is an earlier page to show. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** Reads the first page again; the popover calls it every time it opens. */
  load: () => void;
  loadEarlier: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export function useNotifications(): NotificationsInbox {
  const [count, setCount] = React.useState<NotificationsCount | null>(null);
  // Bumped by every read AND every optimistic write, so a count that left
  // before a row was marked read cannot land after it and bring the dot back.
  const countSeq = React.useRef(0);

  const refreshCount = React.useCallback(() => {
    const mine = ++countSeq.current;
    void fetchNotificationsCount().then((outcome) => {
      if (mine !== countSeq.current) return;
      // The last good count stays on a failed read. A dropped request is not
      // evidence that everything was read, and a dot that blinks out on a
      // flaky connection says "done" as loudly as a real zero.
      if (outcome.kind === "ok") setCount(outcome.value);
    });
  }, []);

  React.useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  // The interval, the return to a visible tab and `juno:agents-changed`.
  useVisiblePoll(refreshCount, WORK_POLL_MS);
  React.useEffect(() => {
    window.addEventListener(WORK_SYNC_EVENT, refreshCount);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refreshCount);
    const stopWorker = onWorkerNotificationsChanged(refreshCount);
    return () => {
      window.removeEventListener(WORK_SYNC_EVENT, refreshCount);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refreshCount);
      stopWorker();
    };
  }, [refreshCount]);

  const [items, setItems] = React.useState<ClientNotification[] | null>(null);
  const [listState, setListState] = React.useState<InboxListState>("idle");
  const [nextBefore, setNextBefore] = React.useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = React.useState(false);
  // A fresh first page supersedes an earlier page still in flight, whose rows
  // would otherwise be appended to a list they no longer follow.
  const listSeq = React.useRef(0);
  const itemsRef = React.useRef(items);
  itemsRef.current = items;

  const load = React.useCallback(() => {
    const mine = ++listSeq.current;
    setListState("loading");
    setLoadingEarlier(false);
    void fetchNotifications({ limit: PAGE_SIZE }).then((outcome) => {
      if (mine !== listSeq.current) return;
      if (outcome.kind !== "ok") {
        setListState("failed");
        return;
      }
      setItems(outcome.value.notifications);
      setNextBefore(outcome.value.nextBefore);
      setListState("ready");
      // The page carries the account's unread total, fresher than the dot's.
      countSeq.current++;
      setCount((previous) => countFromPage(previous, outcome.value));
    });
  }, []);

  const loadEarlier = React.useCallback(() => {
    if (!nextBefore || loadingEarlier) return;
    const mine = listSeq.current;
    setLoadingEarlier(true);
    void fetchNotifications({ before: nextBefore, limit: PAGE_SIZE }).then((outcome) => {
      if (mine !== listSeq.current) return;
      setLoadingEarlier(false);
      if (outcome.kind !== "ok") {
        toast.error("Couldn’t load earlier notifications.", { description: outcome.message });
        return;
      }
      setItems((previous) => appendPage(previous ?? [], outcome.value.notifications));
      setNextBefore(outcome.value.nextBefore);
    });
  }, [loadingEarlier, nextBefore]);

  /*
   * Read at once, confirmed after. A row opened is a row read, and waiting on
   * the round trip would leave the dot lit over the page it just opened. If
   * the write does not stick the row goes back to unread and the dot is asked
   * again; a 404 is not a failure (see `markNotificationRead`).
   */
  const markRead = React.useCallback(
    (id: string) => {
      const row = itemsRef.current?.find((n) => n.id === id);
      if (!row || row.readAt) return;
      setItems((previous) => previous && withRead(previous, id, new Date().toISOString()));
      countSeq.current++;
      setCount(countAfterRead);
      void markNotificationRead(id).then((ok) => {
        if (ok) {
          announceNotificationsChanged();
          return;
        }
        setItems((previous) => previous && withUnread(previous, id));
        refreshCount();
      });
    },
    [refreshCount]
  );

  const markAllRead = React.useCallback(() => {
    const before = itemsRef.current;
    setItems((previous) => previous && withAllRead(previous, new Date().toISOString()));
    countSeq.current++;
    setCount({ unreadCount: 0, urgent: false });
    void markAllNotificationsRead().then((outcome) => {
      if (outcome.kind === "ok") {
        announceNotificationsChanged();
        return;
      }
      setItems(before);
      refreshCount();
      toast.error("Couldn’t mark your notifications as read.", { description: outcome.message });
    });
  }, [refreshCount]);

  return {
    count,
    items,
    listState,
    hasEarlier: nextBefore !== null,
    loadingEarlier,
    load,
    loadEarlier,
    markRead,
    markAllRead,
  };
}
