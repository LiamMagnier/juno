"use client";

import dynamic from "next/dynamic";

/**
 * The legacy Code session surface, split from /chat/[id]'s first load.
 *
 * The route used to call `next/dynamic` from its Server Component. That does
 * not split a Client Component in the App Router: the module stays in the
 * page's client manifest and its chunks (the session view, run review, run
 * cards, the session hook and the agent protocol) were fetched before
 * DOMContentLoaded on every conversation, measured in
 * docs/rework/program/perf/loaded-history-before-early.txt. Here, in a Client
 * Component, it is a real lazy boundary: still rendered on the server, and its
 * chunks fetched only by the page that renders it.
 */
export const CodeSessionViewLazy = dynamic(() =>
  import("@/components/code/code-session-view").then((m) => m.CodeSessionView),
);
