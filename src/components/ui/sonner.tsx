"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * The surfaces that carry a composer along the bottom edge. A toast has to
 * clear the composer on these and only these — everywhere else the 8rem lift
 * parked it a third of the way up an otherwise empty page, which read as a
 * misplaced object rather than as a notification.
 */
const COMPOSER_ROUTES = ["/chat", "/code", "/work", "/compare", "/design"];

function hasComposer(pathname: string) {
  return (
    pathname === "/" || COMPOSER_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  );
}

/**
 * Toasts are `.surface-float` at `rounded-card` (16): a card that floats, on
 * the same material as every other floating layer. The `group-[.toaster]:`
 * variant is what makes the components-layer class beat sonner's own
 * `[data-sonner-toast][data-styled]` styles — it compiles to a three-class
 * selector, which outranks the two-attribute one.
 *
 * The close chip is the exception and is styled in globals.css instead:
 * sonner's own `[data-close-button]` rules reach (0,4,0) in dark, which this
 * variant cannot beat. The comment there records why.
 */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();
  const pathname = usePathname();
  const composer = hasComposer(pathname);

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-center"
      // Bottom, not top: the transcript's newest content sits at the top of the
      // scroll area, so a top-center toast landed directly on the message that
      // caused it — and on mobile it covered the entire top bar (menu, title,
      // search, new chat).
      //
      // The lift clears the composer, and only where there is a composer to
      // clear. Sonner ignores the x-position below 600px and goes full-bleed,
      // so the mobile offset has to be set explicitly or the toast sits on the
      // input.
      offset={{ bottom: composer ? "8rem" : "1.5rem" }}
      mobileOffset={{
        bottom: composer ? "7rem" : "1.25rem",
        left: "0.75rem",
        right: "0.75rem",
      }}
      closeButton
      toastOptions={{
        classNames: {
          // `text-ui` rather than sonner's stock 13px: the two happen to agree
          // today, but a coincidence is not a token. `pr-9` keeps the label off
          // the close chip now that the chip sits inside the toast's own edge
          // rather than hanging outside the corner.
          toast:
            "group toast group-[.toaster]:rounded-card group-[.toaster]:surface-float group-[.toaster]:font-sans group-[.toaster]:text-ui group-[.toaster]:pr-9",
          // With richColors gone, the semantic tiers are carried by Juno's own
          // AA text ramps instead of sonner's stock green/red fills.
          success: "group-[.toaster]:text-success-ink",
          error: "group-[.toaster]:text-destructive-ink",
          warning: "group-[.toaster]:text-warning-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:rounded-control group-[.toast]:control-primary",
          cancelButton: "group-[.toast]:rounded-control group-[.toast]:control-neu group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
