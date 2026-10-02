"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import "@/components/app/editorial.css";

/*
 * The editorial page kit, cut from Memory: a hero (serif title, lede, a few
 * figures, an optional visual on the right) and sections set on a 13rem margin
 * column that names the block and holds its controls, beside the reading
 * column. Pages built on it read as one document instead of stacked boxes.
 */

export interface HeroFigure {
  label: string;
  value: React.ReactNode;
  /** Words rather than a number: set a step smaller so it fits the column. */
  small?: boolean;
}

export function PageHero({
  heading,
  lede,
  actions,
  figures,
  aside,
  children,
  className,
}: {
  heading: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  figures?: HeroFigure[];
  /** A visual for the right half on a wide page (Memory's constellation). */
  aside?: React.ReactNode;
  /** Under the figures: scope chips, filters. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("ed @container/hero relative", className)}>
      <div className={cn("grid items-center gap-x-10 gap-y-8", aside && "@[56rem]/hero:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]")}>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-4">
            <h1 className="ed-display ed-rise text-foreground" style={{ ["--i" as string]: 0 }}>
              {heading}
            </h1>
            {actions && (
              <div className={cn("ed-rise flex shrink-0 items-center gap-2 pt-2", aside && "@[56rem]/hero:hidden")} style={{ ["--i" as string]: 1 }}>
                {actions}
              </div>
            )}
          </div>
          {lede && (
            <p className="ed-rise mt-4 max-w-[32rem] text-pretty text-body-lg text-muted-foreground" style={{ ["--i" as string]: 1 }}>
              {lede}
            </p>
          )}
          {figures && figures.length > 0 && (
            <dl className="ed-rise mt-9 grid max-w-[32rem] grid-cols-3" style={{ ["--i" as string]: 2 }}>
              {figures.map((figure) => (
                <div
                  key={figure.label}
                  className="flex min-w-0 flex-col-reverse gap-2 border-l border-[var(--ed-line)] pl-4 first:border-l-0 first:pl-0"
                >
                  <dt className="ed-annot">{figure.label}</dt>
                  <dd className={cn("ed-figure truncate text-foreground", figure.small && "ed-figure-sm")}>{figure.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {children && (
            <div className="ed-rise mt-8" style={{ ["--i" as string]: 3 }}>
              {children}
            </div>
          )}
        </div>
        {aside && (
          <div className="relative hidden min-w-0 @[56rem]/hero:block">
            {actions && <div className="absolute right-0 top-0 z-[1] flex items-center gap-2">{actions}</div>}
            <div className="ed-rise pt-10" style={{ ["--i" as string]: 2 }}>
              {aside}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A block of the page: its name and controls in the margin, its body beside. */
export function EditorialSection({
  title,
  meta,
  controls,
  children,
  sticky = false,
  className,
  id,
}: {
  title: React.ReactNode;
  /** A mono line under the title: a count, when it last changed. */
  meta?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
  /** Keep the margin column in view while a long body scrolls past. */
  sticky?: boolean;
  className?: string;
  id?: string;
}) {
  const headingId = React.useId();
  return (
    <Reveal as="section" aria-labelledby={headingId} id={id} className={cn("ed @container/ed", className)}>
      <div className="grid gap-x-14 gap-y-5 @[50rem]/ed:grid-cols-[13rem_minmax(0,1fr)]">
        <div className={cn("min-w-0 self-start", sticky && "@[50rem]/ed:sticky @[50rem]/ed:top-6")}>
          <h2 id={headingId} className="ed-h2 text-foreground">
            {title}
          </h2>
          {meta && <div className="ed-annot mt-2">{meta}</div>}
          {controls && <div className="mt-4">{controls}</div>}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </Reveal>
  );
}

/** Rises in the first time it scrolls into view. */
export function Reveal({
  as: Tag = "div",
  className,
  children,
  ...rest
}: { as?: "div" | "section"; className?: string; children: React.ReactNode } & Omit<
  React.HTMLAttributes<HTMLElement>,
  "className" | "children"
>) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.06 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return React.createElement(
    Tag,
    { ...rest, ref, className: cn("ed-reveal", className), "data-on": on || undefined },
    children
  );
}
