import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Primitives for Juno's public engineering writing.
 *
 * These exist so an article file reads as content rather than as markup: the
 * page below supplies the argument, these supply the typography. Everything
 * here is a server component — no hooks, no `use client` — because an essay
 * has nothing to be interactive about, and a 40 KB page that ships zero
 * JavaScript is the point.
 *
 * The one genuinely load-bearing piece is `<Evidence>`. Writing about other
 * companies' systems invites two failure modes: stating an inference as a fact,
 * and hiding behind "it's proprietary" when the vendor has in fact published
 * the answer. The tag makes the distinction structural rather than a matter of
 * the reader's charity — every claim about somebody else's pipeline carries
 * one, and `published` claims carry a link to the sentence they came from.
 */

/* ── Evidence ──────────────────────────────────────────────────────────── */

export type EvidenceKind = "published" | "inferred" | "unknown" | "juno";

/**
 * The four tones, on the ink ramps rather than the fill tokens — these are
 * text on a 10%-alpha chip, and the fill tokens measure well under 4.5:1 on
 * their own chips (tailwind.config.ts, the `text-*` note).
 */
const EVIDENCE: Record<EvidenceKind, { label: string; title: string; className: string }> = {
  published: {
    label: "Published",
    title: "Stated in the vendor’s own documentation. The link goes to it.",
    className: "bg-success/10 text-success",
  },
  inferred: {
    label: "Inferred",
    title: "A reasonable architectural inference from published limits, pricing or observable behaviour. Not confirmed.",
    className: "bg-warning/10 text-warning",
  },
  unknown: {
    label: "Not public",
    title: "Proprietary. Nobody outside the vendor can answer it, and this page does not pretend to.",
    className: "bg-muted text-muted-foreground",
  },
  juno: {
    label: "In Juno",
    title: "A fact about Juno’s own source, not about anyone else’s system.",
    className: "bg-primary/10 text-primary",
  },
};

export function Evidence({ kind, className }: { kind: EvidenceKind; className?: string }) {
  const tone = EVIDENCE[kind];
  return (
    <span
      // `title` rather than a tooltip component: this must work in the reading
      // flow, in print, and with no JavaScript at all. The legend at the top of
      // the article is the real explanation; this is the reminder.
      title={tone.title}
      className={cn(
        "mr-1.5 inline-flex shrink-0 items-center whitespace-nowrap rounded-xs px-1.5 py-0.5 align-middle font-mono text-micro font-medium uppercase",
        tone.className,
        className
      )}
    >
      {tone.label}
    </span>
  );
}

