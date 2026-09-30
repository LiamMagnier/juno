/* Shared by the server page and the client stage (a client module's exports are references on the server). */
export const SCENE_IDS = ["home", "thread", "menus", "crew", "code", "library", "customize", "system", "motion"] as const;
export type SceneId = (typeof SCENE_IDS)[number];
