/**
 * Rebindable keyboard map (DESIGN §8; the `{ key, command, when }` model T3
 * Code uses). `mod` is ⌘ on the Mac and Ctrl elsewhere. `when` is a small
 * boolean language over context keys: `a && !b || c` (no parentheses needed
 * for the defaults; `&&` binds tighter than `||`).
 */

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
}

export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { key: "mod+k", command: "palette.toggle", when: "!terminalFocus" },
  { key: "mod+n", command: "thread.new" },
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+j", command: "dock.terminal" },
  { key: "mod+d", command: "dock.changes", when: "!terminalFocus" },
  { key: "mod+p", command: "dock.files", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "dock.preview" },
  { key: "mod+shift+g", command: "dock.agents" },
  { key: "mod+shift+d", command: "dock.expand", when: "dockOpen" },
  { key: "mod+alt+d", command: "diff.toggleSplit", when: "changesFocus" },
  { key: "mod+shift+m", command: "picker.model", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "picker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "picker.nextProvider", when: "modelPickerOpen" },
  { key: "mod+shift+e", command: "composer.cycleEffort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.cycleMode", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "picker.orchestrate", when: "!terminalFocus" },
  { key: "mod+shift+w", command: "picker.contextWindow", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "thread.cycleDetail", when: "!terminalFocus" },
  { key: "mod+enter", command: "composer.steer", when: "composerFocus && turnRunning" },
  { key: "escape", command: "approval.deny", when: "approvalOpen && !popoverOpen" },
  { key: "enter", command: "approval.allowOnce", when: "approvalOpen && !composerFocus && !popoverOpen" },
  { key: "mod+shift+enter", command: "approval.allowSession", when: "approvalOpen" },
  { key: "arrowleft", command: "approval.previous", when: "approvalOpen && approvalMany && !editableFocus" },
  { key: "arrowright", command: "approval.next", when: "approvalOpen && approvalMany && !editableFocus" },
  { key: "]", command: "hunk.next", when: "changesFocus && !editableFocus" },
  { key: "[", command: "hunk.previous", when: "changesFocus && !editableFocus" },
  { key: "a", command: "hunk.accept", when: "changesFocus && !editableFocus" },
  { key: "r", command: "hunk.reject", when: "changesFocus && !editableFocus" },
  { key: "mod+z", command: "thread.undoLastTurn", when: "!editableFocus" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+f", command: "thread.find", when: "!terminalFocus" },
  { key: "mod+/", command: "shortcuts.show" },
];

export const COMMAND_TITLES: Record<string, string> = {
  "palette.toggle": "Command palette",
  "thread.new": "New session",
  "sidebar.toggle": "Toggle sidebar",
  "dock.terminal": "Terminal",
  "dock.changes": "Changes",
  "dock.files": "Files",
  "dock.preview": "Preview",
  "dock.agents": "Agents",
  "dock.expand": "Expand the dock",
  "diff.toggleSplit": "Split or unified diff",
  "picker.model": "Choose model",
  "picker.previousProvider": "Previous provider",
  "picker.nextProvider": "Next provider",
  "composer.cycleEffort": "Cycle effort",
  "composer.cycleMode": "Cycle permissions",
  "picker.orchestrate": "Orchestrate",
  "picker.contextWindow": "Context window",
  "thread.cycleDetail": "Cycle work-log detail",
  "composer.steer": "Steer the running turn",
  "approval.deny": "Deny",
  "approval.allowOnce": "Allow once",
  "approval.allowSession": "Allow for this session",
  "approval.previous": "Previous request",
  "approval.next": "Next request",
  "hunk.next": "Next hunk",
  "hunk.previous": "Previous hunk",
  "hunk.accept": "Accept hunk",
  "hunk.reject": "Reject hunk",
  "thread.undoLastTurn": "Undo the last turn",
  "thread.previous": "Previous thread",
  "thread.next": "Next thread",
  "thread.copyReference": "Copy reference",
  "thread.find": "Find in thread",
  "shortcuts.show": "Keyboard shortcuts",
};

export type KeyContext = Record<string, boolean | undefined>;

/** Evaluate a `when` clause against the context. Missing keys are false. */
export function evaluateWhen(when: string | undefined, ctx: KeyContext): boolean {
  if (!when || !when.trim()) return true;
  return when.split("||").some((conj) =>
    conj.split("&&").every((raw) => {
      const term = raw.trim();
      if (!term) return true;
      if (term.startsWith("!")) return !ctx[term.slice(1).trim()];
      return !!ctx[term];
    }),
  );
}

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", cmd: "mod", ctrl: "mod" };

export interface ParsedKey {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseKey(spec: string): ParsedKey {
  const parts = spec.toLowerCase().split("+").map((p) => KEY_ALIASES[p] ?? p);
  // "mod+shift++" style is not used; "]" and "[" are plain keys.
  const key = parts[parts.length - 1];
  return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
}

/** Normalised key name of an event ("Escape" → "escape", "{" with shift → "["). */
export function eventKeyName(e: KeyEventLike): string {
  const k = e.key.toLowerCase();
  if (k === "{") return "[";
  if (k === "}") return "]";
  return k;
}

export function keyMatches(spec: ParsedKey, e: KeyEventLike, mac: boolean): boolean {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  if (spec.mod !== mod) return false;
  if (spec.shift !== !!e.shiftKey) return false;
  if (spec.alt !== !!e.altKey) return false;
  // On the Mac, Ctrl is never part of these chords.
  if (mac && e.ctrlKey) return false;
  return spec.key === eventKeyName(e);
}

/**
 * The command a key event triggers, or null. Later bindings win over earlier
 * ones for the same chord (user overrides are appended after the defaults).
 */
export function resolveKeybinding(e: KeyEventLike, ctx: KeyContext, bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS, mac = true): string | null {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (keyMatches(parseKey(b.key), e, mac) && evaluateWhen(b.when, ctx)) return b.command;
  }
  return null;
}

/** Keycap text for a binding: "⌘⇧M" on the Mac, "Ctrl+Shift+M" elsewhere. */
export function formatKey(spec: string, mac = true): string {
  const p = parseKey(spec);
  const names: Record<string, string> = mac
    ? { enter: "↵", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", "/": "/" }
    : { enter: "Enter", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
  const key = names[p.key] ?? p.key.toUpperCase();
  if (mac) return `${p.alt ? "⌥" : ""}${p.mod ? "⌘" : ""}${p.shift ? "⇧" : ""}${key}`;
  return [p.mod ? "Ctrl" : "", p.alt ? "Alt" : "", p.shift ? "Shift" : "", key].filter(Boolean).join("+");
}

/** Conflicts: two bindings with the same chord whose `when` clauses can both hold (approximated: identical or empty). */
export function findConflicts(bindings: readonly Keybinding[]): [Keybinding, Keybinding][] {
  const out: [Keybinding, Keybinding][] = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i];
      const b = bindings[j];
      if (a.command === b.command) continue;
      const pa = parseKey(a.key);
      const pb = parseKey(b.key);
      if (pa.key !== pb.key || pa.mod !== pb.mod || pa.shift !== pb.shift || pa.alt !== pb.alt) continue;
      if (!a.when || !b.when || a.when === b.when) out.push([a, b]);
    }
  }
  return out;
}

export function bindingFor(command: string, bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS): Keybinding | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i].command === command) return bindings[i];
  return undefined;
}
