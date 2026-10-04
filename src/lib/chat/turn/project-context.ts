import "server-only";
import { loadBackgroundProviderPolicy } from "@/lib/memory";
import { decryptJsonField } from "@/lib/field-crypto";
import type { ModelInfo } from "@/lib/models";
import { historyCarriesToolNotes, withHistoryNote } from "@/lib/chat/history-notes";
import {
  buildAttachmentContext,
  buildProjectContext,
  buildProjectReferenceFiles,
  prependToFirstUserTurn,
  type AttachmentKnowledge,
  type ProjectKnowledge,
} from "@/lib/chat/context-assembly";
import { isCodeInterpreterConfigured } from "@/lib/agent/code";
import { ensureAttachmentText } from "@/lib/knowledge";
import { isPdfAttachment, providerReceivesDocumentBytes } from "@/lib/attachment-bytes";
import { retrieveAttachmentKnowledge, retrieveProjectKnowledge } from "@/lib/knowledge/retrieve";
import type { WorkspaceConfig } from "@/lib/projects/workspace-config";
import { loadProjectLineage } from "@/lib/projects/project-tree-server";
import { isAttachmentParserPending, isAttachmentParserUnavailable } from "@/lib/attachment-context";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { ContextPort, TurnContext } from "@/lib/chat/context-resolution";
import type { TurnSettings } from "./account";
import type { TurnHistory } from "./history";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — resolveProjectContext: the project (and folder lineage)
 * instructions and knowledge, a conversation's directly attached files, the
 * attachment tools those files warrant, earlier tool-call notes, and phase two
 * of context tokens. Everything the model reads besides the system prompt's
 * fixed sections and memory.
 */
