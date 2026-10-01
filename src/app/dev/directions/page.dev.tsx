import Link from "next/link";
import { notFound } from "next/navigation";
import { DIRECTION_FONT_CLASSES } from "./fonts";
import { SignatureGlyph } from "./glyphs";
import { DirectionScope, DirectionStage, DirectionStyles } from "./stage";
import { DIRECTIONS, DIRECTION_IDS, SCENES, SCENE_LABEL, isDirectionId, isSceneId } from "./tokens";
import "./directions.css";

/**
 * Dev-only gallery for the Refoundation's identity decision
 * (PRODUCT_REFOUNDATION §12): three candidate design systems, Ion, Graphite
 * and Meridian, rendered on the same five scenes with the real components, so
 * they are compared on rendered evidence rather than on swatches.
 *
 *   /dev/directions                         the index: every combination
 *   /dev/directions?d=ion&scene=home        one direction, one scene, filling
 *                                           the viewport (for screenshots)
 *
 *   d      ion | graphite | meridian
 *   scene  home | thread | menus | crew | system
 *
 * A direction is a token scope (tokens.ts → the generated sheet, and
 * directions.css for type, shape and motion). Nothing outside this folder
 * changes. Light or dark follows the app's theme setting (or the system).
 *
 * Not linked from anywhere and 404s outside development, the same contract
 * as /dev/controls.
 */
export const metadata = { title: "Directions" };

export default async function DirectionsDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { d, scene } = await searchParams;
  if (isDirectionId(d) && isSceneId(scene)) {
    return <DirectionStage direction={d} scene={scene} fontClass={DIRECTION_FONT_CLASSES[d]} />;
  }

  return (
    <>
      <DirectionStyles directions={DIRECTION_IDS} />
      <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-3">
        {DIRECTION_IDS.map((id) => {
          const spec = DIRECTIONS[id];
          const r = spec.radii;
          return (
            <DirectionScope key={id} direction={id} fontClass={DIRECTION_FONT_CLASSES[id]} className="border-b border-border px-6 py-10 sm:px-10 lg:border-b-0 lg:border-r lg:last:border-r-0">
              <section aria-labelledby={`dir-${id}`} className="flex flex-col">
                <p className={id === "graphite" ? "flex items-center gap-4 text-foreground" : "dir-text-brand flex items-center gap-4"}>
                  <SignatureGlyph direction={id} size={40} label={`${spec.signature.name} mark`} />
                  <SignatureGlyph direction={id} size={40} state="thinking" className="dir-text-brand" label="Thinking" />
                </p>
                <h1 id={`dir-${id}`} className="mt-6 text-title text-foreground">
                  {spec.name}
                </h1>
                <p className="mt-2 text-body text-muted-foreground">{spec.line}</p>
                <dl className="mt-6 space-y-2 text-ui">
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-muted-foreground">Faces</dt>
                    <dd className="text-foreground">
                      {spec.type.sans}, {spec.type.mono}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-muted-foreground">Radii</dt>
                    <dd className="font-mono text-micro leading-5 text-foreground">
                      {[r.control, r.field, r.menu, r.card, r.panel, r.composer].join(", ")}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-muted-foreground">Signature</dt>
                    <dd className="text-foreground">{spec.signature.name}</dd>
                  </div>
                </dl>
                <nav aria-label={`${spec.name} scenes`} className="mt-8 flex flex-col">
                  {SCENES.map((scene) => (
                    <Link
                      key={scene}
                      href={`/dev/directions?d=${id}&scene=${scene}`}
                      className="flex h-10 items-center justify-between rounded-control px-3 text-body text-foreground transition-colors duration-fast ease-out-soft hover:bg-accent"
                    >
                      {SCENE_LABEL[scene]}
                      <span className="font-mono text-micro text-muted-foreground">
                        d={id}&amp;scene={scene}
                      </span>
                    </Link>
                  ))}
                </nav>
              </section>
            </DirectionScope>
          );
        })}
      </main>
    </>
  );
}
