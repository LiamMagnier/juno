import { PRODUCT_NAME } from "@/lib/brand/names";
import { isLiveUIFence } from "@/lib/live-ui/fence";
import { isLegacyVisualFence } from "@/lib/live-ui/legacy/convert";
import { parseArtifacts, splitMessageContent } from "@/lib/message-content";
import { parseQuotedMessage } from "@/lib/quote-context";
import { stripTrailingSourcesSection } from "@/components/chat/sources-section";

/*
 * A conversation as a reader takes it away (spec §6.15): Copy as Markdown,
 * Download Markdown, and Print / Save as PDF (conversation-print.tsx).
 *
 * WHAT THE TRANSCRIPT SHOWS, AND NOTHING IT HIDES. Each turn is built from the
 * same steps the transcript renders it with (message-item.tsx): memory and
 * forget tags stripped, the clarification block dropped, an artifact reduced to
 * its card's title, the research report's trailing "Sources" list replaced by
 * the sources the answer actually carries, a quoted selection shown as a quote.
 * What the transcript keeps folded or never shows is left out on purpose:
 * reasoning, tool calls and their arguments, approvals, memory receipts, the
 * route, the model id, tokens and cost, error details, and the addresses of
 * uploaded or generated files (private, signed links), of which only the names
 * appear. HTML comments (the research report's section markers) go, as they do
 * in the transcript, except inside code.
 *
 * Pure, so tests/chat-polish.test.ts can pin exactly what an export contains.
 */

/** The parts of a transcript message an export reads. */
export interface ExportMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  attachments?: readonly { fileName: string }[];
  sources?: readonly { title: string; url: string }[];
  /** The turn failed; its content is the error text, which the export does not copy. */
  error?: boolean;
  /** Still being written when the export was taken. */
  streaming?: boolean;
}

export interface ConversationExportInput {
  title: string;
  messages: readonly ExportMessage[];
  /** Who answers: the product, or the agent whose thread this is. */
  assistantName?: string;
  exportedAt: Date;
  /** The artifact's current title, when the chat has it (the card shows that one). */
  artifactTitle?: (identifier: string) => string | null | undefined;
}

/** One turn, ready to print or to write as Markdown. */
export interface ExportTurn {
  id: string;
  speaker: "you" | "assistant";
  label: string;
  /** A passage the person quoted with this turn, shown above their words. */
  quote: string | null;
  /** The turn's words: plain text for the person, Markdown for the answer. */
  body: string;
  /** Names only. */
  files: string[];
  sources: { title: string; url: string }[];
  /** One line about the turn's state ("still being written", "did not finish"). */
  note: string | null;
}

/** Exported copy, named so the i18n catalog generator picks each sentence up whole. */
export const CONVERSATION_EXPORT_COPY = {
  you: "You",
  untitled: "Chat",
  interactive: "Interactive view: open this chat to use it.",
  failed: "This reply did not finish.",
  streaming: "Still being written when this was exported.",
  noAnswer: "No answer.",
  filesLabel: "Files",
  sourcesLabel: "Sources",
  artifactNote: "not included in this export",
} as const;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** HTML comments out, repeated until none is left, so `<!<!---->--` cannot leave one behind. */
function withoutComments(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  } while (text !== previous);
  return text;
}

/**
 * Drops what the transcript never renders from a run of Markdown, fence-aware:
 * HTML comments outside code, and a Live UI fence (an interactive view the
 * page draws from its spec) becomes one line saying where to use it.
 */
export function exportableMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length) out.push(withoutComments(prose.join("\n")));
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    flushProse();
    const marker = open[1];
    const lang = open[2] ?? "";
    let end = i + 1;
    const closes = (line: string) => {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      return !!close && close[1][0] === marker[0] && close[1].length >= marker.length;
    };
    while (end < lines.length && !closes(lines[end])) end++;
    const block = lines.slice(i, Math.min(end + 1, lines.length));
    out.push(isLiveUIFence(lang) || isLegacyVisualFence(lang) ? `_${CONVERSATION_EXPORT_COPY.interactive}_` : block.join("\n"));
    i = end;
  }
  flushProse();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Only links a reader can follow, never a script or a data blob. */
