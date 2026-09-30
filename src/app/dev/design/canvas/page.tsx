import Link from "next/link";
import { notFound } from "next/navigation";
import { CANVAS_FONT_CLASSES } from "./fonts";
import { TypeLab } from "./lab";
import { CanvasStage, type SceneId } from "./stage";
import "./canvas.css";
import "./composer.css";
import "./thread.css";
import "./pages.css";

/**
 * Round 2, direction CANVAS (dev only; 404s in production).
 *
 *   /dev/design/canvas                          index
 *   /dev/design/canvas?scene=home&theme=dark    one scene, filling the viewport
 *
 *   scene   home | thread | menus | panel | crew | code | code-start | system | motion | type
 *   theme   light | dark (default: the app's theme)
 *   rm      1 renders the reduced-motion form
 *   at      top (thread: start at the top instead of the newest)
 *   m       motion: one moment by id, large, for recording
 */
export const metadata = { title: "Canvas" };

const SCENES: { id: SceneId | "type"; label: string }[] = [
  { id: "home", label: "Home, Chat at rest" },
  { id: "thread", label: "Thread after send" },
  { id: "menus", label: "@ palette and model" },
  { id: "panel", label: "App token panel" },
  { id: "crew", label: "Crew" },
  { id: "code-start", label: "Code, start" },
  { id: "code", label: "Code, working session" },
  { id: "system", label: "Component sheet" },
  { id: "motion", label: "Motion moments" },
  { id: "type", label: "Type lab" },
];

export default async function CanvasDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params[k] = v;
  const scene = params.scene;
  const theme = params.theme === "dark" || params.theme === "light" ? params.theme : undefined;

  if (scene === "type") {
    return (
      <div className="cv" data-theme={theme}>
        <TypeLab only={params.only} />
      </div>
    );
  }
  if (scene && SCENES.some((s) => s.id === scene)) {
    return <CanvasStage scene={scene as SceneId} theme={theme} reduced={params.rm === "1"} params={params} fontClass={CANVAS_FONT_CLASSES} />;
  }
  return (
    <div className={`cv ${CANVAS_FONT_CLASSES}`} data-theme={theme}>
      <main className="cv-index">
        <h1 className="t-title">Canvas</h1>
        <p className="t-body ink-2">A bright canvas, ink type, one floating composer, and colour only where things bring their own.</p>
        <nav className="cv-index__list">
          {SCENES.map((s) => (
            <Link key={s.id} className="cv-row" href={`/dev/design/canvas?scene=${s.id}`}>
              <span className="cv-row__text">{s.label}</span>
              <span className="cv-row__meta">scene={s.id}</span>
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
