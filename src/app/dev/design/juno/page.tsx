import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { JUNO_FONTS, LAB_FONTS, LAB_SANS, LAB_SERIF_CYR } from "./fonts";
import { SCENE_IDS, type SceneId } from "./scene-ids";
import { JunoStage } from "./stage";
import "./tokens.css";
import "./shell.css";
import "./composer.css";
import "./thread.css";
import "./pages.css";
import "./sheet.css";
import "./member.css";

/**
 * Juno, design round 3: the converged system (dev only; 404s in production).
 *
 *   /dev/design/juno                               index
 *   /dev/design/juno?scene=home&theme=dark         one scene, filling the viewport
 *
 *   scene   home | thread | menus | crew | code | library | customize | system | motion | states
 *   theme   light | dark (absent: the OS decides, prefers-color-scheme)
 *   rm      1 renders the reduced-motion form
 *   home    empty at rest; draft=1 (the sentence with tokens), focus=1, app=stripe (token panel), model=1, plus=1, pop=account|activity
 *   thread  at=top (the dock names what needs you), plan=1, stage=thinking|streaming
 *   crew    member=mira (the member's own thread), flow=add | flow=customize&member=mira (the editor)
 *   code    state=start, pane=changes (the diff as the one pane, narrow windows)
 *   library view=list, q=<search>
 *   states  loading, empty, error, blocked, offline, slow
 *   customize  app=slack (the app's sheet open)
 *   motion  m=<moment id> (one moment, large, for recording)
 *   font    inter | geologica | commissioner | franklin | manrope | wix (the sans lab)
 *   cyr     literata | sourceserif (the Cyrillic serif lab)
 */
export const metadata = { title: "Juno design" };

const SCENES: { id: SceneId; label: string; extra?: string[] }[] = [
  { id: "home", label: "Home, Chat at rest", extra: ["draft=1", "focus=1", "app=stripe", "model=1", "plus=1", "pop=account", "pop=activity"] },
  { id: "thread", label: "Thread after send", extra: ["stage=thinking", "stage=streaming", "plan=1", "at=top"] },
  { id: "menus", label: "@ palette, model, app panel" },
  { id: "crew", label: "Crew roster and a member's thread", extra: ["member=mira", "flow=add", "flow=customize&member=mira"] },
  { id: "code", label: "Juno Code, start and working session", extra: ["state=start", "pane=changes"] },
  { id: "library", label: "Library", extra: ["view=list", "q=invoice"] },
  { id: "customize", label: "Customize, Apps", extra: ["app=slack"] },
  { id: "system", label: "Component sheet" },
  { id: "motion", label: "Motion moments" },
  { id: "states", label: "Loading, empty, error, blocked, offline" },
];

export default async function JunoDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params[k] = v;
  const theme = params.theme === "dark" || params.theme === "light" ? params.theme : undefined;

  const override: Record<string, string> = {};
  if (params.font && LAB_SANS[params.font]) override["--font-sans"] = `${LAB_SANS[params.font]}, ui-sans-serif, system-ui, sans-serif`;
  if (params.cyr && LAB_SERIF_CYR[params.cyr]) override["--font-serif"] = `var(--jn-serif), ${LAB_SERIF_CYR[params.cyr]}, Georgia, serif`;
  const lab = Object.keys(override).length > 0;

  const scene = params.scene as SceneId | undefined;
  if (scene && (SCENE_IDS as readonly string[]).includes(scene)) {
    return (
      <JunoStage
        scene={scene}
        theme={theme}
        params={params}
        fontClass={lab ? `${JUNO_FONTS} ${LAB_FONTS}` : JUNO_FONTS}
        fontOverride={lab ? (override as CSSProperties) : undefined}
      />
    );
  }

  return (
    <div className={`jn ${JUNO_FONTS}`} data-theme={theme}>
      <main className="jn-index">
        <h1 className="t-title">Juno</h1>
        <p className="jn-index__lede">Design round 3. One system: a bright neutral ground, graphite ink, Newsreader for the moments that speak, and colour only where things bring their own.</p>
        <nav className="jn-index__list">
          {SCENES.map((s) => (
            <div key={s.id} className="jn-index__row">
              <Link className="jn-index__main" href={`/dev/design/juno?scene=${s.id}`}>
                {s.label}
              </Link>
              <span className="jn-index__links">
                <Link href={`/dev/design/juno?scene=${s.id}&theme=light`}>light</Link>
                <Link href={`/dev/design/juno?scene=${s.id}&theme=dark`}>dark</Link>
                {s.extra?.map((e) => (
                  <Link key={e} href={`/dev/design/juno?scene=${s.id}&${e}`}>
                    {e}
                  </Link>
                ))}
              </span>
            </div>
          ))}
        </nav>
      </main>
    </div>
  );
}
