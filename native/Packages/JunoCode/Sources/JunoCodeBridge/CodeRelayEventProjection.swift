import Foundation
import JunoAgentProtocol
import JunoCodeCore
import JunoCodeKit
import JunoCodeRuntime
import JunoCore

/// What a phone sees of a Mac session: each local transcript event, as the
/// relay's event vocabulary — derived from the canonical agent protocol.
///
/// The meaning of each event is decided once, by `AgentProtocolProjection`
/// (what leaves the Mac, bounded and redacted). This file only spells those
/// protocol events in the relay's older kinds, for the phones that read them,
/// and carries the protocol events themselves beside them under the payload key
/// `protocol` — added, never replacing, so a shipped phone sees exactly the
/// payload it always saw. The checklist, questions and plan reviews have no
/// older kind and go as the typed `canonical_session_event` the phone already
/// unwraps, with the protocol events beside them the same way.
///
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
    /// Bounds per field — the protocol projection's, which are the relay's.
    static let maximumTextCharacters = AgentProtocolProjection.maximumTextCharacters
    static let maximumOutputCharacters = AgentProtocolProjection.maximumOutputCharacters
    static let maximumSummaryCharacters = AgentProtocolProjection.maximumSummaryCharacters

    /// The payload key the protocol events ride under.
    public static let protocolKey = "protocol"

    /// How much of the relay's 64 KB per-event limit an event may use once its
    /// protocol events ride along. Past this the protocol copy is left off that
    /// one event — its legacy payload is complete on its own — rather than
    /// risk a refusal that would stall every upload after it.
    static let protocolPayloadBudget = 48 * 1024

    private static let redactor = SecretRedactor()

    /// The relay event for one local event.
    public static func relayEvent(_ event: SessionEvent) -> CodeRemoteSessionEvent {
        // A rewind's restart goes as the canonical event, the one form of it
        // the phone recognises (`CodeRemoteThread.restartsTranscript`): the
        // relay stores no kind of its own for it. It needs no jump in the
        // relay's numbering — the rewind numbered it past every sequence the
        // session had used, so it follows the relay's last event directly —
        // and it carries nothing but the id of the message rewound to.
        if event.payload.restartsTranscript,
           let restart = try? CodeRelayProtocolAdapter.relayEvent(
               from: CodeSessionStoreProtocolAdapter.envelope(from: event)
           )
        {
            return restart
        }
        let events = AgentProtocolProjection.events(for: event)
        var kind: String
        var payload: [String: JunoJSONValue]
        // The checklist, questions and plan reviews have no legacy relay kind,
        // and the relay refuses kinds it does not know. They go as the
        // canonical typed event — everything a phone needs to draw the card
        // and send the answer back under its id — with their text redacted
        // and bounded as every other projection's is.
        if let interaction = canonicalInteraction(event.payload),
           let typed = try? CodeRelayProtocolAdapter.relayEvent(
               from: CodeSessionStoreProtocolAdapter.envelope(
                   from: SessionEvent(
                       id: event.id,
                       sessionID: event.sessionID,
                       sequence: event.sequence,
                       timestamp: event.timestamp,
                       payload: interaction
                   )
               )
           )
        {
            (kind, payload) = (typed.kind, typed.payload)
        } else {
            (kind, payload) = legacy(events, for: event)
        }
        if !events.isEmpty, let carried = carriedProtocol(events, beside: payload) {
            payload[protocolKey] = carried
        }
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

    /// The relay's word for a session status, through the protocol's state so
    /// the list and the journal can never disagree about it.
    public static func relayStatus(_ status: SessionStatus) -> String {
        relayWord(AgentProtocolProjection.state(status))
    }

    // MARK: - Interactions

    /// A redacted, bounded copy of an interaction event, or nil for any other.
    ///
    /// Bounded in UTF-8 bytes, which is what the relay's 64 KB per event is
    /// counted in, with room for JSON to double what it escapes: counted in
    /// characters, fifty checklist items of 300 were 90 KB in a script of
    /// three-byte letters, and the relay swapped the whole list for a notice.
    static func canonicalInteraction(_ payload: SessionEventPayload) -> SessionEventPayload? {
        func clean(_ value: String, _ bytes: Int = maximumSummaryCharacters) -> String {
            OutputLimiter.apply(
                OutputLimit(maximumBytes: bytes, truncationNotice: "\n… [shortened on the way to your phone]"),
                to: redactor.redact(value)
            ).text
        }
        switch payload {
        case let .todosUpdated(list):
            return .todosUpdated(TodoListEvent(items: list.items.prefix(50).map { item in
                TodoItem(
                    id: String(item.id.prefix(64)),
                    content: clean(item.content, 250),
                    status: item.status,
                    activeForm: item.activeForm.map { clean($0, 200) }
                )
            }))
        case let .questionRequested(request):
            return .questionRequested(QuestionRequest(
                id: request.id,
                sessionID: request.sessionID,
                toolCallID: request.toolCallID,
                questions: request.questions.map { question in
                    UserQuestion(
                        id: question.id,
                        question: clean(question.question),
                        header: question.header.map { clean($0, 120) },
                        options: question.options.map { option in
                            UserQuestionOption(label: clean(option.label, 200), description: option.description.map { clean($0, 400) })
                        },
                        allowsMultipleSelection: question.allowsMultipleSelection
                    )
                },
                requestedAt: request.requestedAt,
                expiresAt: request.expiresAt
            ))
        case let .questionResolved(resolved):
            guard case let .answered(answers) = resolved.resolution else { return payload }
            return .questionResolved(QuestionResolvedEvent(
                requestID: resolved.requestID,
                resolution: .answered(answers.map { answer in
                    QuestionAnswer(
                        questionID: answer.questionID,
                        selectedOptions: answer.selectedOptions.map { clean($0, 200) },
                        text: answer.text.map { clean($0) }
                    )
                })
            ))
        case let .planSubmitted(request):
            return .planSubmitted(PlanApprovalRequest(
                id: request.id,
                sessionID: request.sessionID,
                toolCallID: request.toolCallID,
                plan: clean(request.plan, 24_000),
                requestedAt: request.requestedAt,
                expiresAt: request.expiresAt
            ))
        case let .planResolved(resolved):
            guard case let .keepPlanning(feedback?) = resolved.decision else { return payload }
            return .planResolved(PlanResolvedEvent(
                requestID: resolved.requestID,
                decision: .keepPlanning(feedback: clean(feedback))
            ))
        default:
            return nil
        }
    }

    // MARK: - The relay's spelling of the protocol

    /// The relay's kind and payload for the protocol events of one journal
    /// entry. The relay has one row per entry, so the entry's first event that
    /// the relay has a word for is the one spelled; an entry with none is a
    /// heartbeat.
    static func legacy(
        _ events: [AgentEvent], for event: SessionEvent
    ) -> (String, [String: JunoJSONValue]) {
        for projected in events {
            if let spelled = legacy(projected.payload) { return spelled }
        }
        // The phone opened the step at the proposal; a second start would
        // draw it twice, so a start holds its number as a heartbeat.
        if case .toolStarted(let tool) = event.payload {
            return ("heartbeat", ["toolCallId": .string(tool.toolCallID)])
        }
        return ("heartbeat", [:])
    }

    private static func legacy(_ payload: AgentEventPayload) -> (String, [String: JunoJSONValue])? {
        switch payload {
        case .sessionCreated(let created):
            var body: [String: JunoJSONValue] = [:]
            if let model = created.model { body["modelID"] = .string(model) }
            if let mode = created.mode.flatMap(AgentProtocolProjection.permissionMode) {
                body["permissionMode"] = .string(mode.rawValue)
            }
            if let name = created.workspaceName { body["workspaceName"] = .string(name) }
            return ("session_created", body)

        case .sessionConfigured(let configured):
            var body: [String: JunoJSONValue] = [:]
            if let model = configured.model { body["modelID"] = .string(model) }
            if let mode = configured.mode.flatMap(AgentProtocolProjection.permissionMode) {
                body["permissionMode"] = .string(mode.rawValue)
            }
            if let behavior = configured.behavior { body["behavior"] = .string(behavior.rawValue) }
            if let effort = configured.effort { body["reasoningEffort"] = .string(effort.rawValue) }
            return ("session_updated", body)

        case .itemUserMessage(let message):
            var body: [String: JunoJSONValue] = ["text": .string(message.text)]
            if message.delivery == .steer || message.delivery == .queue {
                body["delivery"] = .string(message.delivery.rawValue)
            }
            return ("user_message", body)

        case .itemAssistantText(let text):
            return ("text_delta", ["text": .string(text.text)])

        case .itemThinking(let thinking):
            return ("reasoning_delta", ["text": .string(thinking.summary)])

        case .itemToolCall(let call):
            var body: [String: JunoJSONValue] = [
                "toolCallId": .string(call.itemId),
                "name": .string(call.toolName),
                "summary": .string(call.title),
            ]
            if let risk = call.risk { body["risk"] = .string(risk.rawValue) }
            return ("tool_start", body)

        case .itemToolOutput(let output):
            return (
                "command_output",
                [
                    "toolCallId": .string(output.itemId),
                    "channel": .string(output.channel.rawValue),
                    "text": .string(output.text),
                ]
            )

        case .itemToolResult(let result):
            return (
                "tool_result",
                [
                    "toolCallId": .string(result.itemId),
                    "status": .string(completionWord(result.status)),
                    "summary": .string(result.summary ?? ""),
                    "isError": .bool(result.status != .ok),
                    "durationSeconds": .number(Double(result.durationMs ?? 0) / 1000),
                ]
            )

        case .approvalRequested(let approval):
            return (
                "approval_request",
                [
                    "requestId": .string(approval.approvalId),
                    "summary": .string(approval.summary),
                    "risk": .string(approval.risk.rawValue),
                    "detail": .string(approval.action),
                ]
            )

        case .approvalResolved(let resolved):
            return (
                "approval_response",
                [
                    "requestId": .string(resolved.approvalId),
                    "approved": .bool(resolved.decision == .allowOnce || resolved.decision == .allowAlways),
                ]
            )

        case .itemFileChange(let change):
            var body: [String: JunoJSONValue] = [
                "path": .string(change.path),
                "changeKind": .string(change.change.rawValue),
                "linesAdded": .number(Double(change.linesAdded)),
                "linesRemoved": .number(Double(change.linesRemoved)),
            ]
            if let checkpoint = change.checkpointId { body["checkpointId"] = .string(checkpoint) }
            return ("file_change", body)

        case .itemTestRun(let run):
            var body: [String: JunoJSONValue] = [
                "status": .string(run.passed ? "passed" : "failed"),
                "detail": .string(run.command),
                "durationSeconds": .number(Double(run.durationMs ?? 0) / 1000),
            ]
            if let total = run.testsRun { body["total"] = .number(Double(total)) }
            if let failed = run.failures { body["failed"] = .number(Double(failed)) }
            return ("test_update", body)

        case .itemSubagent(let agent):
            var body: [String: JunoJSONValue] = [
                "id": .string(agent.itemId),
                "title": .string(agent.title),
                "status": .string(agent.status.rawValue),
            ]
            if let summary = agent.summary ?? agent.activity { body["summary"] = .string(summary) }
            return ("subagent_update", ["agent": .object(body)])

        case .planUpdated(let plan):
            // The goal's steps carry its objective. A checklist has none, and
            // spelled as a goal it would blank the phone's; it travels as the
            // canonical `todosUpdated` event instead.
            guard let objective = plan.objective else { return nil }
            return ("session_updated", ["goal": .string(objective)])

        case .sessionState(let state):
            return ("status_update", ["status": .string(relayWord(state.state))])

        case .sessionError(let failure):
            return (
                "error",
                ["message": .string(failure.error.message), "recoverable": .bool(failure.error.retryable)]
            )

        case .turnCompleted(let completed):
            return (
                "completed",
                [
                    "summary": .string(completed.summary ?? ""),
                    "filesChanged": .number(Double(completed.filesChanged ?? 0)),
                    "durationSeconds": .number(Double(completed.durationMs ?? 0) / 1000),
                ]
            )

        case .itemCompaction(let compaction):
            return (
                "session_updated",
                ["compaction": .string("\(compaction.beforeMessages ?? 0) → \(compaction.afterMessages ?? 0) messages")]
            )

        case .itemNotice(let notice):
            // A quiet note, as a compaction is: which hook stepped in and why.
            var body: [String: JunoJSONValue] = ["hook": .string(notice.text)]
            if let detail = notice.detail { body["detail"] = .string(detail) }
            return ("session_updated", body)

        // Opened by the prompt's own row; spelled by the entries that follow.
        case .turnStarted, .turnFailed, .turnInterrupted, .transcriptRestarted,
             .itemAssistantTextDelta, .itemThinkingDelta, .questionAsked, .questionAnswered,
             .planProposed, .planResolved, .usageUpdated, .codePullRequest, .unknown:
            return nil

        // The autonomous loop (protocol v1.1) has no legacy spelling; the
        // protocol events travel beside the heartbeat for readers that speak it.
        case .runContinued, .runOutcome, .verifyResult, .verifyUi, .reviewFindings,
             .goalSet, .goalUpdated, .goalVerdict, .goalStatus, .checkinDue, .ciStatus,
             .budgetReached:
            return nil
        }
    }

    /// The relay's word for a session state. The relay knows six; the rest are
    /// working or waiting on somebody.
    static func relayWord(_ state: AgentSessionState) -> String {
        switch state {
        case .idle: "idle"
        case .running, .awaitingInput: "running"
        case .awaitingApproval: "awaiting_approval"
        case .completed: "completed"
        case .failed: "failed"
        case .cancelled, .interrupted: "interrupted"
        // A paused goal waits on the reader with nothing running; a run that
        // waits on background work is still working.
        case .paused: "idle"
        case .waitingBackground: "running"
        case .unknown: "running"
        }
    }

    /// The Swift completion words the relay has always carried.
    private static func completionWord(_ status: AgentToolResultStatus) -> String {
        switch status {
        case .ok: "succeeded"
        case .error: "failed"
        case .denied: "denied"
        case .notExecuted, .unknown: "cancelled"
        }
    }

    /// The protocol events, as JSON the relay stores, when they fit beside the
    /// legacy payload within the per-event budget.
    private static func carriedProtocol(
        _ events: [AgentEvent], beside payload: [String: JunoJSONValue]
    ) -> JunoJSONValue? {
        guard let values = try? events.map({ try decoder.decode(JunoJSONValue.self, from: AgentProtocolProjection.jsonData($0)) })
        else { return nil }
        let carried = JunoJSONValue.array(values)
        var combined = payload
        combined[protocolKey] = carried
        guard let size = try? encoder.encode(combined).count, size <= protocolPayloadBudget else { return nil }
        return carried
    }

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
}
