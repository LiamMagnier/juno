import { notFound } from "next/navigation";
import { JUNO_FONTS } from "../fonts";
import { CrewGallery, type GalleryScene } from "./gallery";
import "../tokens.css";
import "./crew.css";

/**
 * Crew characters, design round 3 (dev only; 404s in production).
 *
 *   /dev/design/juno/crew                       the whole lab, light and dark side by side
 *   /dev/design/juno/crew?scene=<section>       one section (roster, matrix, states, ...)
 *   &theme=light|dark                           one appearance
 */
export const metadata = { title: "Crew" };

export default async function CrewDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const theme = str("theme") === "light" || str("theme") === "dark" ? (str("theme") as "light" | "dark") : undefined;
  const scene = (str("scene") ?? "lab") as GalleryScene;
  const themes: ("light" | "dark")[] = theme ? [theme] : ["light", "dark"];
  return (
    <div className={`${JUNO_FONTS} jcg-page`} data-cols={themes.length}>
      {themes.map((t) => (
        <div key={t} className="jn jcg-pane" data-theme={t} data-rm={str("rm") === "1" ? "" : undefined}>
          <CrewGallery scene={scene} params={{ id: str("id"), state: str("state"), size: str("size") ? Number(str("size")) : undefined, tab: str("tab"), step: str("step") }} />
        </div>
      ))}
    </div>
  );
}
