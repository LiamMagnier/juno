import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AppProvider } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BOOTSTRAP } from "@/app/dev/transcript/gallery";
import type { ChatMessage } from "@/hooks/use-chat";

/*
 * Reading-first follow (G18) in the transcript component: the answer bed is a
 * spacer after the conversation log, never inside it (so it is never content
 * to assistive tech or to Find), and React never owns its height (the window
 * hook writes it before paint; a React-owned height would snap back to zero on
 * every streamed token).
 */

const noop = () => {};

const msg = (partial: Pick<ChatMessage, "id" | "role" | "content"> & Partial<ChatMessage>): ChatMessage =>
  ({ createdAt: "2026-10-18T12:00:00.000Z", attachments: [], ...partial }) as ChatMessage;

// Component modules compiled outside Next use the classic JSX transform, and
// one that never imports React looks for it globally (right-column-shell.test.ts).
const scope = globalThis as { React?: typeof React };
scope.React ??= React;

// The turn actions read the router; a server render has none mounted.
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };

function render() {
  const list = React.createElement(MessageList, {
    messages: [
      msg({ id: "u1", role: "USER", content: "How should we roll out prompt caching?" }),
      msg({ id: "a1", role: "ASSISTANT", content: "Measure first." }),
    ],
    busy: false,
    artifacts: [],
    onOpenArtifact: noop,
    onFeedback: noop,
    conversationTitle: "Bed",
  });
  const providerProps = { bootstrap: BOOTSTRAP } as React.ComponentProps<typeof AppProvider>;
  const app = React.createElement(AppProvider, providerProps, React.createElement(TooltipProvider, null, list));
  return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never }, app));
}

test("the answer bed follows the log inside the scroller, hidden and unsized", () => {
  const html = render();
  const scroller = html.indexOf('aria-label="Conversation messages"');
  const log = html.indexOf('role="log"');
  const bed = html.indexOf("data-answer-bed");
  assert.ok(scroller >= 0 && log > scroller && bed > log, "scroller, then the log, then the bed");
  const tag = html.slice(html.lastIndexOf("<div", bed), html.indexOf(">", bed) + 1);
  assert.match(tag, /aria-hidden="true"/);
  assert.doesNotMatch(tag, /style=/, "React never writes the bed's height");
  // The log closes before the bed opens.
  const logClose = html.indexOf("</div>", html.lastIndexOf('data-message-id="a1"'));
  assert.ok(logClose < bed);
});

test("the window hook drives every follow decision through the shared machine", () => {
  const source = readFileSync(path.join(process.cwd(), "src/hooks/use-transcript-window.ts"), "utf8");
  // `followsRef` is only ever written by `dispatch`.
  const writes = source.match(/followsRef\.current\s*=(?!=)/g) ?? [];
  assert.equal(writes.length, 1, "one write, inside dispatch");
  assert.match(source, /followsRef\.current = followsEnd\(followStateRef\.current\)/);
});
