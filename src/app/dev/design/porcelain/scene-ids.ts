export type SceneId = "home" | "thread" | "menus" | "crew" | "code" | "system" | "motion";
export const SCENES: SceneId[] = ["home", "thread", "menus", "crew", "code", "system", "motion"];

export function isScene(v: unknown): v is SceneId {
  return typeof v === "string" && (SCENES as string[]).includes(v);
}