function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function assistantBody(message: ExportMessage, artifactTitle: ConversationExportInput["artifactTitle"]): string {
  const raw = message.sources?.length ? stripTrailingSourcesSection(message.content) : message.content;
  const titles = new Map(parseArtifacts(message.content).map((artifact) => [artifact.identifier, artifact.title]));
  const pieces: string[] = [];
  for (const part of splitMessageContent(raw)) {
    if (part.type === "text") {
      const text = exportableMarkdown(part.text);
      if (text) pieces.push(text);
    } else {
      const title = (part.identifier && artifactTitle?.(part.identifier)) || titles.get(part.identifier) || part.title || "Artifact";
      pieces.push(`_Artifact: “${title}” (${CONVERSATION_EXPORT_COPY.artifactNote})_`);
    }
  }
  return pieces.join("\n\n");
}

/** The conversation as turns, in transcript order. System rows are never shown, so never exported. */
export function conversationExportTurns(input: ConversationExportInput): ExportTurn[] {
  const assistantName = input.assistantName?.trim() || PRODUCT_NAME;
  const turns: ExportTurn[] = [];
  for (const message of input.messages) {
    if (message.role === "SYSTEM") continue;
    const files = (message.attachments ?? []).map((file) => file.fileName.trim()).filter(Boolean);
    if (message.role === "USER") {
      const quoted = parseQuotedMessage(message.content);
      const body = (quoted ? quoted.request : message.content).trim();
      if (!body && !quoted && files.length === 0) continue;
      turns.push({ id: message.id, speaker: "you", label: CONVERSATION_EXPORT_COPY.you, quote: quoted ? quoted.text.trim() : null, body, files, sources: [], note: null });
      continue;
    }
    const body = message.error ? "" : assistantBody(message, input.artifactTitle);
    const sources = (message.sources ?? [])
      .map((source) => ({ title: source.title.trim() || source.url, url: webUrl(source.url) }))
      .filter((source): source is { title: string; url: string } => source.url !== null);
    const note = message.error
      ? CONVERSATION_EXPORT_COPY.failed
      : message.streaming
        ? CONVERSATION_EXPORT_COPY.streaming
        : !body && files.length === 0
          ? CONVERSATION_EXPORT_COPY.noAnswer
          : null;
    turns.push({ id: message.id, speaker: "assistant", label: assistantName, quote: null, body, files, sources, note });
  }
  return turns;
}

function isoDay(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "1970-01-01";
}

/** A title on one line, as a Markdown heading can hold it. */
function headingText(title: string): string {
  return title.replace(/\s+/g, " ").trim() || CONVERSATION_EXPORT_COPY.untitled;
}

/** The Markdown file: the title, when, then each turn under its speaker. */
export function conversationMarkdown(input: ConversationExportInput): string {
  const turns = conversationExportTurns(input);
  const lines: string[] = [`# ${headingText(input.title)}`, "", `_${PRODUCT_NAME} · ${isoDay(input.exportedAt)}_`];
  for (const turn of turns) {
    lines.push("", "---", "", `**${turn.label}:**`, "");
    if (turn.quote) {
      lines.push(...turn.quote.split("\n").map((line) => (line ? `> ${line}` : ">")), "");
    }
    if (turn.body) lines.push(turn.body, "");
    if (turn.files.length) lines.push(`_${CONVERSATION_EXPORT_COPY.filesLabel}: ${turn.files.join(", ")}_`, "");
    if (turn.sources.length) {
      lines.push(`${CONVERSATION_EXPORT_COPY.sourcesLabel}:`, "");
      turn.sources.forEach((source, index) => {
        lines.push(`${index + 1}. [${source.title.replace(/[[\]]/g, "")}](${source.url})`);
      });
      lines.push("");
    }
    if (turn.note) lines.push(`_${turn.note}_`, "");
    while (lines[lines.length - 1] === "") lines.pop();
  }
  return `${lines.join("\n").trim()}\n`;
}

const SLUG_MAX = 80;

/**
 * The download's name: the title as a slug (the research report's rule), or
 * `chat-{yyyy-mm-dd}` when nothing of the title survives.
 */
export function conversationExportFileName(title: string, exportedAt: Date): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return `chat-${isoDay(exportedAt)}.md`;
  if (slug.length <= SLUG_MAX) return `${slug}.md`;
  const cut = slug.slice(0, SLUG_MAX);
  const boundary = cut.lastIndexOf("-");
  return `${(boundary > SLUG_MAX / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "")}.md`;
}
