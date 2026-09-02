import Foundation
import JunoCore

/// A remote Code session's event stream, folded into what a phone draws.
///
/// The relay journal is a flat, append-only list of small events — a token of
/// prose, a tool starting, a chunk of terminal output — and a transcript drawn
/// one row per event is unreadable at phone width: forty rows of `text_delta`
/// for one paragraph. This reducer folds the stream into the shapes the thread
/// view actually renders: a prompt, a paragraph, a *group* of tool activity, a
/// file change with its diff, an approval with its decision.
///
/// It is a pure function of the events, so it is unit-testable without a relay
/// and so a re-fold after a reconnect produces the same thread. The host's
/// payload keys vary a little between generations of the Mac app; every reader
/// here accepts the aliases the Mac's own remote monitor accepts.
public struct CodeRemoteThread: Equatable, Sendable {
    public struct ToolActivity: Equatable, Sendable, Identifiable {
        public let id: String
        public var name: String
        public var summary: String?
        public var input: String?
        public var output: String
        public var exitCode: Int?
        public var isFinished: Bool
        public var isError: Bool
        public let startedAt: Date

        public init(
            id: String, name: String, summary: String? = nil, input: String? = nil,
            output: String = "", exitCode: Int? = nil, isFinished: Bool = false,
            isError: Bool = false, startedAt: Date
        ) {
            self.id = id
            self.name = name
            self.summary = summary
            self.input = input
            self.output = output
            self.exitCode = exitCode
            self.isFinished = isFinished
            self.isError = isError
            self.startedAt = startedAt
        }
    }

    public struct FileChange: Equatable, Sendable, Identifiable {
        public let id: String
        public let path: String
        /// `edit`, `create`, `delete`, `rename` — the host's own word.
        public let changeKind: String
        public let additions: Int?
        public let deletions: Int?
        public let diff: String?
        public let occurredAt: Date

        public init(
            id: String, path: String, changeKind: String, additions: Int?, deletions: Int?,
            diff: String?, occurredAt: Date
        ) {
            self.id = id
            self.path = path
            self.changeKind = changeKind
            self.additions = additions
            self.deletions = deletions
            self.diff = diff
            self.occurredAt = occurredAt
        }
    }

    public struct Approval: Equatable, Sendable, Identifiable {
        public let requestID: String
        public let summary: String
        public let detail: String?
        public let risk: String
        public var approved: Bool?
        public let requestedAt: Date

        public var id: String { requestID }
        public var isPending: Bool { approved == nil }

        public init(
            requestID: String, summary: String, detail: String?, risk: String,
            approved: Bool? = nil, requestedAt: Date
        ) {
            self.requestID = requestID
            self.summary = summary
            self.detail = detail
            self.risk = risk
            self.approved = approved
            self.requestedAt = requestedAt
        }
    }

    public struct TestSummary: Equatable, Sendable {
        public enum Status: String, Equatable, Sendable {
            case running, passed, failed, unknown
        }

        public let status: Status
        public let passed: Int?
        public let failed: Int?
        public let skipped: Int?
        public let total: Int?
        public let detail: String?

        public init(
            status: Status, passed: Int?, failed: Int?, skipped: Int?, total: Int?, detail: String?
        ) {
            self.status = status
            self.passed = passed
            self.failed = failed
            self.skipped = skipped
            self.total = total
            self.detail = detail
        }
    }

    public struct Subagent: Equatable, Sendable, Identifiable {
        public let id: String
        public var title: String
        public var status: String?
        public var summary: String?

        public init(id: String, title: String, status: String?, summary: String?) {
            self.id = id
            self.title = title
            self.status = status
            self.summary = summary
        }
    }

    public enum Item: Equatable, Sendable, Identifiable {
        case userMessage(id: String, text: String, createdAt: Date)
        case assistantText(id: String, text: String)
        case reasoning(id: String, text: String)
        case workLog(id: String, activities: [ToolActivity])
        case fileChange(FileChange)
        case approval(Approval)
        case tests(id: String, summary: TestSummary)
        case git(id: String, text: String)
        case subagent(Subagent)
        case status(id: String, status: String)
        case error(id: String, message: String)
        case completed(id: String, summary: String?)

        public var id: String {
            switch self {
            case .userMessage(let id, _, _), .assistantText(let id, _), .reasoning(let id, _),
                .workLog(let id, _), .tests(let id, _), .git(let id, _), .status(let id, _),
                .error(let id, _), .completed(let id, _):
                id
            case .fileChange(let change): "change-\(change.id)"
            case .approval(let approval): "approval-\(approval.requestID)"
            case .subagent(let agent): "agent-\(agent.id)"
            }
        }
    }