/** The legend. Rendered once, near the top, before any tag is used. */
export function EvidenceKey() {
  return (
    <div className="mt-8 rounded-card border border-border bg-card p-5">
      <p className="font-mono text-label text-muted-foreground">How to read this page</p>
      <p className="mt-2 text-body text-muted-foreground">
        Every claim about a system Juno does not own is tagged. Mixing these up is how an
        architecture note turns into folklore.
      </p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {(Object.keys(EVIDENCE) as EvidenceKind[]).map((kind) => (
          <div key={kind}>
            <dt>
              <Evidence kind={kind} className="mr-0" />
            </dt>
            <dd className="mt-1.5 text-ui leading-relaxed text-muted-foreground">{EVIDENCE[kind].title}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ── Citations ─────────────────────────────────────────────────────────── */

/**
 * An external citation. `noreferrer` with `noopener` implied — these point at
 * vendor documentation, and the article has no reason to announce where its
 * readers came from.
 */
export function Source({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-xs underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:decoration-primary focus-visible:text-primary"
    >
      {children}
    </a>
  );
}

/* ── Structure ─────────────────────────────────────────────────────────── */

/**
 * A numbered section with an anchor. `scroll-mt` keeps the heading clear of the
 * sticky top bar when the table of contents jumps to it — without it the
 * heading lands underneath the bar and the reader thinks the link is broken.
 */
export function Section({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border/60 pt-10 first:border-t-0">
      <p className="font-mono text-label text-muted-foreground">{index}</p>
      <h2 className="mt-2 text-balance font-sans text-title text-foreground">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A sub-head inside a section. */
export function Subhead({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-8 font-sans text-heading text-foreground">{children}</h3>;
}

/** The standfirst under the title — one size up from body, muted. */
export function Lede({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 text-balance text-body-lg leading-relaxed text-muted-foreground">{children}</p>;
}

/* ── Emphasis ──────────────────────────────────────────────────────────── */

/**
 * A pulled-out claim. Used sparingly — three times on the whole page — for the
 * sentences the rest of the argument hangs off.
 */
export function Keystone({ children }: { children: React.ReactNode }) {
  return (
    <p className="my-8 border-l-2 border-primary pl-5 text-balance font-sans text-heading leading-snug text-foreground">
      {children}
    </p>
  );
}

/** A quotation from a cited document, with its attribution line. */
export function Quote({ cite, children }: { cite: React.ReactNode; children: React.ReactNode }) {
  return (
    <figure className="my-6 rounded-card border border-border bg-card p-5">
      <blockquote className="text-body-lg leading-relaxed text-foreground">{children}</blockquote>
      <figcaption className="mt-3 text-ui text-muted-foreground">{cite}</figcaption>
    </figure>
  );
}

/** A boxed aside: a caveat, a security note, a thing worth not losing. */
export function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="my-6 rounded-card border border-border bg-secondary/60 p-5">
      <p className="font-mono text-label text-foreground">{title}</p>
      <div className="mt-2 text-body leading-relaxed text-muted-foreground">{children}</div>
    </aside>
  );
}

/* ── Data ──────────────────────────────────────────────────────────────── */

/**
 * A table that survives a phone.
 *
 * The scroll container is a real wrapper around a real `<table>` — never
 * `display: block` on the table itself, which is the usual shortcut and which
 * silently destroys the row/cell semantics screen readers depend on. The same
 * rule the legal layout follows.
 */
export function DataTable({
  columns,
  rows,
  caption,
  align,
}: {
  columns: React.ReactNode[];
  rows: React.ReactNode[][];
  caption?: React.ReactNode;
  /** Column indices to keep from wrapping — labels, not prose. */
  align?: { nowrap?: number[] };
}) {
  const nowrap = new Set(align?.nowrap ?? [0]);
  return (
    <figure className="my-6">
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full min-w-[34rem] border-collapse text-ui">
          <thead>
            <tr>
              {columns.map((column, i) => (
                <th
                  key={i}
                  scope="col"
                  className="whitespace-nowrap border-b border-border bg-secondary/50 px-3.5 py-2.5 text-left font-mono text-label font-medium text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="align-top">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={cn(
                      "border-b border-border/50 px-3.5 py-2.5 leading-relaxed",
                      c === 0 ? "font-medium text-foreground" : "text-muted-foreground",
                      nowrap.has(c) && "whitespace-nowrap"
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? <figcaption className="mt-2 text-caption text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

/** A code or data listing. No highlighter — it would cost client JS for decoration. */
export function Listing({ label, children }: { label?: string; children: string }) {
  return (
    <figure className="my-6 overflow-hidden rounded-card border border-border bg-card">
      {label ? (
        <p className="border-b border-border bg-secondary/50 px-4 py-2 font-mono text-label text-muted-foreground">
          {label}
        </p>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-ui leading-relaxed text-foreground">
        <code>{children}</code>
      </pre>
    </figure>
  );
}

/* ── The pipeline ──────────────────────────────────────────────────────── */

export interface StageSpec {
  n: number;
  title: string;
  what: React.ReactNode;
  why: React.ReactNode;
  timing: "Synchronous" | "Asynchronous" | "Conditional, async";
  fails: React.ReactNode;
  recovers: React.ReactNode;
}

/** One stage of the nine-stage pipeline, as a card rather than a bullet list. */
export function Stage({ stage }: { stage: StageSpec }) {
  return (
    <li className="rounded-card border border-border bg-card p-5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-label text-muted-foreground">
          {String(stage.n).padStart(2, "0")}
        </span>
        <h3 className="font-sans text-heading text-foreground">{stage.title}</h3>
        <span className="ml-auto shrink-0 rounded-xs bg-secondary px-2 py-0.5 font-mono text-micro uppercase text-muted-foreground">
          {stage.timing}
        </span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-ui leading-relaxed sm:grid-cols-2">
        {[
          ["What", stage.what],
          ["Why", stage.why],
          ["Fails when", stage.fails],
          ["Recovers by", stage.recovers],
        ].map(([term, value]) => (
          <div key={String(term)}>
            <dt className="font-mono text-micro uppercase text-muted-foreground">{term}</dt>
            <dd className="mt-0.5 text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
