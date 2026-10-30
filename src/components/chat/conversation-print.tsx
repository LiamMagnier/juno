"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@/components/chat/markdown";
import { CONVERSATION_EXPORT_COPY, type ExportTurn } from "@/components/chat/conversation-export";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { setTitleOverride } from "@/lib/title-override";
import "@/components/chat/conversation-print.css";

const PRINT_TITLE_KEY = "chat-print";

/**
 * Print / Save as PDF: the conversation as a clean document (spec §6.15).
 *
 * Mounted only while printing. It portals the turns (conversation-export.ts:
 * what the transcript shows, nothing it hides) to <body> as the page's
 * `[data-print-document]`, so globals.css hides the app around it, and opens
 * the browser's print dialog two frames later, once it is laid out and the
 * tab title (the PDF's default file name) is the chat's. Answers render
 * through the transcript's own Markdown, so tables, code and maths print as
 * they read. `afterprint` hands control back; the copy never shows on screen.
 */
export function ConversationPrint({
  title,
  turns,
  exportedAt,
  onDone,
}: {
  title: string;
  turns: readonly ExportTurn[];
  exportedAt: Date;
  onDone: () => void;
}) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const doneRef = React.useRef(onDone);
  React.useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  React.useEffect(() => {
    setHost(document.body);
  }, []);

  React.useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let second = 0;
    const finish = () => {
      window.removeEventListener("afterprint", finish);
      setTitleOverride(PRINT_TITLE_KEY, null);
      if (!cancelled) doneRef.current();
    };
    const first = requestAnimationFrame(() => {
      setTitleOverride(PRINT_TITLE_KEY, title);
      second = requestAnimationFrame(() => {
        if (cancelled) return;
        window.addEventListener("afterprint", finish);
        window.print();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      window.removeEventListener("afterprint", finish);
      setTitleOverride(PRINT_TITLE_KEY, null);
    };
  }, [host, title]);

  if (!host) return null;
  const day = Number.isFinite(exportedAt.getTime()) ? exportedAt.toISOString().slice(0, 10) : "";
  return createPortal(
    <div className="chat-print-root" aria-hidden="true">
      <article data-print-document="" className="chat-print">
        <header className="chat-print-head">
          <h1 className="chat-print-title">{title || CONVERSATION_EXPORT_COPY.untitled}</h1>
          <p className="chat-print-meta">{day ? `${PRODUCT_NAME} · ${day}` : PRODUCT_NAME}</p>
        </header>
        {turns.map((turn) => (
          <section key={turn.id} className="chat-print-turn">
            <p className="chat-print-label">{turn.label}</p>
            {turn.quote ? <blockquote className="chat-print-quote">{turn.quote}</blockquote> : null}
            {turn.body ? (
              turn.speaker === "you" ? (
                <p className="chat-print-user">{turn.body}</p>
              ) : (
                <Markdown content={turn.body} />
              )
            ) : null}
            {turn.files.length ? (
              <p className="chat-print-small">
                {CONVERSATION_EXPORT_COPY.filesLabel}: {turn.files.join(", ")}
              </p>
            ) : null}
            {turn.sources.length ? (
              <>
                <p className="chat-print-small">{CONVERSATION_EXPORT_COPY.sourcesLabel}</p>
                <ol className="chat-print-sources">
                  {turn.sources.map((source, index) => (
                    <li key={`${index}-${source.url}`}>
                      <a href={source.url}>{source.title}</a>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {turn.note ? <p className="chat-print-small">{turn.note}</p> : null}
          </section>
        ))}
      </article>
    </div>,
    host
  );
}
