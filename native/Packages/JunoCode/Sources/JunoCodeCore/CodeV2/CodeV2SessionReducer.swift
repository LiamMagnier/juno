import Foundation

/// Folds env-server events into a session snapshot (SPEC §3.1).
///
/// The client keeps one ``CodeV2/SessionSnapshot`` per open session and a
/// cursor (the last applied `sequence`). ``apply(_:to:)`` is pure: it takes an
/// envelope, decides with ``CodeV2/classify(cursor:sequence:event:)`` whether
/// it applies, and returns the new state and what the caller must do next — in
/// particular, re-open the session after a gap rather than render a thread
/// with a hole in it.
public struct CodeV2SessionState: Equatable, Sendable {
    public var snapshot: CodeV2.SessionSnapshot
    /// Last applied sequence; nil until the first snapshot.
    public var cursor: Int?
    /// The outcome of the last finished turn, for the composer's settle.
    public var lastOutcome: CodeV2.TurnOutcome?
    /// A message the server attached to the latest state change.
    public var stateMessage: String?

    public init(snapshot: CodeV2.SessionSnapshot, cursor: Int? = nil) {
        self.snapshot = snapshot
        self.cursor = cursor
    }

    public var items: [CodeV2.TurnItem] { snapshot.items }

    public func item(_ id: String) -> CodeV2.TurnItem? {
        snapshot.items.first { $0.id == id }
    }
}

public enum CodeV2SessionReducer {
    public enum Effect: Equatable, Sendable {
        case none
        /// Sequence gap: re-open with `afterSequence = cursor`.
        case reopen(afterSequence: Int?)
    }

    @discardableResult
    public static func apply(_ envelope: CodeV2.ServerEventEnvelope, to state: inout CodeV2SessionState) -> Effect {
        switch CodeV2.classify(cursor: state.cursor, sequence: envelope.sequence, event: envelope.event) {
        case .duplicate:
            return .none
        case .gap:
            return .reopen(afterSequence: state.cursor)
        case .apply:
            reduce(envelope.event, into: &state)
            state.cursor = envelope.sequence
            if case let .sessionSnapshot(sequence, _) = envelope.event {
                state.cursor = sequence
            }
            return .none
        }
    }

    /// Applies one event regardless of sequence (used for the snapshot itself
    /// and by tests).
    public static func reduce(_ event: CodeV2.ServerEvent, into state: inout CodeV2SessionState) {
        switch event {
        case let .sessionSnapshot(_, session):
            state.snapshot = session
        case let .sessionState(newState, resumeAt, message):
            state.snapshot.state = newState
            state.snapshot.resumeAt = resumeAt
            state.stateMessage = message
            if newState == .idle || newState == .error { state.snapshot.activeTurnId = nil }
        case let .turnStarted(turnId, selection):
            state.snapshot.activeTurnId = turnId
            state.snapshot.selection = selection
            state.snapshot.state = .running
            state.lastOutcome = nil
        case let .turnCompleted(turnId, outcome, usage):
            if state.snapshot.activeTurnId == turnId { state.snapshot.activeTurnId = nil }
            if let usage { state.snapshot.usage = usage }
            state.lastOutcome = outcome
            switch outcome {
            case .limited: state.snapshot.state = .limited
            case .failed: state.snapshot.state = .error
            case .completed, .interrupted:
                if state.snapshot.state == .running || state.snapshot.state == .waiting {
                    state.snapshot.state = .idle
                }
            }
            // A turn that ended leaves nothing streaming behind it.
            state.snapshot.items = state.snapshot.items.map { settle($0, turnId: turnId) }
        case let .itemAdded(item):
            if let index = state.snapshot.items.firstIndex(where: { $0.id == item.id }) {
                state.snapshot.items[index] = item
            } else {
                state.snapshot.items.append(item)
            }
            noteWaiting(item, in: &state)
        case let .itemUpdated(item):
            if let index = state.snapshot.items.firstIndex(where: { $0.id == item.id }) {
                state.snapshot.items[index] = item
            } else {
                state.snapshot.items.append(item)
            }
            noteWaiting(item, in: &state)
        case let .itemDelta(itemId, field, text):
            guard let index = state.snapshot.items.firstIndex(where: { $0.id == itemId }) else { return }
            state.snapshot.items[index] = appending(text, to: field, of: state.snapshot.items[index])
        case let .queueUpdated(queue):
            state.snapshot.queue = queue
        case let .usageUpdated(usage):
            state.snapshot.usage = usage
        case let .sessionScheduled(schedule):
            state.snapshot.scheduledResume = schedule
        case let .sessionSkills(skills):
            // The thread's selection, set on any device (empty: cleared).
            state.snapshot.skills = skills.isEmpty ? nil : skills
        case .providerUpdated, .terminalOutput, .terminalExited, .skillsUpdated, .unknown:
            break
        }
    }

    /// An approval or question arriving puts the session in `waiting` even if
    /// the server's own state event is a beat behind.
    private static func noteWaiting(_ item: CodeV2.TurnItem, in state: inout CodeV2SessionState) {
        switch item {
        case let .approvalRequest(request) where request.status == .pending:
            state.snapshot.state = .waiting
        case let .userInputRequest(request) where request.status == .pending:
            state.snapshot.state = .waiting
        case .approvalRequest, .userInputRequest:
            if state.snapshot.state == .waiting, CodeV2TurnFolding.pendingRequests(in: state.snapshot.items).isEmpty {
                state.snapshot.state = state.snapshot.activeTurnId == nil ? .idle : .running
            }
        default:
            break
        }
    }

    static func appending(_ text: String, to field: String, of item: CodeV2.TurnItem) -> CodeV2.TurnItem {
        switch item {
        case var .assistantMessage(message) where field == "text":
            message.text += text
            return .assistantMessage(message)
        case var .reasoning(reasoning) where field == "text":
            reasoning.text += text
            return .reasoning(reasoning)
        case var .plan(plan) where field == "text":
            plan.text += text
            return .plan(plan)
        case var .commandExecution(command) where field == "output":
            command.output = (command.output ?? "") + text
            return .commandExecution(command)
        default:
            return item
        }
    }

    static func settle(_ item: CodeV2.TurnItem, turnId: String) -> CodeV2.TurnItem {
        switch item {
        case var .assistantMessage(message) where message.turnId == turnId && message.streaming:
            message.streaming = false
            return .assistantMessage(message)
        case var .reasoning(reasoning) where reasoning.turnId == turnId && reasoning.streaming:
            reasoning.streaming = false
            return .reasoning(reasoning)
        default:
            return item
        }
    }
}
