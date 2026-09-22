"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StatusIcons } from "@/lib/app-icons";
import { transition } from "@/lib/motion";

export type SaveState = "idle" | "saving" | "saved" | "failed";

/** How long "Saved" stays before it fades: long enough to be seen, short enough not to be furniture. */
const SAVED_HOLD_MS = 1800;
/** A failure stays longer, because it is the one the reader has to act on. */
const FAILED_HOLD_MS = 5000;

/**
 * The quiet confirmation every settings control shares.
 *
 * It sits beside the row's label rather than beside the control, so its
 * arrival moves nothing the pointer is on. Saving shows nothing: every write
 * is optimistic, the control already shows the new value, and a spinner that
 * flashes for 80ms reads as a glitch. Success is a check and one word that
 * fade in on the fast rung and out on the exit rung. Failure says so in the
 * destructive ink and stays a little longer; the toast from
 * `useSettingsSave` carries the server's reason.
 *
 * The live region is mounted in every state so the announcement is reliable;
 * only the words inside it come and go.
 */
export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center text-caption">
      <AnimatePresence initial={false}>
        {state === "saved" && (
          <motion.span
            key="saved"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: transition.fast }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="inline-flex items-center gap-1 text-muted-foreground"
          >
            <StatusIcons.success className="size-3.5 text-success-ink" aria-hidden />
            Saved
          </motion.span>
        )}
        {state === "failed" && (
          <motion.span
            key="failed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: transition.fast }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="inline-flex items-center gap-1 text-destructive-ink"
          >
            <StatusIcons.error className="size-3.5" aria-hidden />
            Not saved
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * Per-control save states for one section, keyed by whatever the section
 * likes (usually the settings field). `track` wraps any write that resolves
 * to success, so a switch, a picker, a text field saved on blur and a write
 * that is not a plain settings PATCH (the name, the spend ceiling) all report
 * the same way.
 *
 * Only the newest write for a key may set its status, so a slow first write
 * cannot overwrite the result of a quicker second one.
 */
export function useSaveStates() {
  const [states, setStates] = React.useState<Record<string, SaveState>>({});
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sequence = React.useRef(new Map<string, number>());

  React.useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach((timer) => clearTimeout(timer));
  }, []);

  const track = React.useCallback(async (key: string, write: () => Promise<boolean>) => {
    const seq = (sequence.current.get(key) ?? 0) + 1;
    sequence.current.set(key, seq);
    clearTimeout(timers.current.get(key));
    setStates((current) => ({ ...current, [key]: "saving" }));
    const ok = await write();
    if (sequence.current.get(key) !== seq) return ok;
    setStates((current) => ({ ...current, [key]: ok ? "saved" : "failed" }));
    timers.current.set(
      key,
      setTimeout(() => setStates((current) => ({ ...current, [key]: "idle" })), ok ? SAVED_HOLD_MS : FAILED_HOLD_MS)
    );
    return ok;
  }, []);

  const status = React.useCallback((key: string): SaveState => states[key] ?? "idle", [states]);
  return { status, track };
}
