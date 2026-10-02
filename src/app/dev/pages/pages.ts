/** The pages /dev/pages can show, and the states each can be in. Shared by the server route and the client gallery. */
export const PAGES = [
  "library",
  "projects",
  "project",
  "artifacts",
  "connections",
  "agents",
  "automations",
  "compare",
  "settings",
  "memory",
  "skills",
  "instructions",
  "code",
  "notifications",
  "search",
] as const;
export type PageName = (typeof PAGES)[number];

export const STATES = ["ready", "empty", "loading", "error"] as const;
export type PageState = (typeof STATES)[number];