    public var items: [Item] = []
    /// Every line of terminal output, in order, for the live log surface.
    public var terminalLines: [String] = []
    public var changes: [FileChange] = []
    public var approvals: [Approval] = []
    public var latestTests: TestSummary?
    public var subagents: [Subagent] = []
    /// The host's last reported status word, when it reported one.
    public var status: String?
    public var lastError: String?
    public var isComplete = false
    /// A `data:` or `https:` image the host attached as a preview, if any.
    public var previewImageURL: URL?
    /// Prompts this phone sent that the host has not echoed back yet.
    public var queuedPrompts: [String] = []

    public init() {}

    public var pendingApproval: Approval? { approvals.last(where: \.isPending) }
    public var isRunning: Bool {
        guard let status else { return false }
        return status == "running" || status == "awaiting_approval"
    }

    /// Whether the last item is prose still being written, so the view can show
    /// a cursor on it.
    public var isStreamingText: Bool {
        guard status == "running", case .assistantText? = items.last else { return false }
        return true
    }

    // MARK: - Reduction

    public static func reduce(
        _ events: [CodeRemoteSessionEvent], queuedPrompts: [String] = []
    ) -> CodeRemoteThread {
        var thread = CodeRemoteThread()
        var queued = queuedPrompts
        for event in events {
            let (kind, payload) = unwrap(event)
            thread.apply(kind: kind, payload: payload, seq: event.seq, at: event.createdAt)
            if kind == "user_message" || kind == "user" || kind == "message" {
                let text = read(payload, ["text", "message", "prompt", "content"]) ?? ""
                if let index = queued.firstIndex(where: {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                        == text.trimmingCharacters(in: .whitespacesAndNewlines)
                }) {
                    queued.remove(at: index)
                }
            }
        }
        thread.queuedPrompts = queued
        return thread
    }

    /// Unwraps a `canonical_session_event` envelope to a legacy-shaped
    /// `(kind, payload)` pair, so the reducer has one vocabulary.
    static func unwrap(_ event: CodeRemoteSessionEvent) -> (String, [String: JunoJSONValue]) {
        guard event.kind == "canonical_session_event",
            case .object(let envelope)? = event.payload["event"],
            case .object(let payload)? = envelope["payload"]
        else { return (event.kind, event.payload) }
        // The canonical payload is a Swift enum encoded as `{"caseName": {...}}`.
        guard let (caseName, raw) = payload.first, case .object(let body) = raw else {
            return (event.kind, event.payload)
        }
        switch caseName {
        case "userPrompt", "userInstruction": return ("user_message", body)
        case "assistantMessage": return ("text_delta", body)
        case "reasoningSummary": return ("reasoning_delta", body)
        case "toolProposed", "toolStarted": return ("tool_start", body)
        case "toolOutput": return ("command_output", body)
        case "toolCompleted": return ("tool_result", body)
        case "approvalRequested": return ("approval_request", body)
        case "approvalResolved": return ("approval_response", body)
        case "fileChanged": return ("file_change", body)
        case "testRunCompleted": return ("test_update", body)
        case "subagentUpdated": return ("subagent_update", body)
        case "statusChanged": return ("status_update", body)
        case "errorOccurred": return ("error", body)
        case "runCompleted": return ("completed", body)
        case "sessionCreated": return ("session_created", body)
        default: return (caseName, body)
        }
    }

