"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Upload } from "@/components/ui/icons";
import { transition } from "@/lib/motion";

/**
 * Dropping files anywhere on the Library, and the overlay that says it will work.
 *
 * THE DEPTH COUNT is the whole trick, and the reason the composer's overlay
 * flickers where this one does not. `dragleave` fires every time the pointer
 * crosses from an element into one of its own children, and `dragenter` fires
 * on the child just before it; a boolean set false on leave and true on
 * enter/over therefore blinks off and on at every edge inside the page. The
 * events are balanced (the new element's enter always precedes the old one's
 * leave), so counting them tells "moved between children" (the count stays
 * above zero) from "left the page" (it reaches zero) without a timer.
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
  const depth = React.useRef(0);
  const onFilesRef = React.useRef(onFiles);
  React.useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // Turning the zone off mid-drag (the view changed under the pointer) must
  // not leave the overlay standing.
  React.useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setDragging(false);
    }
  }, [enabled]);

  const carriesFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  const handlers = React.useMemo(
    () => ({
      onDragEnter: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        if (depth.current === 1) setDragging(true);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        // Without this the browser refuses the drop and opens the file instead.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!enabled || !carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onFilesRef.current(files);
      },
    }),
    [enabled],
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
 * which is what keeps the depth count above honest.
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
