import type { CodeDevice, CodeTask, CodeTaskEvent } from "@prisma/client";

import { chunkEventFrames } from "@/lib/code-remote-sessions";

/*
 * THE CODE TASK WIRE: what every host and client is handed for a task.
 *
 * Its own module, with nothing but a type import and the relay's frame cutter
 * (itself dependency-free), for two reasons. The PM2
 * workers and plain `tsx` scripts can import it without pulling in the request
 * helpers (next-auth, the Prisma client, env validation) that live beside it in
 * code-remote.ts, which re-exports all of it so route handlers are unchanged.
 * And it is the one place the shape is decided, so the fixtures the Swift
 * decoder is tested against are generated from THIS function
 * (scripts/generate-code-task-wire-fixtures.ts) rather than typed by hand.
 *
 * That last point is the whole reason this file exists. The Mac decoded
 * `modelId`, the server never sent a model under any name, and the Swift test
 * fixture carried `modelId`, `agentRuntime`, `computerUse` and
 * `subagentsEnabled` — four fields no server has ever sent — so the test passed
 * while every device task silently ran on the first model in the catalog. A
 * fixture written from memory tests the memory.
 */

/**
 * The version of the canonical agent session protocol
 * (contracts/agent/juno-agent-protocol-v1.json) this server stores as
 * `protocol` task events. Handed to every host with the task it runs, so a host
 * posts protocol rows only to a server that will take them: an older server
 * checks `kind` against a closed list and refuses the whole batch.
 */
export const AGENT_PROTOCOL_ACCEPTED = "1.0";

export function serializeDevice(device: CodeDevice, online?: boolean) {
  const base = {
    id: device.id,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    protocolVersion: device.protocolVersion,
    workspaces: device.workspaces,
    sessionCount: device.sessionCount,
    activeCount: device.activeCount,
    // Presence and capability are different facts. A client that reads
    // `online` as "can run my work" is the bug this field exists to end: the
    // Mac is online and signed in, and it still claims nothing.
    servesQueuedTasks: device.servesQueuedTasks,
    lastSeenAt: device.lastSeenAt.toISOString(),
  };
  return online === undefined ? base : { ...base, online };
}

/**
 * Per-call shape of `serializeTask`.
 *
 * `includePrompt` exists because `prompt` is the AGENT prompt — the composer
 * text plus up to 100 KB of extracted attachment text per task — and the run
 * list polled a hundred of them every six seconds for a screen that reads the
 * title. The list route now omits it unless asked (`?include=prompt`); every
 * single-task route and the host queue keep it, because the host is what runs
 * it. `changedFileCount` is the list's read-time derivation (see
 * `countChangedFiles`) and is absent wherever it was not computed.
 */
export interface SerializeTaskOptions {
  includePrompt?: boolean;
  changedFileCount?: number;
}

export function serializeTask(task: CodeTask, opts: SerializeTaskOptions = {}) {
  const includePrompt = opts.includePrompt ?? true;
  return {
    id: task.id,
    deviceId: task.deviceId,
    workspacePath: task.workspacePath,
    workspaceName: task.workspaceName,
    workspaceKey: task.workspaceKey,
    title: task.title,
    ...(includePrompt ? { prompt: task.prompt } : {}),
    ...(opts.changedFileCount !== undefined ? { changedFileCount: opts.changedFileCount } : {}),
    status: task.status,
    lastSeq: task.lastSeq,
    conversationId: task.conversationId,
    parentSessionId: task.parentSessionId,
    createsNewSession: task.createsNewSession,
    origin: task.origin,
    // Cloud Juno Code: "device" (default) runs on a registered host; "cloud"
    // runs on a GitHub Actions runner against repoOwner/repoName and opens a PR.
    target: task.target,
    repoOwner: task.repoOwner,
    repoName: task.repoName,
    baseRef: task.baseRef,
    // The branch a cloud run pushed to and the pull request it opened or
    // reused — what a follow-up in the same conversation continues on.
    branch: task.branch,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    // What the submitter chose to run with. The create route has stored both
    // since the composer's model picker and thinking slider were wired, and
    // the cloud runner reads them through runner-context — but this wire, the
    // one a Mac claims device tasks through, carried neither, so a model
    // picked on the web for a Mac run never reached the Mac. Null means "no
    // preference": the host falls back to its first available model and to
    // no thinking parameter, which is what every such run got before.
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    // What this cloud run was dispatched with: the environment (egress,
    // variables, setup script) and how much the agent may do before it would
    // have to ask. Both null on a device task and on anything created before
    // the columns existed; a reader treats null as "the built-in shape", which
    // is what such a run actually got. The variable VALUES are never here —
    // only runner-context unseals them, and only for the runner.
    environmentId: task.environmentId,
    permissionMode: task.permissionMode,
    // Which agent protocol this server stores as `protocol` events. A fact
    // about the server, stated on the task because the task is the only thing
    // a host reads before it starts posting.
    agentProtocol: AGENT_PROTOCOL_ACCEPTED,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function serializeTaskEvent(event: CodeTaskEvent) {
  return {
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * The most a task stream's frame carries. Each frame is one `data:` line, and
 * the iPhone's parser DISCARDS a frame past 2 MB (NativeCodeSSEParser) — no
 * error, just nothing — so a page is cut well below that.
 */
export const TASK_EVENT_FRAME_BYTES = 512 * 1024;

/**
 * One page of a task's events as the stream's frames, in order: the first
 * under `type`, the rest as `events`, each within `maxBytes`. A snapshot is
 * always sent, even empty, because it is what tells a client it is attached.
 *
 * The stream sent a page — up to 500 rows — as one frame. Every row a host
 * reports now arrives twice, as its protocol event and its legacy twin, so a
 * run that changed a few dozen files (a diff of up to 40 KB each, in both)
 * made the page a phone was handed on connect larger than it will read.
 */
export function taskEventFrames<T extends { seq: number }>(
  type: "snapshot" | "events",
  events: T[],
  maxBytes: number = TASK_EVENT_FRAME_BYTES,
): Array<{ type: "snapshot" | "events"; events: T[] }> {
  const pages = chunkEventFrames(events, maxBytes);
  if (pages.length === 0) return type === "snapshot" ? [{ type, events: [] }] : [];
  return pages.map((page, index) => ({ type: index === 0 ? type : "events", events: page }));
}
