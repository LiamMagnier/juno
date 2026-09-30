import { notFound } from "next/navigation";
import { JUNO_FONTS } from "../fonts";
import { CrewLab, type LabSection } from "./lab";
import "../tokens.css";
import "./crew.css";

/**
 * Crew identity, design round 3 (dev only; 404s in production).
 *
 *   /dev/design/juno/crew                              the 3D lab, light and dark
 *   /dev/design/juno/crew?scene=lab&only=matrix        one lab section
 *   &theme=light|dark                                  one appearance
 */
export const metadata = { title: "Crew" };

export default async function CrewDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const theme = str("theme") === "light" || str("theme") === "dark" ? (str("theme") as "light" | "dark") : undefined;
  return (
    <div className={JUNO_FONTS}>
      <CrewLab only={str("only") as LabSection | undefined} theme={theme} />
    </div>
  );
}
