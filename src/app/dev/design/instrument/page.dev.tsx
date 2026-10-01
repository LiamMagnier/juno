import Link from "next/link";
import { notFound } from "next/navigation";
import { INSTRUMENT_FONT_CLASSES } from "./fonts";
import { InstrumentStage } from "./stage";
import { SCENES, isScene } from "./tokens";
import "./instrument.css";

/**
 * Refoundation design round 2, direction INSTRUMENT (dev only).
 *
 *   /dev/design/instrument                       index of scenes
 *   /dev/design/instrument?scene=home&theme=dark one scene, filling the viewport
 *
 *   scene   home | thread | menus | crew | code | system | motion
 *   theme   light | dark (omit to follow the OS)
 *   view    code: start | session
 *   moment  motion: one moment alone, for recording
 *   full    thread: render without the inner scroller, for full-page captures
 *   rm      force the reduced-motion forms
 *
 * Not linked from anywhere and 404s outside development, like /dev/controls.
 * The type lab that chose the faces lives at /dev/design/instrument/lab.
 */
export const metadata = { title: "Instrument" };

export default async function InstrumentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const scene = one("scene");
  const t = one("theme");
  const theme = t === "light" || t === "dark" ? t : "system";
  if (isScene(scene)) {
    return (
      <InstrumentStage
        scene={scene}
        theme={theme}
        fontClass={INSTRUMENT_FONT_CLASSES}
        full={one("full") === "1"}
        view={one("view")}
        moment={one("moment")}
        rm={one("rm") === "1"}
      />
    );
  }
  return (
    <main className={`${INSTRUMENT_FONT_CLASSES} min-h-dvh bg-[#0C0C0D] px-10 py-12 text-[#EDEDEF]`} style={{ fontFamily: "var(--in-font-sans)" }}>
      <h1 className="in-fs-28 tracking-[-0.02em]">Instrument</h1>
      <p className="mt-2 max-w-[60ch] in-fs-14 text-[#A6A6AD]">
        A precise instrument with one light in it. Graphite and hairlines, a condensed mono for the engraving, and a single chartreuse signal kept for Juno and the primary action.
      </p>
      <ul className="mt-8 grid max-w-[720px] grid-cols-2 gap-1">
        {SCENES.flatMap((s) =>
          (["dark", "light"] as const).map((th) => (
            <li key={`${s}-${th}`}>
              <Link className="flex h-9 items-center justify-between in-r-8 px-3 in-fs-135 hover:bg-white/5" href={`/dev/design/instrument?scene=${s}&theme=${th}`}>
                <span>{s}</span>
                <span className="font-mono in-fs-115 text-[#818189]">{th}</span>
              </Link>
            </li>
          )),
        )}
      </ul>
    </main>
  );
}
