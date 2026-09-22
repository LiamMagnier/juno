import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCore

/// What a phone sees of a Mac session: each local transcript event, projected
/// into the relay's event vocabulary.
///
/// A projection rather than the raw event, for three reasons.
///
/// - **What leaves the Mac is decided here, field by field.** The local record
///   holds things a phone has no business with: a tool call's full input (a
///   file being written, whole), a worktree's absolute path, a sub-agent's
///   brief. The projection carries what the Mac's own thread shows — prompts,
///   replies, one-line tool summaries, command output, file names with their
///   line counts — and redacts likely credentials from all of it.
/// - **Deterministic numbering.** Relay sequence *n* is the local event with
///   sequence *n − 1*, one for one; an event with nothing to show a phone
///   still occupies its number as a `heartbeat`. The same history therefore
///   always yields the same numbers, which is what lets the relay drop a
///   re-sent batch as a replay instead of storing it twice, and what lets an
///   upload resume from a count.
/// - **The phone already reads these kinds.** `CodeRemoteThread` folds exactly
///   this vocabulary. A session's live status is the list's to say, though,
///   not the journal's: waiting on an approval is never journalled as a status,
///   so a `status_update` is a record of what the run passed through, and the
///   relay lets one move the list only when it is newer than the list's own
///   statement (`appendedStatusFields` in `src/lib/code-remote-sessions.ts`).
public enum CodeRelayEventProjection {
    /// Bounds per field. A phone renders a paragraph and a terminal tail, not a
    /// log file, and the relay refuses an event over 64 KB.
    static let maximumTextCharacters = 12_000
    static let maximumOutputCharacters = 8_000
    static let maximumSummaryCharacters = 1_000

    private static let redactor = SecretRedactor()

    /// The relay event for one local event.
    public static func relayEvent(_ event: SessionEvent) -> CodeRemoteSessionEvent {
        let (kind, payload) = project(event.payload)
        return CodeRemoteSessionEvent(
            seq: event.sequence + 1,
            kind: kind,
            payload: payload,
            createdAt: event.timestamp
        )
    }

    /// A contiguous run of relay events after `afterSequence`, at most `limit`.
    ///
    /// A local sequence missing from `events` — a line the store could not
    /// decode — becomes a `heartbeat` rather than a hole. The relay refuses a
    /// gap, so one unreadable line would otherwise stall every event after it.
    public static func relayEvents(
        _ events: [SessionEvent], after afterSequence: Int, limit: Int, total: Int
    ) -> [CodeRemoteSessionEvent] {
        guard afterSequence < total, limit > 0 else { return [] }
        let upper = min(total, afterSequence + limit)
        var byLocalSequence: [Int: SessionEvent] = [:]
        for event in events where event.sequence >= afterSequence && event.sequence < upper {
            byLocalSequence[event.sequence] = event
        }
        return (afterSequence..<upper).map { local in
            if let event = byLocalSequence[local] { return relayEvent(event) }
            return CodeRemoteSessionEvent(
                seq: local + 1, kind: "heartbeat", payload: [:],
                createdAt: events.last?.timestamp ?? Date(timeIntervalSince1970: 0)
            )
        }
    }

    /// The relay's word for a session status. The relay knows six; the Mac's
    /// finer states are all either working or waiting on somebody.
    public static func relayStatus(_ status: SessionStatus) -> String {
        switch status {
        case .idle: "idle"
        case .planning, .running, .waitingForProvider, .degraded, .stopping: "running"
        case .waitingForApproval: "awaiting_approval"
        case .completed: "completed"
        case .failed: "failed"
        case .cancelled: "interrupted"
        }
    }

    // MARK: - Mapping

