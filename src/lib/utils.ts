import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * Juno's fontSize keys are words, not t-shirt sizes, so stock tailwind-merge has
 * no way to know `text-label` is a SIZE. It classifies it as a colour and drops
 * it whenever a real `text-*` colour follows: cn("text-label","text-muted-foreground")
 * emitted only the colour, discarding the size, its 1.4 leading and its tracking.
 *
 * Every type token passed through cn() next to a colour has therefore been dead
 * for the life of the codebase. Registering the keys in the font-size group is
 * what makes the type scale usable at all — see the hand-rolled workarounds this
 * replaces in card.tsx and label.tsx.
 *
 * The list must be the WHOLE of tailwind.config's fontSize, not the rungs that
 * happened to be in play when it was written. `ui` and `micro` were left out and
 * are the two most-used rungs in the product (~384 sites), so the hole covered
 * more call sites than the fix did: 27 cn() sites were silently dropping one of
 * them. A partial list is worse than no list, because the rungs that DO work
 * make the mechanism look sound.
 *
 * `micro` is registered in both groups on purpose — `text-micro` (10.5px type)
 * and `rounded-micro` (2px corner) are unrelated tokens that share a name.
 *
 * And the failure is not only a lost size — it runs both ways. Because the token
 * is TAKEN FOR a colour, it also evicts the real colour beside it, whichever way
 * round they are written: at work-decisions.tsx:402
 * `cn("...text-foreground", answerable ? ... : "text-ui")` emitted `text-ui`
 * alone, dropping `text-foreground` too. That one happens to re-inherit the same
 * colour from an ancestor, so only the size was visibly wrong — but it is the
 * same eviction, one `text-muted-foreground` ancestor away from showing.
 */
/*
 * The radius ladder has exactly the same problem, and it is worse because it
 * fails silently in the other direction.
 *
 * `rounded-composer-control` is not a value stock tailwind-merge recognises, so
 * it cannot tell that it CONFLICTS with `rounded-field`. Both survive the merge,
 * and which one wins is then decided by the order Tailwind happened to emit them
 * in — not by the order the author wrote them. The consequence: any radius
 * passed to a component that already sets one is quietly discarded.
 *
 * Measured on the composer's thinking-effort trigger, which ended up carrying
 * THREE at once — `rounded-field` (10px, Button's base), `rounded-control` (9px,
 * from size="sm") and `rounded-composer-control` (12px, from the call site). The
 * call site lost, so the two chips in one control pair rendered at 12px and 10px.
 * That is true of every `<Button className="rounded-*">` in the product, which is
 * a large share of the radius drift the ladder was introduced to end.
 *
 * Registering the keys is what makes the ladder authoritative: last one wins,
 * which is what every author already assumed.
 *
 * `inherit` is on the list for the same completeness reason as `ui`/`micro`
 * above: it is a real borderRadius key and `rounded-inherit` is a real class
 * (composer.tsx's drag scrim), so leaving it out would make a cn() that pairs it
 * with any other radius emit-order dependent. Nothing was broken by its absence
 * today — that scrim's className is a plain literal, not a cn() — so this is
 * insurance, not a repair.
 *
 * What this group does NOT cover is the per-corner classes. tailwind-merge keeps
 * `rounded-t` / `rounded-b` / `rounded-tl` / … in their own class groups, and
 * none of them is extended here, so `rounded-b-inherit` (composer-shell.tsx) and
 * `rounded-b-card` (message-item.tsx) are unregistered for every ladder key —
 * adding `inherit` below does not reach them. Both are single radii in their
 * cn(), so nothing collides today; extend the matching `rounded-b` group at the
 * point a second one shows up rather than mirroring the whole ladder twelve ways
 * on spec.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Mirrors tailwind.config.ts `fontSize` exactly — keep the two in step.
      "font-size": [
        {
          text: [
            "hero", "display", "page-title", "title", "heading",
            "body-lg", "body", "ui", "label", "caption", "micro",
          ],
        },
      ],
      // Mirrors tailwind.config.ts `borderRadius` (minus Tailwind's own
      // sm/md/lg, which stock tailwind-merge already knows).
      rounded: [
        {
          rounded: [
            "micro", "xs", "control", "field", "menu", "card", "popover",
            "surface", "composer", "composer-control", "composer-action",
            "panel", "logo", "inherit",
          ],
        },
      ],
      // Mirrors tailwind.config.ts `boxShadow`. Same failure as the radius
      // ladder: stock tailwind-merge only knows t-shirt sizes, so
      // cn("shadow-raised", "shadow-none") kept BOTH and emit order decided —
      // which is how a hover `shadow-raised-lg` on a card that already had
      // `shadow-none` in its base could silently never apply.
      shadow: [
        {
          shadow: [
            "raised", "raised-lg", "inset", "pressed", "float",
            "soft", "lift", "glass", "pop", "well",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}

/**
 * Per-item entrance delay for a staggered list, with a hard index cap.
 *
 * Nine different formulas had grown across twelve files, several of them capped
 * at 12 — a 480–660ms tail before the last item lands, which stops reading as
 * choreography and starts reading as slow loading. Capping the index at 5 holds
 * the whole stagger under ~200ms; 40ms is kept because it sits inside the
 * 40–60ms range Juno already used, so the felt rhythm is unchanged.
 *
 * Never stagger something the user is about to aim at — a model-picker row that
 * has not faded in yet is a row that cannot be clicked. The cap guarantees
 * everything past index 5 is live on the same frame.
 */
export const stagger = (i: number, step = 40) => ({ animationDelay: `${Math.min(i, 5) * step}ms` });

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function truncate(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Compact token count for UI: 940 · 1.2K · 34K · 1.20M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Money for tiny per-message costs: <$0.0001 · $0.0032 · $0.123 · $1.23. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
