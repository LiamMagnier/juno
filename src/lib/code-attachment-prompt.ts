/*
 * WHAT AN ATTACHMENT LOOKS LIKE TO AN AGENT THAT CANNOT OPEN FILES.
 *
 * A Juno Code run reaches its agent as one string. Attachments therefore have
 * to be folded into that string — the extracted text where we have it, a named
 * placeholder where we do not — and until now that fold lived as a private
 * function inside the task create route. Mid-run steering needs exactly the
 * same fold (an instruction that carries a screenshot has to reach the running
 * agent the same way the first prompt did), and a second copy of it would be
 * two spellings of the same sentence drifting apart.
 *
 * Split in two on purpose. The database read stays at the call sites, which
 * already hold a Prisma client and a user id; the FORMAT is pure, so a test can
 * assert what the agent actually receives without a database. That is the
 * pattern src/lib/work/domain.ts and src/lib/gemini-finish.ts set.
 */

/** The attachment columns the fold reads, and nothing else. */
export interface AttachmentFacts {
  fileName: string;
  /** `Attachment.kind` — only "IMAGE" changes the sentence. */
  kind: string;
  mimeType: string;
  extractedText: string | null;
}

/**
 * The per-attachment ceiling on extracted text.
 *
 * A single PDF can extract to megabytes, and the whole prompt is stored on the
 * task row, sent to the runner and replayed into the model's context on every
 * turn. 100 KB is what the create route has always used; it is stated here so
 * both call sites cannot disagree about it.
 */
export const MAX_ATTACHMENT_EXTRACT_CHARS = 100_000;

/**
 * Fold claimed attachments into an agent-facing prompt.
 *
 * Empty input returns the prompt untouched — including the empty string, which
 * a caller with neither text nor attachments must handle itself rather than
 * receive a fabricated sentence for. With attachments but no prompt the result
 * is the blocks alone, because "See attached files." followed by the files is
 * one instruction, not two.
 */
export function foldAttachmentsIntoPrompt(prompt: string, attachments: readonly AttachmentFacts[]): string {
  if (attachments.length === 0) return prompt;
  const blocks = attachments.map((att) => {
    if (att.extractedText?.trim()) {
      return `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, MAX_ATTACHMENT_EXTRACT_CHARS)}`;
    }
    if (att.kind === "IMAGE") {
      return `Attached image: ${att.fileName} (${att.mimeType}). The user shared this image with the task for visual reference.`;
    }
    return `Attached file: ${att.fileName} (${att.mimeType}).`;
  });
  const joined = blocks.join("\n\n");
  return prompt ? `${prompt}\n\n---\n${joined}` : joined;
}
