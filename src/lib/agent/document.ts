import crypto from "node:crypto";
import type { AgentExecutionContext, ToolDefinition, ToolExecutionResult } from "@/lib/agent/types";
import { matchAttachment, nameList } from "@/lib/agent/attachment-match";
import type { DocumentSummary } from "@/lib/knowledge/documents";
import { wrapUntrusted } from "@/lib/untrusted-content";

/*
 * NO `server-only` AND NO STATIC PRISMA IMPORT, deliberately.
 *
 * The agent registry constructs every tool at module load, so anything in
 * this file's static graph is in the registry's. `server-only` throws outside
 * a `react-server` runtime, which would take the whole registry — and the
 * tests that read it — down with it. The database and storage layers are
 * therefore reached through `await import()` inside `execute`, which is where
 * a server runtime is guaranteed to exist. `browser.ts` is arranged the same
 * way, and `runtime.ts` loads the approval broker the same way.
 */

/**
 * Juno Document Reader — the model's own hands on an attached file.
 *
 * WHAT WAS MISSING. An attached document reached a model exactly once, as
 * whatever text the prompt builder decided to include, and that was the end of
 * it. If the document was longer than the budget, the model got a prefix; if
 * the answer was on page 180, the model could not go and look. It had one shot
 * at a fixed excerpt and no way to say "show me the section on indemnities".
 * The other assistants do not work that way — they give the model a way to
 * page through a file and to search inside it, which is the difference between
 * being handed a photocopy and being handed the book.
 *
 * This is that: `list` (what is here and how long), `outline` (its headings,
 * so a long file can be navigated before it is read), `read` (a page range, in
 * order, with its markers) and `search` (where a string appears, with page
 * numbers). It reads the blocks structured extraction already produced, so it
 * costs a query rather than a re-parse, and every locator it returns is one a
 * person can check.
 *
 * READ-ONLY, CONVERSATION-SCOPED, ENVELOPED. It cannot reach a file the person
 * has not attached here (`conversationAttachments`), it cannot write anything,
 * and everything it returns goes back inside the untrusted-content envelope —
 * a document is text Juno did not author and the user did not type, and a PDF
 * carries "ignore your previous instructions" as easily as a web page does.
 */

export interface ReadDocumentParams {
  action: "list" | "outline" | "read" | "search";
  /** File name or attachment id. Optional when there is only one document. */
  file?: string;
  fromPage?: number;
  toPage?: number;
  offset?: number;
  query?: string;
  reason?: string;
}

/** One read's ceiling. Generous — the point is not to ration the document. */
const READ_MAX_CHARS = 60_000;

function describeDocument(document: DocumentSummary): string {
  const pages =
    document.pageCount != null
      ? `${document.pageCount} page${document.pageCount === 1 ? "" : "s"}`
      : `${document.blockCount} section${document.blockCount === 1 ? "" : "s"}`;
  const partial = document.state === "degraded" ? ", partially readable" : "";
  return `- "${document.fileName}" (${document.mimeType}, ${pages}${partial})`;
}

async function availableDocuments(
  context: AgentExecutionContext,
): Promise<{ documents: DocumentSummary[]; nothingAttached: boolean }> {
  const { conversationAttachments } = await import("@/lib/agent/attachments");
  const { documentsForAttachments } = await import("@/lib/knowledge/documents");
  const attachments = await conversationAttachments({
    userId: context.userId,
    conversationId: context.conversationId,
    projectId: context.projectId,
    kind: "FILE",
  });
  if (attachments.length === 0) return { documents: [], nothingAttached: true };
  const documents = await documentsForAttachments(
    context.userId,
    attachments.map((attachment) => attachment.id),
  );
  // Ordered as the files were attached, not as the documents were created:
  // "the second one" means the second thing the person sent.
  const rank = new Map(attachments.map((attachment, index) => [attachment.id, index]));
  documents.sort((a, b) => (rank.get(a.attachmentId ?? "") ?? 0) - (rank.get(b.attachmentId ?? "") ?? 0));
  return { documents, nothingAttached: false };
}

function failure(message: string): ToolExecutionResult<never> {
  return { success: false, error: message, summary: message, stdout: message };
}