    private mutating func apply(
        kind: String, payload: [String: JunoJSONValue], seq: Int, at date: Date
    ) {
        let id = "e\(seq)"
        switch kind {
        case "user_message", "user", "message":
            let text = Self.read(payload, ["text", "message", "prompt", "content"]) ?? ""
            guard !text.isEmpty else { return }
            items.append(.userMessage(id: id, text: text, createdAt: date))

        case "text_delta", "text", "assistant", "assistant_text", "response":
            let text = Self.read(payload, ["text", "delta", "message", "content"]) ?? ""
            guard !text.isEmpty else { return }
            if case .assistantText(let existingID, let existing)? = items.last {
                items[items.count - 1] = .assistantText(id: existingID, text: existing + text)
            } else {
                items.append(.assistantText(id: id, text: text))
            }

        case "reasoning_delta", "reasoning":
            let text = Self.read(payload, ["text", "delta", "summary"]) ?? ""
            guard !text.isEmpty else { return }
            if case .reasoning(let existingID, let existing)? = items.last {
                items[items.count - 1] = .reasoning(id: existingID, text: existing + text)
            } else {
                items.append(.reasoning(id: id, text: text))
            }

        case "tool_start", "tool", "tool_call", "tool_started":
            let callID = Self.read(payload, ["toolCallId", "toolCallID", "callId", "id"]) ?? id
            let activity = ToolActivity(
                id: callID,
                name: Self.read(payload, ["name", "toolName", "tool"]) ?? "Tool",
                summary: Self.read(payload, ["summary", "title"]),
                input: Self.read(payload, ["command", "input", "detail", "arguments"]),
                startedAt: date
            )
            appendActivity(activity, id: id)

        case "command_output", "tool_output", "terminal":
            let text = Self.read(payload, ["text", "output", "chunk", "detail"]) ?? ""
            guard !text.isEmpty else { return }
            terminalLines.append(contentsOf: text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))
            let callID = Self.read(payload, ["toolCallId", "toolCallID", "callId"])
            let updated = updateActivity(id: callID) { activity in
                activity.output += (activity.output.isEmpty ? "" : "\n") + text
            }
            if !updated {
                appendActivity(
                    ToolActivity(
                        id: id, name: Self.read(payload, ["name", "summary"]) ?? "Terminal",
                        output: text, startedAt: date
                    ),
                    id: id
                )
            }

        case "tool_result", "tool_completed":
            let callID = Self.read(payload, ["toolCallId", "toolCallID", "callId", "id"])
            let output = Self.read(payload, ["output", "text", "result", "detail"])
            let exit = payload["exitCode"]?.numberValue ?? payload["exit_code"]?.numberValue
            let failed = payload["isError"]?.boolValue ?? payload["error"]?.boolValue
                ?? (Self.read(payload, ["error"]) != nil)
            if let output, !output.isEmpty {
                terminalLines.append(contentsOf: output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))
            }
            let updated = updateActivity(id: callID) { activity in
                if let output, !output.isEmpty, activity.output.isEmpty { activity.output = output }
                activity.exitCode = exit.map { Int($0) }
                activity.isFinished = true
                activity.isError = failed || (exit ?? 0) != 0
            }
            if !updated {
                appendActivity(
                    ToolActivity(
                        id: id, name: Self.read(payload, ["name", "toolName", "tool"]) ?? "Tool",
                        summary: Self.read(payload, ["summary"]),
                        output: output ?? "", exitCode: exit.map { Int($0) },
                        isFinished: true, isError: failed, startedAt: date
                    ),
                    id: id
                )
            }

        case "file_change", "file_changed":
            guard let path = Self.read(payload, ["path", "file", "relativePath"]) else { return }
            let change = FileChange(
                id: id,
                path: path,
                changeKind: Self.read(payload, ["changeKind", "kind", "change", "changeType"]) ?? "edit",
                additions: (payload["linesAdded"]?.numberValue ?? payload["added"]?.numberValue
                    ?? payload["additions"]?.numberValue).map { Int($0) },
                deletions: (payload["linesRemoved"]?.numberValue ?? payload["removed"]?.numberValue
                    ?? payload["deletions"]?.numberValue).map { Int($0) },
                diff: Self.read(payload, ["diff", "patch", "unifiedDiff"]),
                occurredAt: date
            )
            changes.append(change)
            items.append(.fileChange(change))

        case "approval_request":
            let requestID = Self.read(payload, ["requestId", "requestID", "id"]) ?? id
            let approval = Approval(
                requestID: requestID,
                summary: Self.read(payload, ["summary", "text", "title"]) ?? "Approval required",
                detail: Self.read(payload, ["detail", "description", "command"]),
                risk: Self.read(payload, ["risk"]) ?? "neutral",
                requestedAt: date
            )
            approvals.append(approval)
            items.append(.approval(approval))

        case "approval_response":
            let requestID = Self.read(payload, ["requestId", "requestID", "id"])
            let approved = payload["approved"]?.boolValue ?? payload["approve"]?.boolValue ?? false
            let index = approvals.lastIndex { requestID == nil ? $0.isPending : $0.requestID == requestID }
            guard let index else { return }
            approvals[index].approved = approved
            let resolved = approvals[index]
            if let itemIndex = items.lastIndex(where: { $0.id == "approval-\(resolved.requestID)" }) {
                items[itemIndex] = .approval(resolved)
            }

        case "test_update", "test_run":
            let summary = Self.testSummary(payload)
            latestTests = summary
            if case .tests(let existingID, _)? = items.last {
                items[items.count - 1] = .tests(id: existingID, summary: summary)
            } else {
                items.append(.tests(id: id, summary: summary))
            }

        case "git_update", "git":
            let text = Self.read(payload, ["summary", "text", "message", "branch", "status"]) ?? "Repository updated"
            items.append(.git(id: id, text: text))

