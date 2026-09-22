"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import { highlightHtml } from "@/components/canvas/code-surface";
import { fileExtension, splitDelimitedLine, textFlavorOf } from "@/lib/documents/viewer-kind";
import { cn } from "@/lib/utils";
import { fetchBytes } from "./pdf-engine";
import { ViewerLoading, ViewerMessage } from "./viewer-ui";

/** Characters shown. Past this a file is data to be queried, not a page to read. */
const MAX_CHARS = 1_500_000;
const MAX_TABLE_ROWS = 2_000;
const MAX_TABLE_COLUMNS = 60;

type Loaded = { text: string; truncated: boolean };

/**
 * A text file as itself: Markdown rendered, CSV as a table, source with line
 * numbers and highlighting, anything else as the characters it contains.
 *
 * Every mode leaves the DOM as real text, so selecting to ask, the find bar
 * and copy all work on it the same way they do on a PDF page.
 */
export function TextView({ url, fileName }: { url: string; fileName: string }) {
  const [state, setState] = React.useState<{ status: "loading" } | { status: "ready"; loaded: Loaded } | { status: "error" }>({
    status: "loading",
  });

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchBytes(url, { signal: controller.signal })
      .then((bytes) => {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const truncated = decoded.length > MAX_CHARS;
        setState({ status: "ready", loaded: { text: truncated ? decoded.slice(0, MAX_CHARS) : decoded, truncated } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [url]);

  if (state.status === "loading") return <ViewerLoading label="Opening the file…" />;
  if (state.status === "error") {
    return <ViewerMessage tone="warning" title="This file couldn’t be opened." body="It may have been deleted. Download it to check." />;
  }

  const { text, truncated } = state.loaded;
  const flavor = textFlavorOf(fileName);

  return (
    <div
      tabIndex={0}
      role="document"
      aria-label={fileName}
      data-document-scroller
      className="min-h-0 flex-1 overflow-auto overscroll-contain bg-secondary outline-none"
    >
      {truncated && (
        <p className="mx-auto max-w-3xl px-6 pt-4 font-mono text-caption text-muted-foreground" data-find-skip>
          Showing the first {MAX_CHARS.toLocaleString()} characters. Download the file for the rest.
        </p>
      )}
      {flavor === "markdown" ? (
        <article className="mx-auto my-5 max-w-3xl rounded-card border border-border/60 bg-card px-8 py-7 shadow-raised">
          <Markdown content={text} className="text-body" />
        </article>
      ) : flavor === "csv" || flavor === "tsv" ? (
        <DelimitedTable text={text} delimiter={flavor === "csv" ? "," : "\t"} />
      ) : (
        <SourceText text={text} language={flavor === "code" ? fileExtension(fileName) : null} />
      )}
    </div>
  );
}

function DelimitedTable({ text, delimiter }: { text: string; delimiter: "," | "\t" }) {
  const { header, rows, more } = React.useMemo(() => {
    const lines = text.split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const parsed = lines.slice(0, MAX_TABLE_ROWS + 1).map((line) => splitDelimitedLine(line, delimiter).slice(0, MAX_TABLE_COLUMNS));
    return { header: parsed[0] ?? [], rows: parsed.slice(1), more: Math.max(0, lines.length - 1 - MAX_TABLE_ROWS) };
  }, [text, delimiter]);

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-card border border-border/70 bg-card">
        <table className="w-full border-collapse text-left text-ui">
          <thead className="sticky top-0 bg-secondary">
            <tr data-line={1}>
              <th className="w-10 border-b border-border/70 px-2 py-1.5 text-right font-mono text-micro font-normal text-muted-foreground" data-find-skip>
                #
              </th>
              {header.map((cell, i) => (
                <th key={i} className="whitespace-nowrap border-b border-l border-border/70 px-3 py-1.5 font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} data-line={r + 2} className="even:bg-secondary/40">
                <td className="border-b border-border/50 px-2 py-1 text-right font-mono text-micro text-muted-foreground" data-find-skip>
                  {r + 1}
                </td>
                {header.map((_, c) => (
                  <td key={c} className="max-w-[28rem] border-b border-l border-border/50 px-3 py-1 align-top">
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && (
        <p className="px-1 pt-3 font-mono text-caption text-muted-foreground" data-find-skip>
          {more.toLocaleString()} more rows — download the file to see them all.
        </p>
      )}
    </div>
  );
}

function SourceText({ text, language }: { text: string; language: string | null }) {
  /*
   * The `{ __html }` object is memoised, not just the string. React 19 compares
   * that prop by identity and re-assigns `innerHTML` whenever it changes — so a
   * fresh object on every render (the selection toolbar appearing is a render)
   * replaced every text node under the reader's selection and collapsed it.
   */
  const html = React.useMemo(() => {
    const highlighted = language ? highlightHtml(text, language) : null;
    return highlighted ? { __html: highlighted } : null;
  }, [text, language]);
  // One text node for the whole gutter, not a <div> per line: a 40,000-line
  // log would otherwise be 40,000 elements before a single character of it.
  const gutter = React.useMemo(() => {
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return Array.from({ length: n }, (_, i) => i + 1).join("\n");
  }, [text]);
  const numbered = language !== null;

  return (
    <div className={cn("flex min-w-fit bg-card font-mono text-ui leading-6", !numbered && "mx-auto my-5 max-w-3xl rounded-card border border-border/60 shadow-raised")}>
      {numbered && (
        <pre
          aria-hidden
          data-find-skip
          className="sticky left-0 select-none border-r border-border/60 bg-secondary px-3 py-4 text-right text-muted-foreground/70"
        >
          {gutter}
        </pre>
      )}
      {html ? (
        <pre
          data-line-source
          className="hljs min-w-0 flex-1 whitespace-pre px-4 py-4"
          dangerouslySetInnerHTML={html}
        />
      ) : (
        <pre data-line-source className={cn("min-w-0 flex-1 px-4 py-4", numbered ? "whitespace-pre" : "whitespace-pre-wrap break-words px-7 py-6 font-sans text-body leading-relaxed")}>
          {text}
        </pre>
      )}
    </div>
  );
}
