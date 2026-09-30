import { notFound } from "next/navigation";
import { CREW_FONT_CLASSES } from "./fonts";
import { CrewLab } from "./lab";
import { SketchSheet } from "./lab-sketch";
import type { Grammar } from "./lab-grammars";
import "./crew.css";

/**
 * Crew identity, design round 3 (dev only; 404s in production).
 *
 *   /dev/design/juno/crew?scene=lab               the four shape grammars, light and dark
 *   /dev/design/juno/crew?scene=lab&only=pebble   one grammar
 */
export const metadata = { title: "Crew" };

export default async function CrewDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const only = typeof sp.only === "string" ? (sp.only as Grammar) : undefined;
  if (sp.scene === "sketch") return <div className={CREW_FONT_CLASSES}><SketchSheet /></div>;
  return (
    <div className={CREW_FONT_CLASSES}>
      <CrewLab only={only} />
    </div>
  );
}
