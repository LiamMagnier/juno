import { COMMAND_TITLES, DEFAULT_KEYBINDINGS, parseKey, type Keybinding } from "@/lib/code-v2/keymap";

/**
 * Code's shortcuts as Settings › General › Keyboard shortcuts lists them:
 * grouped the way a hand finds them, each binding as the keycaps Chat's list
 * prints. Pure, so a test can hold the grouping and the key spelling; the
 * dialog only draws the result.
 *
 * Keyboard used to be two sections, Keyboard and "Code shortcuts", each with
 * its own "Everywhere" group. They now share one list and a Chat/Code switch,
 * so a Code shortcut is read in Code's context rather than beside a Chat one
 * with the same name and a different key.
 */
export interface ShortcutGroup {
  title: string;
  items: { label: string; keys: string[] }[];
}

/**
 * Groups into two columns of about the same height, in order, a group never
 * split: each group counts its rows plus one for its heading, and the cut
 * goes where the first column comes closest to half. The left column always
 * holds at least one group.
 */
export function splitShortcutColumns<T extends { items: readonly unknown[] }>(groups: readonly T[]): [T[], T[]] {
  const weight = (g: T) => g.items.length + 1;
  const total = groups.reduce((n, g) => n + weight(g), 0);
  let best = Math.min(1, groups.length);
  let bestGap = Infinity;
  let run = 0;
  for (let cut = 1; cut <= groups.length; cut++) {
    run += weight(groups[cut - 1]);
    const gap = Math.abs(total - 2 * run);
    if (gap < bestGap) {
      best = cut;
      bestGap = gap;
    }
  }
  return [groups.slice(0, best), groups.slice(best)];
}

/** The bindings in groups a hand finds them by, in Keyboard's order. */
const CODE_SHORTCUT_GROUPS: { title: string; has: (command: string) => boolean }[] = [
  { title: "Everywhere", has: (c) => ["palette.toggle", "thread.new", "sidebar.toggle", "shortcuts.show"].includes(c) },
  { title: "Panels", has: (c) => c.startsWith("dock.") },
  { title: "Composer", has: (c) => c.startsWith("composer.") || c.startsWith("picker.") },
  { title: "Approvals", has: (c) => c.startsWith("approval.") },
  { title: "Changes", has: (c) => c.startsWith("hunk.") || c.startsWith("diff.") },
  { title: "Threads", has: (c) => c.startsWith("thread.") },
];

/**
 * Command names where Code's own keymap words a shared shortcut differently
 * from Chat's: the same Ctrl K is "Command menu" on both. Local to settings;
 * the keymap's titles stay as Code's palette prints them.
 */
const SHARED_TITLES: Record<string, string> = {
  "palette.toggle": "Command menu",
};

const KEY_NAMES: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  backspace: "⌫",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** A binding as keycaps, in the order and glyphs Keyboard prints: modifier, ⌥, ⇧, key. */
export function bindingKeys(spec: string, mod: string): string[] {
  const p = parseKey(spec);
  const apple = mod === "⌘";
  return [
    p.mod ? mod : null,
    p.alt ? (apple ? "⌥" : "Alt") : null,
    p.shift ? "⇧" : null,
    KEY_NAMES[p.key] ?? p.key.toUpperCase(),
  ].filter((k): k is string => k !== null);
}

/** Code's default bindings, grouped, with anything unclaimed under "More". */
export function codeShortcutGroups(mod: string, bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS): ShortcutGroup[] {
  // `hunk.accept*` are the diff's in-place keys, documented in the diff itself.
  const shown = bindings.filter((b) => !b.command.startsWith("hunk.accept"));
  const out = CODE_SHORTCUT_GROUPS.map((g) => ({ title: g.title, bindings: [] as Keybinding[] }));
  const more: Keybinding[] = [];
  for (const b of shown) {
    const index = CODE_SHORTCUT_GROUPS.findIndex((g) => g.has(b.command));
    if (index < 0) more.push(b);
    else out[index].bindings.push(b);
  }
  return [...out, { title: "More", bindings: more }]
    .filter((g) => g.bindings.length > 0)
    .map((g) => ({
      title: g.title,
      items: g.bindings.map((b) => ({
        label: SHARED_TITLES[b.command] ?? COMMAND_TITLES[b.command] ?? b.command,
        keys: bindingKeys(b.key, mod),
      })),
    }));
}
