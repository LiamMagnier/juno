/*
 * Every icon name the foundations screens ask the Juno icon set for, grouped
 * by where it is used. The icon designer owns the drawings (./icons); this list
 * is the contract from this side, and the system sheet draws every entry.
 */
export const ICON_USAGE: { group: string; names: string[] }[] = [
  { group: "Shell", names: ["new-chat", "search", "folder", "library", "customize", "bell", "sidebar", "menu", "chevron-left", "share", "more"] },
  { group: "Composer", names: ["plus", "at", "mic", "voice", "send", "stop", "auto", "chevron-down", "close"] },
  { group: "Messages", names: ["copy", "check", "retry", "thumbs-up", "thumbs-down", "chevron-right", "globe", "chat"] },
  { group: "Work", names: ["progress", "circle", "hand", "alert", "pause", "routine", "edit"] },
  { group: "Code", names: ["repo", "branch", "pull-request", "laptop", "cloud", "external", "panel-right"] },
  { group: "Library and Customize", names: ["document", "deck", "design", "sheet", "image", "app", "skill", "memory", "instructions"] },
];

export const ICON_NAMES = ICON_USAGE.flatMap((g) => g.names);
