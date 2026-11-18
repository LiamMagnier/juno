/*
 * HOW FULL A PROJECT'S KNOWLEDGE IS.
 *
 * A project's files reach its chats two ways (lib/chat/turn/project-context.ts):
 * an indexed document is searched and only the passages a question needs are
 * sent, and a file that is not indexed is sent whole. Either way the amount a
 * project holds is measured in the unit the model reads, tokens, and the page
 * says it as a share of one fixed capacity, the way Claude's project page does.
 *
 * The count is the index's own where the file is indexed (KnowledgeDocument's
 * tokenCount), and an estimate from its size where it is not yet: about four
 * bytes a token for plain text, more for formats whose bytes are mostly
 * markup and compression. Pictures, audio and video are not read as text and
 * count nothing. The estimate errs high, so the meter fills a little early
 * rather than late.
 *
 * The capacity is enforced where files arrive in bulk, a Drive folder's sync
 * (drive-source.ts), which stops adding files when it is reached and says so.
 */

export const PROJECT_KNOWLEDGE_CAPACITY_TOKENS = 1_000_000;

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|typescript|x-sh|sql))/;
const MEDIA_TYPES = /^(image|audio|video)\//;

/** Tokens a file of this size and type is likely to hold, when the index has not counted it. */
export function estimateKnowledgeTokens(file: { size: number; mimeType: string; tokenCount?: number | null }): number {
  if (typeof file.tokenCount === "number" && file.tokenCount > 0) return file.tokenCount;
  const size = Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
  const mime = (file.mimeType || "").toLowerCase();
  if (MEDIA_TYPES.test(mime)) return 0;
  if (TEXT_TYPES.test(mime)) return Math.ceil(size / 4);
  // PDFs and Office files: compressed, with fonts and images inside. A tenth
  // of the bytes as tokens is generous for text-heavy documents.
  return Math.ceil(size / 10);
}

export interface KnowledgeUsage {
  usedTokens: number;
  capacityTokens: number;
  /** 0–1, capped at 1. */
  fraction: number;
  /** Whole percent for the meter's width, 0–100. */
  percent: number;
  /** "4% of project capacity used", "Less than 1% …", "Project knowledge is full". */
  label: string;
  /** Nine tenths or more: the meter turns to the attention tone. */
  nearlyFull: boolean;
  full: boolean;
}

export function knowledgeUsage(
  files: ReadonlyArray<{ size: number; mimeType: string; tokenCount?: number | null }>,
  capacityTokens = PROJECT_KNOWLEDGE_CAPACITY_TOKENS,
): KnowledgeUsage {
  const usedTokens = files.reduce((sum, file) => sum + estimateKnowledgeTokens(file), 0);
  const raw = capacityTokens > 0 ? usedTokens / capacityTokens : 1;
  const fraction = Math.min(1, Math.max(0, raw));
  const full = raw >= 1;
  const percent = full ? 100 : Math.min(99, Math.round(fraction * 100));
  const label = full
    ? "Project knowledge is full"
    : usedTokens === 0
      ? "No knowledge added yet"
      : percent < 1
        ? "Less than 1% of project capacity used"
        : `${percent}% of project capacity used`;
  return { usedTokens, capacityTokens, fraction, percent: usedTokens > 0 && percent === 0 ? 1 : percent, label, nearlyFull: fraction >= 0.9, full };
}
