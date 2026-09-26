import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The painted plates: the front door's imagery (docs/design/premium-pass/BRIEF.md,
 * "Imagery"). Each scene is painted twice where it matters, at dawn for the
 * light theme and at dusk for the dark one, so the art follows the theme the
 * way the rest of the page does instead of a bright picture sitting in a dark
 * room. A plate is decoration: `alt=""` and aria-hidden, the words around it
 * carry the meaning.
 *
 * Server markup. Two <Image>s swapped by the `dark` class (the theme is
 * class-driven, tailwind.config.ts `darkMode`), both lazy unless `priority`.
 */

export type PlateName = "valley" | "coast" | "horizon" | "path";

const PLATES: Record<PlateName, { light: string; dark?: string; width: number; height: number }> = {
  valley: { light: "/brand/plates/valley-dawn.jpg", dark: "/brand/plates/valley-dusk.jpg", width: 1680, height: 944 },
  coast: { light: "/brand/plates/coast.jpg", width: 1136, height: 1408 },
  horizon: { light: "/brand/plates/horizon.jpg", width: 1776, height: 896 },
  path: { light: "/brand/plates/path.jpg", width: 944, height: 1680 },
};

export function Plate({
  name,
  className,
  imageClassName,
  priority = false,
  sizes = "100vw",
  dim = false,
}: {
  name: PlateName;
  className?: string;
  imageClassName?: string;
  priority?: boolean;
  sizes?: string;
  /** Lay a theme-aware scrim over single-variant plates in dark mode. */
  dim?: boolean;
}) {
  const plate = PLATES[name];
  const img = cn("object-cover", imageClassName);
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <Image
        src={plate.light}
        alt=""
        fill
        priority={priority}
        sizes={sizes}
        className={cn(img, plate.dark && "dark:hidden")}
      />
      {plate.dark && (
        <Image src={plate.dark} alt="" fill priority={priority} sizes={sizes} className={cn(img, "hidden dark:block")} />
      )}
      {/* A dawn plate in a dark room: bring it down to the ground's value
          so it reads as a lit window, not a flashbang. */}
      {dim && !plate.dark && <div className="absolute inset-0 hidden bg-background/40 dark:block" />}
      {/* Paper grain, fixed to the plate (not a scrolling container): the
          plates are soft, and a whisper of grain keeps the gradients from
          banding on wide displays. */}
      <div className="plate-grain absolute inset-0" />
    </div>
  );
}
