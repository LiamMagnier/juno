/**
 * Where a new design starts: the sizes it can start at, and the one call that
 * makes it.
 *
 * These lived inside `/design`, which was a door of its own for one artifact
 * type. The merge closes that door (04-MERGE-PLAN §4.1: design is a type, not
 * a place) and the presets move to the Artifacts home's New menu and to the
 * row pinned above the Designs filter, so they live here, where both can
 * import them without either owning them.
 *
 * No React in this file on purpose. It is imported by a client page, and it is
 * also imported by a test that runs in plain Node, which is how the list below
 * is held to the create route's own enum (tests/artifacts-home.test.ts).
 */

/**
 * The sizes a new design can start at. Named for what they are, so the choice
 * is about the thing being designed rather than about numbers.
 *
 * The keys are the `preset` enum of `POST /api/design` and nothing else: a key
 * here that the route does not accept is a menu item that answers "Invalid
 * input". The width and height are the route's frame for that key, and
 * `detail` is those two numbers as the reader sees them.
 */
export const DESIGN_PRESETS = [
  { key: "phone", label: "Phone", detail: "375 × 812", width: 375, height: 812 },
  { key: "tablet", label: "Tablet", detail: "834 × 1194", width: 834, height: 1194 },
  { key: "desktop", label: "Desktop", detail: "1440 × 900", width: 1440, height: 900 },
  { key: "square", label: "Square", detail: "1080 × 1080", width: 1080, height: 1080 },
] as const;

export type DesignPreset = (typeof DESIGN_PRESETS)[number];
export type DesignPresetKey = DesignPreset["key"];

/** What a new design is called until someone names it. */
export const UNTITLED_DESIGN = "Untitled design";

/** The toast when the create call fails without a reason of its own. */
export const START_DESIGN_ERROR = "Couldn’t start a design.";

/**
 * Start a design from nothing, and answer the new artifact's id.
 *
 * An artifact belongs to a conversation, so the route creates both — which is
 * why this is a POST and not client-side state. It answers the ID rather than
 * the `url` the route also returns: the route's url is `/a/{id}` today, but
 * where a design opens is the caller's decision, not the create route's, and
 * an id is the one thing every caller can build its own link from.
 *
 * Throws an Error whose message is fit for a toast: the route's own reason when
 * it gave one ("Your plan does not include the canvas."), else
 * START_DESIGN_ERROR. The caller owns the busy state and the toast, because
 * only it knows what was pressed.
 *
 * Takes the preset or its key, so a caller mapping over DESIGN_PRESETS can
 * hand either over without thinking about which.
 */
export async function startDesign(
  preset: DesignPreset | DesignPresetKey,
  options: { title?: string } = {}
): Promise<string> {
  const key = typeof preset === "string" ? preset : preset.key;
  const res = await fetch("/api/design", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: options.title ?? UNTITLED_DESIGN, preset: key }),
  });
  const data = (await res.json().catch(() => ({}))) as { artifactId?: unknown; error?: unknown };
  if (!res.ok || typeof data.artifactId !== "string" || !data.artifactId) {
    throw new Error(typeof data.error === "string" && data.error ? data.error : START_DESIGN_ERROR);
  }
  return data.artifactId;
}
