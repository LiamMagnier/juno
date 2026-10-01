import Link from "next/link";
import { notFound } from "next/navigation";
import { PORCELAIN_FONTS } from "./fonts";
import { PorcelainStage } from "./stage";
import { SCENES, isScene } from "./scene-ids";
import "./porcelain.css";

/**
 * Round 2, direction "Porcelain" (dev only; 404 in production).
 *
 *   /dev/design/porcelain                       index of scenes
 *   /dev/design/porcelain?scene=home            one scene, full viewport
 *     scene   home | thread | menus | crew | code | system | motion
 *     theme   light | dark        (default: the system's scheme)
 *     view    code: start | session
 *     full    1: let the page grow to its content (full-page captures)
 *     moment  motion: 1..8 plays one moment alone (for recording)
 *
 * Everything is direction-local: tokens and components live in this folder
 * and are scoped under .pc, so nothing here reaches the product.
 */
export const metadata = { title: "Porcelain" };

export default async function PorcelainPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { scene, theme, view, full, moment } = await searchParams;
  if (isScene(scene)) {
    return (
      <PorcelainStage
        scene={scene}
        theme={theme === "dark" || theme === "light" ? theme : undefined}
        view={typeof view === "string" ? view : undefined}
        full={full === "1"}
        moment={typeof moment === "string" ? Number(moment) || undefined : undefined}
        fontClass={PORCELAIN_FONTS}
      />
    );
  }
  return (
    <main className={`pc ${PORCELAIN_FONTS}`} data-theme="light" style={{ padding: 48 }}>
      <h1 className="pc-title">Porcelain</h1>
      <p className="pc-ui pc-muted mt-2">Round 2 direction. Each scene fills the viewport.</p>
      <ul className="mt-6 flex flex-col gap-1">
        {SCENES.map((s) => (
          <li key={s}>
            <Link className="pc-link pc-ui" href={`/dev/design/porcelain?scene=${s}`}>
              {s}
            </Link>
          </li>
        ))}
        <li>
          <Link className="pc-link pc-ui" href="/dev/design/porcelain?scene=code&view=start">
            code (start)
          </Link>
        </li>
      </ul>
    </main>
  );
}
