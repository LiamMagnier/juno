import { notFound } from "next/navigation";
import { JUNO_FONTS } from "../fonts";
import { IconGallery, type GalleryView } from "./gallery";
import "../tokens.css";

/**
 * Juno icons, design round 3 (dev only; 404s in production).
 *
 *   /dev/design/juno/icons                    the sheet (every icon, 16/20/24, hover, on, disabled)
 *   /dev/design/juno/icons?theme=dark         theme: light | dark (absent: the OS decides)
 *   /dev/design/juno/icons?view=proof         every icon at 16 px, light beside dark
 *   /dev/design/juno/icons?view=lab           the stroke lab: 1, 1.25 and 1.5 px at 16
 *   /dev/design/juno/icons?view=context       sidebar, composer, message actions, menu, files
 *   /dev/design/juno/icons?view=states        on states, for the motion clips
 *   /dev/design/juno/icons?view=reel&group=composer   large, for recording hover
 *   /dev/design/juno/icons?view=focus&names=crew,bell   drawing review: 192 px on the grid, then 16/20/24 (on=1: the big one in its on state)
 *   rm=1                                      the reduced-motion form
 */
export const metadata = { title: "Juno icons" };

const VIEWS: GalleryView[] = ["sheet", "proof", "lab", "context", "reel", "states", "focus"];

export default async function JunoIconsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const theme = sp.theme === "dark" || sp.theme === "light" ? sp.theme : undefined;
  const view = typeof sp.view === "string" && (VIEWS as string[]).includes(sp.view) ? (sp.view as GalleryView) : "sheet";
  const group = typeof sp.group === "string" ? sp.group : undefined;
  const names = typeof sp.names === "string" ? sp.names : undefined;
  return (
    <div className={`jn ${JUNO_FONTS}`} data-theme={theme} data-rm={sp.rm === "1" ? "" : undefined}>
      <IconGallery view={view} group={group} names={names} on={sp.on === "1"} />
    </div>
  );
}