        case "subagent_update", "agent":
            var agentObject = payload
            if case .object(let nested)? = payload["agent"] { agentObject = nested }
            let agentID = Self.read(agentObject, ["id", "agentId", "agentID"]) ?? id
            let title = Self.read(agentObject, ["title", "name", "summary"]) ?? "Sub-agent"
            let status = Self.read(agentObject, ["status", "state"])
            let summary = Self.read(agentObject, ["summary", "detail"])
            if let index = subagents.firstIndex(where: { $0.id == agentID }) {
                subagents[index].title = title
                subagents[index].status = status ?? subagents[index].status
                subagents[index].summary = summary ?? subagents[index].summary
                let agent = subagents[index]
                if let itemIndex = items.lastIndex(where: { $0.id == "agent-\(agentID)" }) {
                    items[itemIndex] = .subagent(agent)
                }
            } else {
                let agent = Subagent(id: agentID, title: title, status: status, summary: summary)
                subagents.append(agent)
                items.append(.subagent(agent))
            }

        case "status_update", "status", "status_changed":
            guard let status = Self.read(payload, ["status", "state"]) else { return }
            self.status = status
            if status == "completed" || status == "failed" || status == "interrupted" {
                isComplete = true
            }
            items.append(.status(id: id, status: status))

        case "error", "failed":
            let message = Self.read(payload, ["message", "error", "text", "detail"]) ?? "Something went wrong"
            lastError = message
            items.append(.error(id: id, message: message))

        case "completed", "done", "session_completed":
            isComplete = true
            if status == nil || status == "running" { status = "completed" }
            items.append(.completed(id: id, summary: Self.read(payload, ["summary", "text", "detail"])))

        case "preview":
            if let raw = Self.read(payload, ["url", "imageUrl", "image", "dataURL"]),
                let url = URL(string: raw)
            {
                previewImageURL = url
            }

        case "session_created", "session_updated", "usage", "heartbeat":
            break

        default:
            break
        }
    }

    // MARK: - Helpers

    /// Appends tool activity to the open work log, or opens a new one. A work
    /// log stays open only while consecutive events are tool activity; prose or
    /// a change in between closes it, which is what keeps "read three files,
    /// ran the tests" grouped and "wrote a paragraph" separate.
    private mutating func appendActivity(_ activity: ToolActivity, id: String) {
        if case .workLog(let logID, var activities)? = items.last {
            activities.append(activity)
            items[items.count - 1] = .workLog(id: logID, activities: activities)
        } else {
            items.append(.workLog(id: id, activities: [activity]))
        }
    }

    /// Returns false when no activity matched, so the caller can open one.
    private mutating func updateActivity(
        id callID: String?, _ change: (inout ToolActivity) -> Void
    ) -> Bool {
        // Search backwards through work logs for the call, or for the last
        // unfinished activity when the host did not name one.
        for itemIndex in items.indices.reversed() {
            guard case .workLog(let logID, var activities) = items[itemIndex] else { continue }
            let index: Int?
            if let callID {
                index = activities.lastIndex { $0.id == callID }
            } else {
                index = activities.lastIndex { !$0.isFinished }
            }
            guard let index else {
                if callID == nil { break }
                continue
            }
            change(&activities[index])
            items[itemIndex] = .workLog(id: logID, activities: activities)
            return true
        }
        return false
    }

    static func read(_ payload: [String: JunoJSONValue], _ keys: [String]) -> String? {
        for key in keys {
            if let value = payload[key]?.stringValue, !value.isEmpty { return value }
        }
        return nil
    }

    private static func testSummary(_ payload: [String: JunoJSONValue]) -> TestSummary {
        var object = payload
        if case .object(let nested)? = payload["tests"] { object = nested }
        else if case .object(let nested)? = payload["summary"] { object = nested }
        let passed = object["passed"]?.numberValue.map { Int($0) }
        let failed = object["failed"]?.numberValue.map { Int($0) }
        let skipped = object["skipped"]?.numberValue.map { Int($0) }
        let total = (object["total"]?.numberValue ?? object["testsRun"]?.numberValue).map { Int($0) }
        let statusWord = read(object, ["status", "state"]) ?? read(payload, ["status"])
        let status: TestSummary.Status
        switch statusWord {
        case "running", "started": status = .running
        case "passed", "success", "succeeded": status = .passed
        case "failed", "failure", "error": status = .failed
        default:
            if let failed, failed > 0 { status = .failed }
            else if object["passed"]?.boolValue == false { status = .failed }
            else if let passed, passed > 0 { status = .passed }
            else if object["passed"]?.boolValue == true { status = .passed }
            else { status = .unknown }
        }
        return TestSummary(
            status: status,
            passed: passed,
            failed: failed,
            skipped: skipped,
            total: total,
            detail: read(object, ["failureDetail", "detail", "summary", "text"])
                ?? read(payload, ["detail", "text"])
        )
    }
}