export const readDocumentTool: ToolDefinition<ReadDocumentParams, unknown> = {
  id: "read_document",
  name: "Read document",
  category: "filesystem",
  description:
    "Read the documents attached to this conversation. Use action 'list' to see what is attached and how long each file is, 'outline' to see a long document's headings before choosing where to read, 'read' to read a file (optionally a page range, in order) and 'search' to find where a word, figure or identifier appears in one. Prefer this over guessing whenever an attached file is longer than the excerpt you were given, when you need a specific page, or when you are about to say a document does not mention something.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "outline", "read", "search"],
        description:
          "list = what is attached; outline = its headings; read = read the text; search = find a string in it.",
      },
      file: {
        type: "string",
        description:
          "Which file, by name as it appears in the conversation. Optional when only one document is attached.",
      },
      fromPage: {
        type: "number",
        description: "First page to read (1-based). Omit to start at the beginning.",
      },
      toPage: {
        type: "number",
        description: "Last page to read, inclusive. Omit to read to the end or to the size limit.",
      },
      offset: {
        type: "number",
        description:
          "Skip this many sections before reading. Use it to continue a read that stopped at the size limit.",
      },
      query: {
        type: "string",
        description: "For action 'search': the exact word, number or phrase to find.",
      },
      reason: {
        type: "string",
        description: "What you are looking for, in a few words.",
      },
    },
    required: ["action"],
  },
  riskClass: "read_only",
  formatPreview: (params) => ({
    title: params.action === "search" ? "Search document" : "Read document",
    detail: [params.file, params.query, params.reason].filter(Boolean).join(" — ") || "Attached files",
    sensitive: false,
  }),
  execute: async (params, context): Promise<ToolExecutionResult<unknown>> => {
    const emit = async (title: string, detail: string, status: "running" | "completed" | "failed") => {
      if (!context.onEvent) return;
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "reading_file",
        timestamp: Date.now(),
        title,
        detail,
        status,
        source: "read_document",
      });
    };

    const { documents, nothingAttached } = await availableDocuments(context);
    if (nothingAttached) {
      return failure("No files are attached to this conversation, so there is nothing to read.");
    }
    if (documents.length === 0) {
      return failure(
        "Files are attached but none of them has been indexed yet — either indexing is still running or no text could be extracted. Say so rather than describing their contents.",
      );
    }

    if (params.action === "list") {
      const body = `Documents attached to this conversation:\n${documents.map(describeDocument).join("\n")}`;
      await emit("Listed attached documents", `${documents.length} file(s)`, "completed");
      return {
        success: true,
        summary: `${documents.length} document(s) attached.`,
        // A list of the user's own file names is metadata Juno produced, not
        // document content, so it does not carry the envelope: wrapping it
        // would train the model to distrust its own tool's index.
        stdout: body,
      };
    }

    const { match, ambiguous } = matchAttachment(
      documents.map((document) => ({ ...document, id: document.attachmentId ?? document.documentId })),
      params.file,
    );
    if (!match) {
      return failure(
        ambiguous.length > 1
          ? `"${params.file ?? ""}" matches more than one attached file (${nameList(ambiguous)}). Ask which one, or name it exactly.`
          : `No attached file matches "${params.file ?? ""}". Attached: ${nameList(documents)}.`,
      );
    }
    const document = documents.find((candidate) => candidate.documentId === match.documentId)!;

    const { readDocumentOutline, readDocumentText, searchDocument } = await import(
      "@/lib/knowledge/documents"
    );

    if (params.action === "outline") {
      const outline = await readDocumentOutline(context.userId, document.documentId);
      await emit("Read document outline", document.fileName, "completed");
      if (outline.length === 0) {
        return {
          success: true,
          summary: `${document.fileName} has no headings.`,
          // A document with no headings is not a broken one — plain prose, a
          // scan, a CSV. Saying which it is stops the model reporting an empty
          // outline as a missing document.
          stdout: `"${document.fileName}" has no headings to outline (it may be plain prose, a scan or a table). Read it with action 'read'.`,
        };
      }
      return {
        success: true,
        summary: `${outline.length} heading(s) in ${document.fileName}.`,
        stdout: wrapUntrusted(
          document.fileName,
          `Headings in "${document.fileName}", in order:\n${outline.map((line) => `- ${line}`).join("\n")}`,
        ),
      };
    }

    if (params.action === "search") {
      const query = (params.query ?? "").trim();
      if (!query) return failure("action 'search' needs a query.");
      const matches = await searchDocument(context.userId, document.documentId, query, 20);
      await emit("Searched document", `"${query}" in ${document.fileName}`, "completed");
      if (matches.length === 0) {
        return {
          success: true,
          summary: `No match for "${query}" in ${document.fileName}.`,
          // Stated as a fact about the index, not about the world: a scanned
          // page that OCR read poorly can hide a string that is really there.
          stdout: `No section of "${document.fileName}" contains "${query}". The document is indexed, so this is evidence of absence — but a scanned or low-quality page may not have been read perfectly.`,
        };
      }
      const rendered = matches
        .map((hit) => {
          const locator =
            typeof hit.page === "number"
              ? `page ${hit.page}`
              : typeof hit.slide === "number"
                ? `slide ${hit.slide}`
                : hit.sheet
                  ? `sheet ${hit.sheet}`
                  : `section ${hit.ordinal + 1}`;
          return `[${locator}] ${hit.text.trim().slice(0, 1_200)}`;
        })
        .join("\n\n");
      return {
        success: true,
        summary: `${matches.length} match(es) for "${query}" in ${document.fileName}.`,
        stdout: wrapUntrusted(
          document.fileName,
          `${matches.length} match(es) for "${query}" in "${document.fileName}":\n\n${rendered}`,
        ),
      };
    }

    const assembled = await readDocumentText(context.userId, document.documentId, {
      maxChars: READ_MAX_CHARS,
      window: {
        fromPage: params.fromPage ?? null,
        toPage: params.toPage ?? null,
        offset: Math.max(0, Math.floor(params.offset ?? 0)),
      },
    });
    if (!assembled?.text) {
      return failure(
        `"${document.fileName}" has no readable text in that range. Try a different page range, or action 'list' to see how long it is.`,
      );
    }

    // Where the read stopped, so the next call can continue rather than
    // starting over — the thing a paginated reader has to say and the reason
    // `offset` exists as a parameter at all.
    const continuation = assembled.truncated
      ? `\n\n[This read stopped at the size limit after ${assembled.blocksIncluded} of ${assembled.blocksTotal} sections in the requested range. Call read_document again with offset=${(params.offset ?? 0) + assembled.blocksIncluded} to continue.]`
      : "";
    const range =
      params.fromPage || params.toPage
        ? ` (pages ${params.fromPage ?? 1}–${params.toPage ?? "end"})`
        : "";

    await emit(
      "Read document",
      `${document.fileName}${range} — ${assembled.text.length} characters`,
      "completed",
    );
    return {
      success: true,
      summary: `Read ${assembled.text.length} characters of ${document.fileName}${range}.`,
      stdout: wrapUntrusted(
        document.fileName,
        `"${document.fileName}"${range}:\n\n${assembled.text}${continuation}`,
      ),
    };
  },
};

/** Registry id, so the allowlist and the registration cannot drift apart. */
export const READ_DOCUMENT_TOOL_ID = readDocumentTool.id;
