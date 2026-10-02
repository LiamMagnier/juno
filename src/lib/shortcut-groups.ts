import { BRAND } from "@/lib/brand/names";

/** Every shortcut the product answers to, grouped the way the hand finds
 *  them. Kept in step with use-global-shortcuts.ts, settings-modal.tsx and
 *  composer.tsx.
 *
 *  A function of the modifier label rather than a constant: every row used to
 *  print a hardcoded "⌘", so a Windows or Linux reader was shown sixteen
 *  shortcuts in a key their keyboard does not have — on the one page in the
 *  product whose whole job is to document the keyboard. `splitKeys` only
 *  breaks on the glyph set, so "Ctrl" stays one cap. */
export const shortcutGroups = (mod: string): { title: string; items: { keys: string[]; label: string }[] }[] => [
  {
    title: "Everywhere",
    items: [
      { keys: [mod, "K"], label: "Command menu" },
      { keys: [mod, "⇧", "O"], label: "New chat" },
      { keys: [mod, "⇧", "S"], label: "Toggle sidebar" },
      { keys: [mod, "⇧", "L"], label: "Toggle theme" },
      // Bound in settings-modal.tsx and missing from this sheet entirely.
      { keys: [mod, ","], label: "Settings" },
      { keys: [mod, "/"], label: "Keyboard shortcuts" },
    ],
  },
  {
    // The product switch landed these (use-global-shortcuts.ts) and the sheet
    // never learned them.
    title: "Products",
    items: [
      { keys: [mod, "⇧", "1"], label: BRAND.chat.label },
      { keys: [mod, "⇧", "2"], label: BRAND.code.label },
    ],
  },
  {
    title: "Composer",
    items: [
      { keys: ["↵"], label: "Send message" },
      { keys: ["⇧", "↵"], label: "New line" },
      { keys: [mod, "U"], label: "Attach files" },
      { keys: ["↑"], label: "Edit your last message (empty field)" },
      { keys: ["⇧", "Esc"], label: "Focus the composer" },
      { keys: ["Esc"], label: "Stop generating · close a menu" },
      { keys: ["/"], label: "Commands" },
      { keys: ["@"], label: "Apps and tools" },
    ],
  },
  {
    title: "Responses",
    items: [
      { keys: [mod, "⇧", "C"], label: "Copy the last response" },
      { keys: [mod, "⇧", ";"], label: "Copy the last code block" },
      // Under Responses, not Everywhere: it only binds once a transcript
      // exists (chat-view.tsx), and it searches the responses.
      { keys: [mod, "F"], label: "Find in conversation" },
    ],
  },
];

