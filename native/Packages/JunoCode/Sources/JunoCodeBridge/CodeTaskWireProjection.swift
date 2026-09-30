import Foundation
import JunoAgentProtocol
import JunoCodeCore
import JunoCodeKit
import JunoSync

/// What a device task's transcript sends to the server: a Mac session's events,
/// as the canonical agent protocol and in the task wire's legacy kinds.
///
/// `DesktopCodeHost` used to hold a second hand-written mapping from the
/// journal to the task kinds, different from the relay's, so the same run read
/// one way on a phone watching the session and another on the web watching the
/// task. Both are now spelled from `AgentProtocolProjection`.
///
/// When the server stores protocol rows (the task it handed over says so), each
/// protocol event goes up as a `protocol` row, followed by its legacy spelling
/// marked `protocolEventId` — the rows a shipped reader renders, and a protocol
/// reader skips. Against an older server only the legacy rows go, unmarked,
/// because it refuses a whole batch that carries a kind it does not know.
///
/// The legacy spelling is the one this Mac has always posted, so a shipped
/// iPhone or web tab sees the transcript it always saw — now bounded and
/// redacted like everything else that leaves the Mac.
public struct CodeTaskWireProjection: Sendable {
    /// The task event kind a protocol event rides under (src/lib/code-remote.ts).
    public static let protocolKind = "protocol"
    /// The payload key a legacy row names its protocol event under.
    public static let derivedKey = "protocolEventId"

    public let includesProtocol: Bool

    public init(includesProtocol: Bool) {
        self.includesProtocol = includesProtocol
    }

    /// The rows for one journal entry, in order.
    public func rows(for event: SessionEvent) -> [NativeCodeTaskEventInput] {
        let events = AgentProtocolProjection.events(for: event)
        var rows: [NativeCodeTaskEventInput] = []
        for projected in events {
            if includesProtocol, let payload = Self.wirePayload(projected) {
                rows.append(NativeCodeTaskEventInput(kind: Self.protocolKind, payload: payload))
            }
            for (kind, body) in Self.legacy(projected.payload) {
                var payload = body
                if includesProtocol { payload[Self.derivedKey] = .string(projected.id) }
                rows.append(NativeCodeTaskEventInput(kind: kind, payload: payload))
            }
        }
        // A call leaving the proposal stage has no protocol event of its own;
        // the task wire has always said so in a status line.
        if case .toolStarted(let tool) = event.payload {
            rows.append(NativeCodeTaskEventInput(kind: "status", payload: ["status": .string("Running \(tool.toolCallID)")]))
        }
        return rows
    }

    /// The task wire's word for a session status.
    public static func taskStatus(_ status: SessionStatus) -> String {
        taskWord(AgentProtocolProjection.state(status))
    }

    static func taskWord(_ state: AgentSessionState) -> String {
        switch state {
        case .awaitingApproval: "awaiting_approval"
        case .completed: "done"
        case .failed: "failed"
        case .cancelled, .interrupted: "cancelled"
        case .idle, .running, .awaitingInput, .unknown: "running"
        }
    }

    // MARK: - The legacy spelling

    private static func legacy(_ payload: AgentEventPayload) -> [(String, [String: NativeJSONValue])] {
        switch payload {
        case .itemUserMessage(let message):
            var body: [String: NativeJSONValue] = ["text": .string(message.text)]
            if message.delivery == .steer || message.delivery == .queue {
                body["delivery"] = .string(message.delivery.rawValue)
            }
            return [("user", body)]
        case .itemAssistantText(let text):
            return [("text", ["text": .string(text.text)])]
        case .itemThinking(let thinking):
            // Shipped readers know no reasoning row from a device task; they
            // have always drawn it as this tool row.
            return [("tool", ["name": .string("Reasoning"), "summary": .string(thinking.summary)])]
        case .itemToolCall(let call):
            var body: [String: NativeJSONValue] = ["name": .string(call.toolName), "summary": .string(call.title)]
            if let risk = call.risk { body["detail"] = .string(risk.rawValue) }
            return [("tool", body)]
        case .itemToolOutput(let output):
            return [("tool", ["name": .string(output.channel.rawValue), "summary": .string(output.text)])]
        case .itemToolResult(let result):
            return [("tool", ["name": .string(completionWord(result.status)), "summary": .string(result.summary ?? "")])]
        case .approvalRequested(let approval):
            return [(
                "approval_request",
                [
                    "requestId": .string(approval.approvalId),
                    "summary": .string(approval.summary),
                    "risk": .string(approval.risk.rawValue),
                    "detail": .string(approval.action),
                ]
            )]
        case .approvalResolved(let resolved):
            return [(
                "approval_response",
                [
                    "requestId": .string(resolved.approvalId),
                    "approve": .bool(resolved.decision == .allowOnce || resolved.decision == .allowAlways),
                ]
            )]
        case .itemFileChange(let change):
            return [(
                "file_change",
                [
                    "path": .string(change.path),
                    "changeKind": .string(change.change.rawValue),
                    "added": .number(Double(change.linesAdded)),
                    "removed": .number(Double(change.linesRemoved)),
                ]
            )]
        case .itemTestRun(let run):
            return [(
                "tool",
                [
                    "name": .string("Tests"),
                    "summary": .string(run.passed ? "Tests passed" : "Tests failed"),
                    "detail": .string(run.command),
                ]
            )]
        case .itemSubagent(let agent):
            return [(
                "agent",
                [
                    "agent": .object([
                        "id": .string(agent.itemId),
                        "title": .string(agent.title),
                        "status": .string(agent.status.rawValue),
                        "activity": .string(agent.activity ?? ""),
                    ]),
                ]
            )]
        case .planUpdated(let plan):
            return [("status", ["status": .string(plan.objective ?? "")])]
        case .sessionState(let state):
            return [("status", ["status": .string(taskWord(state.state))])]
        case .sessionError(let failure):
            return [("error", ["message": .string(failure.error.message)])]
        case .turnCompleted(let completed):
            return [(
                "done",
                [
                    "summary": .string(completed.summary ?? ""),
                    "filesChanged": .number(Double(completed.filesChanged ?? 0)),
                ]
            )]
        case .itemCompaction(let compaction):
            return [(
                "status",
                [
                    "status": .string("Context compacted"),
                    "detail": .string("\(compaction.beforeMessages ?? 0) → \(compaction.afterMessages ?? 0) messages"),
                ]
            )]
        case .itemNotice(let notice):
            var body: [String: NativeJSONValue] = ["status": .string(notice.text)]
            if let detail = notice.detail { body["detail"] = .string(detail) }
            return [("status", body)]
        // The task wire has no word for these, and a device task never needed one.
        case .sessionCreated, .sessionConfigured, .turnStarted, .turnFailed, .turnInterrupted,
             .transcriptRestarted, .itemAssistantTextDelta, .itemThinkingDelta, .questionAsked,
             .questionAnswered, .planProposed, .planResolved, .usageUpdated, .codePullRequest, .unknown:
            return []
        }
    }

    /// The Swift completion words the task wire has always carried.
    private static func completionWord(_ status: AgentToolResultStatus) -> String {
        switch status {
        case .ok: "succeeded"
        case .error: "failed"
        case .denied: "denied"
        case .notExecuted, .unknown: "cancelled"
        }
    }

    private static func wirePayload(_ event: AgentEvent) -> [String: NativeJSONValue]? {
        guard let data = try? AgentProtocolProjection.jsonData(event) else { return nil }
        return try? JSONDecoder().decode([String: NativeJSONValue].self, from: data)
    }
}
