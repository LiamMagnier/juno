"use client";

import * as React from "react";
import { parseInline, type Block, type DocumentModel, type Revision } from "@/lib/work/deliverables/semantic/document/model";
import { isAllowedImageSource, EMBEDDABLE_IMAGE } from "@/lib/work/deliverables/semantic/shared";
import type { SemanticOpsHandler } from "@/components/semantic/semantic-artifact-view";

/**
 * The document as a page: Newsreader at a reading measure, real headings,
 * lists, tables and callouts, citations as superscripts with the references
 * under the text. Comments and suggested revisions sit in the margin as mono
 * annotations; a suggestion shows inline as an insertion beside the struck
 * text it would replace, with Accept and Reject that send one operation each.
 */

function Inline({ text, citeNumbers }: { text: string; citeNumbers: Map<string, number> }) {
  const runs = React.useMemo(() => {
    try {
      return parseInline(text);
    } catch {
      return [{ text }];
    }
  }, [text]);
  return (
    <>
      {runs.map((run, i) => {
        if (run.cite) {
          const n = citeNumbers.get(run.cite);
          return (
            <sup key={i} className="sx-cite" aria-label={`Source ${n ?? run.cite}`}>
              {n ?? "?"}
            </sup>
          );
        }
        // "flat [@s1]." reads "flat¹." — the space belongs to the prose, not the mark.
        let node: React.ReactNode = runs[i + 1]?.cite ? run.text.replace(/\s+$/, "") : run.text;
        if (run.code) node = <code>{node}</code>;
        if (run.bold) node = <strong>{node}</strong>;
        if (run.italic) node = <em>{node}</em>;
        if (run.link) {
          node = (
            <a href={run.link} target="_blank" rel="noreferrer noopener">
              {node}
            </a>
          );
        }
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

function blockText(block: Block): string | null {
  return block.type === "heading" || block.type === "paragraph" || block.type === "callout" ? block.text : null;
}

function BlockBody({ block, citeNumbers, replacing }: { block: Block; citeNumbers: Map<string, number>; replacing?: Revision }) {
  const text = blockText(block);
  const inline =
    text !== null ? (
      replacing ? (
        <>
          <span className="sx-del">
            <Inline text={text} citeNumbers={citeNumbers} />
          </span>{" "}
          <span className="sx-ins">
            <Inline text={replacing.text ?? ""} citeNumbers={citeNumbers} />
          </span>
        </>
      ) : (
        <Inline text={text} citeNumbers={citeNumbers} />
      )
    ) : null;
  switch (block.type) {
    case "heading": {
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4");
      return <Tag>{inline}</Tag>;
    }
    case "paragraph":
      return <p data-style={block.style ?? "normal"}>{inline}</p>;
    case "callout":
      return (
        <div className="sx-callout" data-tone={block.tone}>
          <div className="sx-annot" data-tone={block.tone === "warning" ? "attention" : undefined}>
            {block.tone}
            {block.title ? ` · ${block.title}` : ""}
          </div>
          <p className="!mb-0">{inline}</p>
        </div>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className={block.ordered ? "list-decimal" : "list-disc"}>
          {block.items.map((item, i) => (
            <li key={i} data-level={item.level}>
              <Inline text={item.text} citeNumbers={citeNumbers} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <figure className="m-0 overflow-x-auto">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} scope="col">
                    <Inline text={cell} citeNumbers={citeNumbers} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Inline text={cell} citeNumbers={citeNumbers} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption && <figcaption className="sx-annot mt-1">{block.caption}</figcaption>}
        </figure>
      );
    case "figure":
      return (
        <figure className="sx-figure" style={{ width: block.widthPct ? `${block.widthPct}%` : undefined }}>
          {EMBEDDABLE_IMAGE.test(block.src) || isAllowedImageSource(block.src) ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URI or an https image the model saw; no optimiser applies
            <img src={block.src} alt={block.alt} referrerPolicy="no-referrer" loading="lazy" />
          ) : (
            <div className="sx-placeholder sx-annot">{block.alt}</div>
          )}
          {block.caption && <figcaption className="sx-annot mt-2">{block.caption}</figcaption>}
        </figure>
      );
    case "pageBreak":
      return (
        <div className="sx-break sx-annot" role="separator">
          page break
        </div>
      );
  }
}

export function DocumentView({
  model,
  readOnly,
  onApplyOps,
}: {
  model: DocumentModel;
  readOnly: boolean;
  onApplyOps?: SemanticOpsHandler;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const citeNumbers = React.useMemo(() => new Map(model.sources.map((source, i) => [source.id, i + 1])), [model.sources]);

  // Blocks whose content changed since the last model ink in once.
  const previous = React.useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const now = new Map(model.blocks.map((block) => [block.id, JSON.stringify(block)]));
    const before = previous.current;
    previous.current = now;
    if (!before) return;
    setChanged(new Set([...now].filter(([id, json]) => before.get(id) !== json).map(([id]) => id)));
  }, [model.blocks]);

  const pending = model.revisions.filter((r) => r.status === "pending");
  const openComments = model.comments.filter((c) => !c.resolved);

  const run = async (ops: Record<string, unknown>[]) => {
    if (!onApplyOps) return;
    setBusy(true);
    setError(null);
    const result = await onApplyOps(ops);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  const canAct = !readOnly && !!onApplyOps && !busy;

  return (
    <div className="sx" data-kind="document">
      <div className="sx-bar">
        <span className="sx-annot truncate">
          {model.blocks.length} blocks
          {openComments.length ? ` · ${openComments.length} comment${openComments.length === 1 ? "" : "s"}` : ""}
          {pending.length ? ` · ${pending.length} suggestion${pending.length === 1 ? "" : "s"}` : ""}
          {model.metadata.author ? ` · ${model.metadata.author}` : ""}
        </span>
        <span className="sx-annot ml-auto" aria-live="polite" data-tone={error ? "attention" : undefined}>
          {error ?? (busy ? "Saving…" : "")}
        </span>
      </div>
      <div className="sx-page-wrap">
        <article className="sx-page">
          {model.blocks.map((block) => {
            const replacing = pending.find((r) => r.blockId === block.id && r.kind === "replace");
            const deleting = pending.find((r) => r.blockId === block.id && r.kind === "delete");
            const inserts = pending.filter((r) => r.blockId === block.id && r.kind === "insert");
            const comments = openComments.filter((c) => c.blockId === block.id);
            const notes = [...(replacing ? [replacing] : []), ...(deleting ? [deleting] : []), ...inserts];
            return (
              <section key={block.id} className="sx-block" id={`block-${block.id}`} data-changed={changed.has(block.id) || undefined}>
                <div className={deleting ? "sx-del" : undefined}>
                  <BlockBody block={block} citeNumbers={citeNumbers} replacing={replacing} />
                </div>
                {inserts.map((r) => (
                  <p key={r.id} className="sx-ins">
                    <Inline text={r.text ?? ""} citeNumbers={citeNumbers} />
                  </p>
                ))}
                {(notes.length > 0 || comments.length > 0) && (
                  <aside className="sx-margin" aria-label="Notes on this block">
                    {notes.map((r) => (
                      <div key={r.id} className="sx-note sx-annot" data-tone="presence">
                        <span>
                          {r.author} suggested {r.kind === "replace" ? "new wording" : r.kind === "insert" ? "an insertion" : "deleting this"}
                        </span>
                        {canAct && (
                          <>
                            <button type="button" className="sx-action sx-annot" onClick={() => void run([{ op: "acceptRevision", id: r.id }])}>
                              Accept
                            </button>
                            <button type="button" className="sx-action sx-annot" onClick={() => void run([{ op: "rejectRevision", id: r.id }])}>
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    {comments.map((c) => (
                      <div key={c.id} className="sx-note sx-annot">
                        <span>
                          {c.author}: {c.text}
                        </span>
                        {canAct && (
                          <button type="button" className="sx-action sx-annot" onClick={() => void run([{ op: "resolveComment", id: c.id }])}>
                            Resolve
                          </button>
                        )}
                      </div>
                    ))}
                  </aside>
                )}
              </section>
            );
          })}
          {model.sources.length > 0 && (
            <section className="sx-refs" aria-label="References">
              <div className="sx-annot mb-2">References</div>
              <ol className="list-decimal">
                {model.sources.map((source) => (
                  <li key={source.id}>
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noreferrer noopener">
                        {source.title}
                      </a>
                    ) : (
                      source.title
                    )}
                    {source.publisher ? <span className="sx-annot"> · {source.publisher}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
