"use client";

import * as React from "react";
import type { PendingUpload } from "@/hooks/use-uploads";
import { isTextExtractable } from "@/lib/uploads";

/**
 * Whether the files on the composer can actually be READ, answered before the
 * message is sent.
 *
 * WHY THIS EXISTS. Indexing is scheduled, not awaited (`scheduleIngest`): an
 * upload responds as soon as the bytes are stored, so every attachment reaches
 * the client as `queued` and settles seconds later in a worker the client
 * never hears from. Nothing showed that, so a PDF Juno could not read looked
 * exactly like one it could — through writing the message, sending it, and
 * waiting — and the first word on the subject came from the model, in the
 * reply, having spent the request.
 *
 * SCOPED TO THE FILES WHERE IT MATTERS, which is narrower than it looks. A
 * `.txt`, `.md`, `.csv` or `.json` is stored with a flat `extractedText` at
 * upload time and reaches the model whatever the index does, so a failed index
 * on one of those costs citations, not content — warning about it would be a
 * lie. `isTextExtractable` excludes the binary documents from that flat path:
 * a PDF, and now a .docx, .xlsx or .pptx, gets its text from the indexer and
 * from nowhere else.
 *
 * IT ASKS WHAT THE MODEL WILL RECEIVE, NOT WHAT THE PARSER CONCLUDED, and the
 * distance between those two questions is where this hook used to get the
 * commonest case exactly backwards. A scanned PDF extracts to nothing, which
 * on the index alone reads as a file Juno "could not read" — and it is nothing
 * of the kind: its pages draw perfectly (measured: 5 of 7 zero-text PDFs in a
 * real corpus render a clean page image) and every vision model in the
 * catalogue reads a page it is shown. `visual` is that case, and telling those
 * people their file had failed sent them looking for another copy of a
 * document that was always going to work.
 */
export type AttachmentReadiness = "reading" | "unreadable" | "visual" | "partial" | "ready";

const PENDING = new Set(["queued", "indexing", "extracting", "ocr"]);
const UNREADABLE = new Set(["failed", "skipped"]);

/** Fast at first, then slower: most files settle in the first second or two. */
const POLL_MS = [1200, 1200, 1800, 2500, 4000] as const;
/** After this, stop asking. A state that has not settled is not going to. */
const MAX_POLLS = 14;

interface AttachmentFacts {
  state: string;
  /** Text was extracted, so every adapter has something to send. */
  readable: boolean;
  /** Its pages can be drawn, so any model that can see can read it. */
  visual: boolean;
}

export function useAttachmentReadiness(
  uploads: readonly PendingUpload[],
): Map<string, AttachmentReadiness> {
  const [facts, setFacts] = React.useState<Record<string, AttachmentFacts>>({});

  /*
   * The ids worth asking about: uploaded, not an image, and on the index-only
   * path. Joined into a string so the effect below keys on the SET rather than
   * on the array identity — `uploads` is a fresh array on every keystroke of
   * the draft it sits above.
   */
  const watched = uploads
    .map((upload) => upload.attachment)
    .filter(
      (attachment): attachment is NonNullable<typeof attachment> =>
        !!attachment && attachment.kind === "FILE" && !isTextExtractable(attachment.mimeType),
    )
    .map((attachment) => attachment.id);
  const key = watched.join(",");

  React.useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;

    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/attachments/state?ids=${encodeURIComponent(ids.join(","))}`);
        if (!cancelled && res.ok) {
          const body = (await res.json()) as {
            states?: Record<string, string>;
            readable?: Record<string, boolean>;
            visual?: Record<string, boolean>;
          };
          if (body.states) {
            const next: Record<string, AttachmentFacts> = {};
            for (const [id, state] of Object.entries(body.states)) {
              next[id] = {
                state,
                readable: body.readable?.[id] ?? false,
                visual: body.visual?.[id] ?? false,
              };
            }
            setFacts((prev) => ({ ...prev, ...next }));
          }
          // Settled everywhere: stop, rather than polling a row that will not
          // change again until someone re-uploads the file.
          const settled = ids.every((id) => {
            const state = body.states?.[id];
            return state !== undefined && !PENDING.has(state);
          });
          if (settled) return;
        }
      } catch {
        // A failed poll is not a failed file. Try again on the next beat; the
        // tile keeps saying "Reading…", which remains true.
      }
      if (cancelled || ++polls >= MAX_POLLS) return;
      timer = setTimeout(tick, POLL_MS[Math.min(polls, POLL_MS.length - 1)]);
    };

    // One beat before the first ask: indexing starts after the upload response
    // flushes, so an immediate poll is guaranteed to read `queued`.
    timer = setTimeout(tick, POLL_MS[0]);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  const out = new Map<string, AttachmentReadiness>();
  for (const id of watched) {
    const fact = facts[id];
    if (!fact || PENDING.has(fact.state)) {
      out.set(id, "reading");
      continue;
    }
    /*
     * The order is the point, and it is read off what the model receives
     * rather than off what the indexer concluded.
     *
     * Text first: a file with extracted text is readable on every provider,
     * whatever state the parser settled in. Then pictures: a PDF with no text
     * is a scan, and a scan is a stack of pages a vision model reads fine.
     * Only a file that is neither — no text, nothing to draw — has actually
     * failed, and that is now rare enough to be worth saying plainly.
     */
    if (fact.readable) out.set(id, fact.state === "degraded" ? "partial" : "ready");
    else if (fact.visual) out.set(id, "visual");
    else if (UNREADABLE.has(fact.state) || fact.state === "degraded") out.set(id, "unreadable");
    else out.set(id, "ready");
  }
  return out;
}
