import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load".
 *
 * There were 61 centred blocks doing this across the product, in 33 distinct
 * shapes. Padding ran from `py-4` to `py-16`; some had a dashed border, some a
 * solid one, some a top-and-bottom rule, most none; the radius was xl, lg, card
 * or absent; the title was `font-serif text-heading` on one page and
 * `text-sm font-medium` on the next. No two pages told the user "nothing here"
 * the same way, and an empty state is disproportionately likely to be the FIRST
 * thing a new account sees — every list is empty on day one.
 *
 * Two tones, because these are two different messages and had been sharing one
 * treatment:
 *
 *   "empty"  Nothing is wrong. The feature works and you have not used it yet.
 *            A dashed border, because a dashed edge reads as a placeholder —
 *            a space waiting to be filled rather than a thing that is finished.
 *
 *   "error"  Something failed. Solid border in the destructive tint, because a
 *            failure is not a placeholder and must not look like one. This is
 *            the distinction the product was losing most often: library drew
 *            its "couldn't load" in exactly the same grey rules as its "no
 *            files yet", so a broken fetch and an untouched account were
 *            visually identical.
 *
 * `size` is about how much room the state is allowed to take, not how important
 * it is: `panel` for a state inside a card or a sidebar section, `page` for one
 * that owns the whole content column.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "empty",
  size = "page",
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  /** One or two sentences. Say what would put something here, not just that it is empty. */
  description?: React.ReactNode;
  /** The thing that resolves it — create the first one, or retry. */
  action?: React.ReactNode;
  tone?: "empty" | "error";
  size?: "panel" | "page";
  className?: string;
}) {
  const isError = tone === "error";
  return (
    <div
      // The border is on the container rather than the page, so a state can be
      // dropped anywhere without the caller re-deciding how it is fenced.
      //
      // The DASH is the whole tonal signal and it has to be conditional. This
      // shipped with `border-dashed` unconditional and only the colour swapped,
      // which meant the two tones differed by a tint alone — so the component
      // that exists to make "nothing here yet" and "that failed" distinguishable
      // did not distinguish them, while its own doc comment two dozen lines up
      // claimed error was solid "because a failure is not a placeholder and must
      // not look like one". The comment was right; the class list was not.
      className={cn(
        "flex flex-col items-center justify-center rounded-card border text-center",
        isError
          ? "border-solid border-destructive/45 bg-destructive/[0.04]"
          : "border-dashed border-border/70",
        size === "page" ? "min-h-64 px-6 py-14" : "px-4 py-8",
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {Icon && (
        <Icon
          className={cn(
            "shrink-0",
            size === "page" ? "size-6" : "size-5",
            isError ? "text-destructive/70" : "text-muted-foreground/70"
          )}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      )}
      <p
        className={cn(
          "font-serif font-medium",
          size === "page" ? "text-heading" : "text-body-lg",
          Icon && "mt-3",
          isError && "text-destructive"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
