"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CheckCircle2, Loader2 } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

/**
 * The surfaces that carry a composer along the bottom edge. A toast has to
 * clear the composer on these and only these — everywhere else the 8rem lift
 * parked it a third of the way up an otherwise empty page, which read as a
 * misplaced object rather than as a notification.
 *
 * "/work" was here and is not replaced by anything. The three destinations that
 * came out of it — /skills, /automations, /permissions — are ordinary pages
 * with no composer along the bottom edge, so a toast on one of them belongs
 * where every other page's toast sits.
 */
const COMPOSER_ROUTES = ["/chat", "/code", "/compare", "/design"];

// "/" is deliberately NOT in the list: it is the marketing front door for a
// signed-out visitor (app/page.tsx redirects everyone else straight to /chat),
// and it has no composer to clear.
function hasComposer(pathname: string) {
  return COMPOSER_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * THE STATUS GLYPHS, from the one set. Sonner's stock marks are solid discs
 * drawn at a different weight from every other icon in the product — the one
 * place a Juno surface showed somebody else's drawings, on ~285 toasts.
 *
 * The TIER lives in the glyph, not the sentence. The whole toast used to be
 * set in the tier's ink — a red paragraph for every failure — which made the
 * message harder to read at exactly the moment it mattered and spent colour on
 * type. Now the title keeps the foreground ink and the 16px mark carries the
 * status on the AA ink ramps, which is how Claude and ChatGPT draw theirs.
 *
 * `error`, `warning` and `info` are the registry's marks (`StatusIcons`). The
 * one deliberate exception is success: the registry's bare tick means "chosen"
 * inside menus and pickers, and in a column of toasts beside a circled error
 * and a circled info it read as a smaller, lighter kind of message. The circled
 * check is the set's own mark for "done" (`CheckCircle2`), so the four tiers
 * read as one family at one size.
 *
 * Loading is the set's one spinner. No mark articulates on hover — a status
 * reports, it does not act — so none is inside a hover target anyway, except
 * the dismiss, which turns the way every ✕ in the product does.
 */
const TOAST_ICONS: NonNullable<ToasterProps["icons"]> = {
  success: <CheckCircle2 className="size-4 text-success-ink" />,
  error: <StatusIcons.error className="size-4 text-destructive-ink" />,
  warning: <StatusIcons.warning className="size-4 text-warning-foreground" />,
  info: <StatusIcons.info className="size-4 text-muted-foreground" />,
  loading: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
  close: <ActionIcons.dismiss className="size-3.5" />,
};

/**
 * Toasts are `.surface-float` at `rounded-card` (16): a card that floats, on
 * the same material as every other floating layer. The `group-[.toaster]:`
 * variant is what makes the components-layer class beat sonner's own
 * `[data-sonner-toast][data-styled]` styles — it compiles to a three-class
 * selector, which outranks the two-attribute one.
 *
 * The close chip, the icon slot and the slide timing are the exceptions and
 * are styled in globals.css instead: sonner's own rules for those reach
 * (0,3,0)–(0,4,0), which this variant cannot beat. The notes there record why,
 * including why the arrival is now on --ease-out-expo and the exit on the
 * accelerate.
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
      icons={TOAST_ICONS}
      toastOptions={{
        classNames: {
          // `text-ui` rather than sonner's stock 13px: the two happen to agree
          // today, but a coincidence is not a token. `pr-9` keeps the label off
          // the close chip now that the chip sits inside the toast's own edge
          // rather than hanging outside the corner.
          toast:
            "group toast group-[.toaster]:rounded-card group-[.toaster]:surface-float group-[.toaster]:font-sans group-[.toaster]:text-ui group-[.toaster]:pr-9",
          // No per-tier classes: the title inherits the toast's foreground ink
          // for every tier and the semantic colour rides the glyph (see
          // TOAST_ICONS). The description and the action / cancel buttons are
          // styled in globals.css, because sonner's rules for those parts tie
          // any `group-[.toast]:` class here and win on source order — the
          // classes that used to sit here never took effect.
        },
      }}
      {...props}
    />
  );
}
