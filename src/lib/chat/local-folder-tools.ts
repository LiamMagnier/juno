import { randomUUID } from "node:crypto";
import type { NativeChatTool } from "@/lib/tools/types";
import type { StreamChunk } from "@/types/chat";
import { wrapUntrusted } from "@/lib/untrusted-content";
import {
  LOCAL_FOLDER_CALL_TIMEOUT_MS,
  LOCAL_FOLDER_CANONICAL_TOOL,
  LOCAL_FOLDER_TOOLS,
  checkLocalFolderArgs,
  localFolderPresent,
  localFolderToolAccess,
  localFolderToolsFor,
  type LocalFolderGrant,
  type LocalFolderToolId,
} from "@/lib/chat/local-folder";
import { awaitLocalToolResult, type LocalToolResult } from "@/lib/chat/local-folder-bridge";

/*
 * The folder tools as the chat route offers them (src/lib/chat/local-folder.ts
 * says what they are and when a turn carries them). Each call is a closure over
 * the turn: it sends the call to the Mac on the turn's own stream and waits for
 * the Mac to post the result back.
 */

/** The wait the bridge gets: inside the dispatcher's own bound, so it always answers first. */
const BRIDGE_TIMEOUT_MS = LOCAL_FOLDER_CALL_TIMEOUT_MS - 30_000;

/** What the model reads for a result the Mac returned. Folder text is the disk's, not the user's. */
export function localToolText(folder: LocalFolderGrant, id: LocalFolderToolId, result: LocalToolResult): string {
  if (result.outcome === "denied") {
    return `The user declined this on their Mac, so nothing was done. ${result.output}`.trim();
  }
  if (result.outcome === "failed") return result.output || "The call failed on the Mac.";
  const reads = id === "folder_read_file" || id === "folder_search" || id === "folder_list_dir" || id === "folder_run_command";
  return reads ? wrapUntrusted(`folder "${folder.name}"`, result.output) : result.output;
}

export function createLocalFolderTools(input: {
  folder: LocalFolderGrant;
  userId: string;
  generationId: string;
  send: (chunk: StreamChunk) => void;
  /** Test seam; production issues a fresh id per call. */
  newCallId?: () => string;
}): NativeChatTool[] {
  const issue = input.newCallId ?? (() => `lft_${randomUUID()}`);
  return localFolderToolsFor(input.folder.access).map((id): NativeChatTool => {
    const definition = LOCAL_FOLDER_TOOLS[id];
    return {
      tool: {
        type: "function",
        function: { name: id, description: definition.description, parameters: definition.parameters },
      },
      label: definition.label,
      access: localFolderToolAccess(id),
      canonical: LOCAL_FOLDER_CANONICAL_TOOL,
      timeoutMs: LOCAL_FOLDER_CALL_TIMEOUT_MS,
      dedupe: false,
      present: (args) => localFolderPresent(id, args),
      async execute(rawArgs, signal, opts) {
        const check = checkLocalFolderArgs(id, rawArgs ?? {});
        if (!check.ok) {
          return { ok: false, text: check.error, body: check.error, status: "failed", error: { code: "invalid_args" } };
        }
        const callId = issue();
        // Running from here: the row says so, and the turn's stall watchdog is
        // held while the Mac works or the person reads the approval card. The
        // dispatcher's bound is this tool's own, sized for that.
        opts?.onAuthorized?.();
        const started = Date.now();
        const waiting = awaitLocalToolResult({
          callId,
          userId: input.userId,
          generationId: input.generationId,
          timeoutMs: BRIDGE_TIMEOUT_MS,
          signal,
        });
        input.send({ type: "local_tool", call: { id: callId, tool: id, args: check.args } });
        const result = await waiting;
        const text = localToolText(input.folder, id, result);
        const body = result.output || text;
        const durationMs = Date.now() - started;
        if (result.outcome === "succeeded") return { ok: true, text, body, durationMs };
        if (result.outcome === "denied") {
          return { ok: false, text, body, status: "denied", error: { code: "denied" }, durationMs };
        }
        return { ok: false, text, body, status: "failed", error: { code: "tool_error" }, durationMs };
      },
    };
  });
}
