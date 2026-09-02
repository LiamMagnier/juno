"use client";

import * as React from "react";
import { toast } from "sonner";

/**
 * The shell's keyboard shortcuts — the ones that are not owned by a single
 * surface. Listed (and kept in step) in `ShortcutsSheet` (command-palette.tsx).
 *
 *   ⌘⇧S   toggle the sidebar
 *   ⇧Esc  focus the composer
 *   ⌘⇧C   copy the last response      → `juno:copy-last-response` (chat-view)
 *   ⌘⇧;   copy the last code block    (read from the transcript DOM)
 *   ⌘⇧L   toggle the theme            → `juno:toggle-theme` (command palette)
 *
 * ⌘K / ⌘⇧O / ⌘/ live in the command palette, which has always owned them.
 * Everything here is a modifier chord, so it is safe to fire while typing —
 * none of it types a character — except ⇧Esc, which is what a person presses
 * to get BACK to the composer from wherever focus wandered.
 */
export function useGlobalShortcuts({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && e.shiftKey && !mod) {
        const field = document.getElementById("juno-composer-textarea") as HTMLTextAreaElement | null;
        if (field && !field.disabled) {
          e.preventDefault();
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        }
        return;
      }
      if (!mod || !e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        onToggleSidebar();
      } else if (key === "c") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("juno:copy-last-response"));
      } else if (e.code === "Semicolon" || key === ";" || key === ":") {
        e.preventDefault();
        const blocks = document.querySelectorAll<HTMLElement>('[role="log"] pre code, [role="log"] pre');
        const last = blocks[blocks.length - 1];
        const text = last?.textContent?.trim();
        if (!text) {
          toast.message("No code block in this conversation yet.");
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Copied the last code block."))
          .catch(() => toast.error("Could not copy."));
      } else if (key === "l") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("juno:toggle-theme"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggleSidebar]);
}