export async function resolveProjectContext({
  user,
  input,
  settings,
  modelInfo,
  workspaceConfig,
  selectedKnowledgeFileIds,
  conversation,
  turnHistory: { recent, history, baseHistory },
  turnContext,
  contextPort,
  userMessageId,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  settings: TurnSettings;
  modelInfo: ModelInfo;
  workspaceConfig: WorkspaceConfig;
  selectedKnowledgeFileIds: string[] | undefined;
  conversation: { id: string; userId: string; projectId: string | null; agentId: string | null };
  turnHistory: TurnHistory;
  turnContext: TurnContext;
  contextPort: ContextPort;
  userMessageId: string | null;
}) {
  // Project context: instructions + reference file contents injected into the system prompt.
  //
  // Reference files go in wholesale, which is correct while a project holds a
  // handful of them and stops being correct the moment it holds a library. So
  // where a project's documents have been indexed (lib/knowledge), the relevant
  // extracts are retrieved for THIS question and the wholesale dump of those
  // files is dropped — the prompt then grows with the question rather than with
  // the library, and every extract carries the page it came from.
  //
  // The boundary is deliberately narrow. `retrieveProjectKnowledge` returns
  // null after one indexed lookup when the project has nothing indexed, and
  // `buildProjectContext` called without a knowledge argument is byte-identical
  // to what it produced before any of this existed. Retrieval failing, or the
  // background-provider policy permitting no embedding provider, both degrade
  // to that same prior behaviour rather than to a dead turn.
  // Scoped to the conversation's owner, who is the requester (the
  // conversation was loaded with `userId: user.id`). A conversation can only be
  // filed into a project its owner owns, so this finds the same row it always
  // did; unscoped, the ownership guard refused it and every turn in a project
  // chat failed before it started.
  //
  // Folders: a chat in a subfolder inherits every ancestor's instructions and
  // files, root first, then the folder's own (mergeInheritedProjectContext in
  // lib/projects/project-tree.ts). `projectLineage` is that chain; a project
  // with no parent is a lineage of one and merges to exactly its own row, so
  // nothing changes for a project that is not inside a folder.
  const projectLineage = conversation.projectId
    ? await loadProjectLineage(conversation.userId, conversation.projectId)
    : null;
  const projectRow = projectLineage?.merged ?? null;
  const assistantProjectRow = projectRow
    ? {
        ...projectRow,
        name: workspaceConfig.personaName ?? projectRow.name,
        instructions: workspaceConfig.instructionsOverride ?? projectRow.instructions,
        files: selectedKnowledgeFileIds === undefined
          ? projectRow.files
          : projectRow.files.filter((file) => selectedKnowledgeFileIds.includes(file.id)),
      }
    : null;
  const knowledgeQuery =
    [...baseHistory].reverse().find((m) => m.role === "USER")?.content ?? input.message?.trim() ?? "";
  let projectKnowledge: ProjectKnowledge | null = null;
  if (conversation.projectId && projectRow) {
    if (knowledgeQuery) {
      try {
        const retrievalOptions = {
          userId: user.id,
          query: knowledgeQuery,
          policy: await loadBackgroundProviderPolicy(user.id, settings),
          // Embedding the question is background work on the user's content, so
          // it answers to the same provider policy as everything else — and
          // `same_provider` means the provider they picked for this turn.
          conversationProvider: modelInfo.provider,
        };
        // Inside a folder the documents span the lineage, so they are
        // retrieved by attachment (every inherited file's id) rather than by
        // the one project id, which would miss the ancestors' indexed files.
        const inheritedFileIds =
          selectedKnowledgeFileIds === undefined && (projectLineage?.depth ?? 1) > 1
            ? projectRow.files.map((file) => file.id)
            : undefined;
        const retrieved = inheritedFileIds
          ? await retrieveAttachmentKnowledge({
              ...retrievalOptions,
              attachmentIds: inheritedFileIds,
            })
          : selectedKnowledgeFileIds === undefined
          ? await retrieveProjectKnowledge({
              ...retrievalOptions,
              projectId: conversation.projectId,
            })
          : await retrieveAttachmentKnowledge({
              ...retrievalOptions,
              attachmentIds: selectedKnowledgeFileIds,
            });
        if (retrieved && retrieved.passages.length > 0) {
          projectKnowledge = {
            passages: retrieved.passages,
            indexedFileNames: retrieved.indexedFileNames,
            degraded: retrieved.mode === "lexical",
          };
        }
      } catch (error) {
        console.error("[chat] project knowledge retrieval failed", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const projectContext = buildProjectContext(assistantProjectRow, projectKnowledge);

  // A file attached directly to a conversation may have no project at all.
  // Retrieve its indexed passages by the durable attachment → document join so
  // provider choice no longer decides whether a PDF can be understood. Files
  // still in the parser queue are named explicitly below; a filename-only
  // placeholder is not an honest answer to a user who just uploaded a file.
  /*
   * Whether this model is handed the document itself rather than its text.
   *
   * Declared HERE, above its first use, and not beside the reading below: it
   * is captured by `needsTextToBeRead` a few lines down, which is CALLED
   * before the later declaration would have been evaluated. TypeScript does
   * not see through the closure, so that ordering typechecked cleanly and
   * threw `Cannot access 'modelSeesDocument' before initialization` at
   * runtime on every turn carrying an attachment.
   */
  const modelSeesDocument = providerReceivesDocumentBytes(modelInfo, !!input.proMode);
  const directAttachments = baseHistory
    .flatMap((message) => message.attachments)
    .filter((attachment) => attachment.projectId == null && !attachment.deletedAt);
  let attachmentKnowledge: AttachmentKnowledge | null = null;
  if (directAttachments.length > 0 && knowledgeQuery) {
    try {
      const retrieved = await retrieveAttachmentKnowledge({
        userId: user.id,
        attachmentIds: directAttachments.map((attachment) => attachment.id),
        query: knowledgeQuery,
        policy: await loadBackgroundProviderPolicy(user.id, settings),
        conversationProvider: modelInfo.provider,
      });
      /*
       * A file whose BYTES this model receives is never listed as unreadable.
       *
       * Both notes below instruct the model not to describe the file's
       * contents. On Claude, Gemini and the Responses API the adapter has
       * inlined the PDF itself — pages and all — so that instruction lands on
       * a model that is looking straight at the document, and the user is told
       * "I cannot read this" about something the model can read perfectly.
       * That is the best case in the product being reported as the worst.
       */
      const needsTextToBeRead = (attachment: (typeof directAttachments)[number]) =>
        !(modelSeesDocument && isPdfAttachment(attachment));
      const pendingFiles = directAttachments
        .filter((attachment) => isAttachmentParserPending(attachment.parserState) && needsTextToBeRead(attachment))
        .map((attachment) => ({ fileName: attachment.fileName, state: attachment.parserState }));
      const unavailableFiles = directAttachments
        .filter((attachment) => isAttachmentParserUnavailable(attachment.parserState) && needsTextToBeRead(attachment))
        .map((attachment) => ({ fileName: attachment.fileName, state: attachment.parserState }));
      if (retrieved || pendingFiles.length > 0 || unavailableFiles.length > 0) {
        attachmentKnowledge = {
          passages: retrieved?.passages ?? [],
          indexedFileNames: retrieved?.indexedFileNames ?? [],
          degraded: retrieved?.mode === "lexical",
          pendingFiles,
          unavailableFiles,
        };
      }
    } catch (error) {
      console.error("[chat] attachment knowledge retrieval failed", {
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const attachmentContext = buildAttachmentContext(attachmentKnowledge);
  const promptContext = [projectContext, attachmentContext].filter(Boolean).join("\n\n");

  /*
   * Every file this conversation is carrying — not just the newest message's.
   *
   * "What did page 40 of that report say" arrives three turns after the report
   * did, so both the backfill and the tool allowlist below have to see the
   * whole window; a tool that vanished the moment a file scrolled out of the
   * newest turn would be missing exactly when it is asked for.
   */
  const allAttachments = baseHistory
    .flatMap((message) => message.attachments)
    .filter((attachment) => !attachment.deletedAt);

  /*
   * READ THE FILES, NOW THAT THERE IS A QUESTION TO READ THEM FOR.
   *
   * Uploads store bytes and nothing else, so this is the first moment anything
   * opens an attached document — and unlike the old upload-time pass, it knows
   * which model is about to receive it. A provider that takes the raw PDF and
   * rasterises it internally is handed the file itself and skipped here
   * entirely: extracting for it would produce a worse copy of what it is
   * already getting, at the cost of doing the work twice.
   */
  await ensureAttachmentText(allAttachments, {
    userId: conversation.userId,
    skip: (attachment) => modelSeesDocument && isPdfAttachment(attachment),
  });

  /*
   * Whether this turn is carrying anything for the two attachment tools.
   *
   * `documents` insists the file is actually indexed. A queued PDF has nothing
   * for the reader to read, and offering the tool anyway buys a round trip
   * whose only possible answer is "not yet" — the pending note that
   * `buildAttachmentContext` already wrote says that better and for free.
   *
   * `images` insists the model can see. A crop handed to a text-only model is
   * a tool call it must then be told to ignore.
   */
  const attachmentToolToggles = {
    /*
     * ANY attached file, not only an indexed one — and the change matters most
     * for the files that look least promising. `read_document` now falls back
     * to reading the bytes when the index has nothing (see
     * `knowledge/read-on-demand.ts`), so a PDF the indexer marked `failed` is
     * exactly the document the tool exists to rescue. Gating on `ready` meant
     * the rescue was withheld from every file that needed rescuing.
     */
    documents: allAttachments.some((attachment) => attachment.kind === "FILE"),
    /*
     * Python against the file, when there is a sandbox to run it in. Gated on
     * a file being present for the same reason the other two are: a tool with
     * nothing to act on spends a round finding that out.
     */
    code: isCodeInterpreterConfigured() && allAttachments.length > 0,
    images:
      modelInfo.vision &&
      allAttachments.some(
        (attachment) => attachment.kind === "IMAGE" || attachment.mimeType === "application/pdf",
      ),
  };

  // Wholesale reference files ride the first user turn, each in its untrusted
  // envelope, instead of the system prompt — see buildProjectReferenceFiles.
  const projectReferenceFiles = buildProjectReferenceFiles(assistantProjectRow, projectKnowledge);
  /*
   * Earlier tool-using answers carry a note of what their calls did
   * (src/lib/chat/history-notes.ts), so "now plot it by month" can build on
   * the run that made the numbers. From each row's own persisted activity
   * only, so the cached prompt prefix is stable; enveloped, so the
   * untrusted-content rule below turns on with it.
   */
  const toolNoteActivity = new Map<string, unknown[]>();
  for (const message of recent) {
    if (message.role !== "ASSISTANT" || !message.activity) continue;
    try {
      const activity = decryptJsonField(message.activity);
      if (Array.isArray(activity)) toolNoteActivity.set(message.id, activity);
    } catch {
      // An unreadable log costs that row its note, never the turn.
    }
  }
  const historyHasToolNotes = historyCarriesToolNotes(
    baseHistory.map((message) => ({ role: message.role, activity: toolNoteActivity.get(message.id) })),
  );
  const modelHistory = prependToFirstUserTurn(baseHistory, projectReferenceFiles).map((message) =>
    message.role === "ASSISTANT" && toolNoteActivity.has(message.id)
      ? { ...message, content: withHistoryNote(message.content, toolNoteActivity.get(message.id)) }
      : message,
  );

  /*
   * ── Context tokens, phase two ─────────────────────────────────────────────
   *
   * The projects, chats, artifacts and crew members a message named are prompt
   * context: read now that the conversation and the person's words for this
   * turn exist, and put after the latest user turn for this generation only
   * (`turnHistory`, below). Ranges are fitted to the user message as stored,
   * which a regenerate reads back rather than receives.
   */
  if (!turnContext.empty) {
    const storedUserText =
      (userMessageId
        ? history.find((message) => message.id === userMessageId)
        : [...history].reverse().find((message) => message.role === "USER")
      )?.content ?? "";
    turnContext.fitRanges(storedUserText);
    await turnContext.resolveReferences(
      {
        conversationId: conversation.id,
        conversationProjectId: conversation.projectId,
        threadAgentId: conversation.agentId,
        query: knowledgeQuery,
      },
      contextPort
    );
  }
  // Attachment text is rendered by every adapter inside the same envelope
  // (attachedFileText); the rule that reads the envelope has to be on for it.
  const historyCarriesAttachmentText = modelHistory.some((message) =>
    message.attachments.some((attachment) => !!attachment.extractedText)
  );

  return {
    projectKnowledge,
    projectContext,
    attachmentKnowledge,
    attachmentContext,
    promptContext,
    allAttachments,
    attachmentToolToggles,
    projectReferenceFiles,
    historyHasToolNotes,
    modelHistory,
    historyCarriesAttachmentText,
    knowledgeQuery,
  };
}

export type TurnProjectContext = Awaited<ReturnType<typeof resolveProjectContext>>;