    private static func project(
        _ payload: SessionEventPayload
    ) -> (String, [String: JunoJSONValue]) {
        switch payload {
        case .sessionCreated(let created):
            // The workspace's name only. `executionRootPath` is an absolute
            // path on this Mac and never leaves it.
            var body: [String: JunoJSONValue] = [
                "modelID": .string(created.configuration.modelID),
                "permissionMode": .string(created.configuration.permissionMode.rawValue),
            ]
            if let name = created.workspaceName { body["workspaceName"] = .string(name) }
            return ("session_created", body)

        case .turnConfiguration(let turn):
            var body: [String: JunoJSONValue] = [
                "modelID": .string(turn.modelID),
                "permissionMode": .string(turn.effectivePermissionMode.rawValue),
                "behavior": .string(turn.behavior.rawValue),
            ]
            if let effort = turn.reasoningEffort { body["reasoningEffort"] = .string(effort.rawValue) }
            return ("session_updated", body)

        case .userPrompt(let prompt):
            return ("user_message", ["text": text(prompt.text, limit: maximumTextCharacters)])

        case .userInstruction(let instruction):
            return (
                "user_message",
                [
                    "text": text(instruction.text, limit: maximumTextCharacters),
                    "delivery": .string(instruction.kind.rawValue),
                ]
            )

        case .userInstructionApplied:
            return ("heartbeat", [:])

        case .assistantMessage(let message):
            return ("text_delta", ["text": text(message.text, limit: maximumTextCharacters)])

        case .reasoningSummary(let reasoning):
            return ("reasoning_delta", ["text": text(reasoning.summary, limit: maximumTextCharacters)])

        case .toolProposed(let tool):
            // The summary, never the input: a write's input is the whole file.
            return (
                "tool_start",
                [
                    "toolCallId": .string(tool.toolCallID),
                    "name": .string(tool.toolName),
                    "summary": text(tool.summary, limit: maximumSummaryCharacters),
                    "risk": .string(tool.risk.rawValue),
                ]
            )

        case .toolStarted(let tool):
            // The phone opened the step at the proposal; a second start would
            // draw it twice.
            return ("heartbeat", ["toolCallId": .string(tool.toolCallID)])

        case .toolOutput(let output):
            return (
                "command_output",
                [
                    "toolCallId": .string(output.toolCallID),
                    "channel": .string(output.channel.rawValue),
                    "text": text(output.text, limit: maximumOutputCharacters),
                ]
            )

        case .toolCompleted(let tool):
            return (
                "tool_result",
                [
                    "toolCallId": .string(tool.toolCallID),
                    "status": .string(tool.status.rawValue),
                    "summary": text(tool.resultSummary, limit: maximumSummaryCharacters),
                    "isError": .bool(tool.status != .succeeded),
                    "durationSeconds": .number(tool.durationSeconds),
                ]
            )

        case .approvalRequested(let approval):
            return (
                "approval_request",
                [
                    "requestId": .string(approval.id),
                    "summary": text(approval.summary, limit: maximumSummaryCharacters),
                    "risk": .string(approval.risk.rawValue),
                    "detail": .string(approval.toolName),
                ]
            )

        case .approvalResolved(let resolved):
            return (
                "approval_response",
                [
                    "requestId": .string(resolved.approvalID),
                    "approved": .bool(resolved.decision == .approved),
                ]
            )

        case .fileChanged(let change):
            // The workspace-relative path and its size, not its contents. The
            // checkpoint id is what lets the phone ask for exactly this change
            // to be undone.
            var body: [String: JunoJSONValue] = [
                "path": .string(change.path.value),
                "changeKind": .string(change.kind.rawValue),
                "linesAdded": .number(Double(change.linesAdded)),
                "linesRemoved": .number(Double(change.linesRemoved)),
            ]
            if let checkpoint = change.checkpointID { body["checkpointId"] = .string(checkpoint) }
            return ("file_change", body)

        case .testRunCompleted(let run):
            var body: [String: JunoJSONValue] = [
                "status": .string(run.passed ? "passed" : "failed"),
                "detail": text(run.command, limit: maximumSummaryCharacters),
                "durationSeconds": .number(run.durationSeconds),
            ]
            if let total = run.testsRun { body["total"] = .number(Double(total)) }
            if let failed = run.failures { body["failed"] = .number(Double(failed)) }
            return ("test_update", body)

        case .subagentUpdated(let update):
            // Its title, state and result — not the brief it was given.
            var agent: [String: JunoJSONValue] = [
                "id": .string(update.agentID),
                "title": text(update.title, limit: maximumSummaryCharacters),
                "status": .string(update.status.rawValue),
            ]
            let summary = update.summary ?? (update.currentActivity.isEmpty ? nil : update.currentActivity)
            if let summary { agent["summary"] = text(summary, limit: maximumSummaryCharacters) }
            return ("subagent_update", ["agent": .object(agent)])

        case .goalUpdated(let goal):
            return (
                "session_updated",
                ["goal": text(goal.goal.objective, limit: maximumSummaryCharacters)]
            )

        case .statusChanged(let status):
            return ("status_update", ["status": .string(relayStatus(status.status))])

        case .errorOccurred(let error):
            return (
                "error",
                [
                    "message": text(error.message, limit: maximumSummaryCharacters),
                    "recoverable": .bool(error.isRecoverable),
                ]
            )

        case .runCompleted(let run):
            return (
                "completed",
                [
                    "summary": text(run.summary, limit: maximumTextCharacters),
                    "filesChanged": .number(Double(run.filesChanged)),
                    "durationSeconds": .number(run.durationSeconds),
                ]
            )

        case .compaction(let compaction):
            return ("session_updated", ["compaction": .string(compaction.messageCountSummary)])
        }
    }

    private static func text(_ value: String, limit: Int) -> JunoJSONValue {
        let redacted = redactor.redact(value)
        guard redacted.count > limit else { return .string(redacted) }
        return .string(String(redacted.prefix(limit)) + "\n… [shortened on the way to your phone]")
    }
}
