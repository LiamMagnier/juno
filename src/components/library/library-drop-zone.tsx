"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Upload } from "@/components/ui/icons";
import { transition } from "@/lib/motion";

function carriesFiles(event: React.DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** The entered elements still inside the zone: a removed element never sends its `dragleave`. */
function stillInside(zone: EventTarget, targets: EventTarget[]) {
  return targets.filter((target) => target instanceof Node && zone instanceof Node && zone.contains(target));
}

/**
 * Dropping files anywhere on the Library, and the overlay that says it will work.
 *
 * THE ENTERED-ELEMENTS SET is the whole trick, and the reason the composer's
 * overlay flickers where this one does not. `dragleave` fires every time the
 * pointer crosses from an element into one of its own children, and
 * `dragenter` fires on the child just before it; a boolean set false on leave
 * and true on enter/over therefore blinks off and on at every edge inside the
 * page. Keeping the elements entered and not yet left tells "moved between
 * children" (the set is not empty) from "left the page" (it is) without a
 * timer.
 *
 * A set of elements rather than a bare count, because the events are only
 * balanced while the elements live. An element removed mid-drag (an upload
 * row replaced by its finished row, a page of results arriving) never fires
 * its `dragleave`, and a count left one too high kept the overlay up after
 * the files had gone. Elements no longer inside the zone are dropped from the
 * set on every event, and a drag that ends anywhere clears it.
 *
 * Only a drag carrying FILES counts. Dragging a link or selected text across
 * the page is not an upload, and an overlay promising one would be a lie.
 */
export function useFileDrop({
  onFiles,
  enabled = true,
}: {
  onFiles: (files: File[]) => void;
  enabled?: boolean;
}) {
  const [dragging, setDragging] = React.useState(false);
  const entered = React.useRef<EventTarget[]>([]);
  const onFilesRef = React.useRef(onFiles);
  React.useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  const reset = React.useCallback(() => {
    entered.current = [];
    setDragging(false);
  }, []);

  // Turning the zone off mid-drag (the view changed under the pointer) must
  // not leave the overlay standing.
  React.useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  // A drag that ends outside the zone (dropped on the sidebar, cancelled with
  // Escape over another element) says so only to the window.
  React.useEffect(() => {
    if (!dragging) return;
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [dragging, reset]);

  const handlers = React.useMemo(
    () => ({
      onDragEnter: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        event.preventDefault();
        const targets = stillInside(event.currentTarget, entered.current);
        if (!targets.includes(event.target)) targets.push(event.target);
        entered.current = targets;
        setDragging(true);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        // Without this the browser refuses the drop and opens the file instead.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        const targets = stillInside(event.currentTarget, entered.current).filter((target) => target !== event.target);
        entered.current = targets;
        if (targets.length === 0) setDragging(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        event.preventDefault();
        reset();
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onFilesRef.current(files);
      },
    }),
    [enabled, reset],
  );

  return { dragging, handlers };
}

/**
 * What the page shows while files are held over it.
 *
 * A dashed edge in the accent at low strength (a drop target is a state, and
 * the accent is the state colour), a scrim that lets the list show through so
 * the reader still knows where they are, and one sentence. It fades in on the
 * fast rung and out a little faster than it arrived: the drop, or the pointer
 * leaving, has already happened by the time it goes. Opacity plus a 2% scale
 * on the inner block only; reduced motion keeps the fade.
 *
 * `pointer-events-none` so the drag keeps landing on the page underneath,
 * which is what keeps the entered-elements set above honest.
 */
export function LibraryDropOverlay({ open }: { open: boolean }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="library-drop"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: transition.fast }}
          exit={{ opacity: 0, transition: transition.exit }}
          className="pointer-events-none absolute inset-2 z-popper grid place-items-center rounded-panel border-2 border-dashed border-primary/45 bg-background/85 backdrop-blur-sm"
        >
          <motion.div
            initial={reduce ? false : { scale: 0.98 }}
            animate={{ scale: 1, transition: transition.base }}
            className="flex flex-col items-center gap-3 px-6 text-center"
          >
            <span className="grid size-12 place-items-center rounded-field bg-secondary text-foreground">
              <Upload motion="none" className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="text-body font-medium text-foreground">Drop files to add them to your library</p>
              <p className="text-caption text-muted-foreground">Images, PDFs, documents, spreadsheets and code</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
