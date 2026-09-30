import Foundation
import JunoCodeCore

/// Keeps the model-facing history in the one shape every provider accepts:
/// each run of tool calls is followed immediately by exactly one result per
/// call, before any other user or assistant turn.
///
/// Anthropic and OpenAI both reject a request whose history breaks that rule
/// with a 400, and because the broken history is what gets persisted, every
/// later turn of the session fails the same way. Three paths used to produce
/// it — a steer applied between tool waves, a goal ending mid-batch, and a
/// cancellation while tools ran — so the orchestrator now repairs before every
/// request and on restore rather than trusting each path to be perfect.
public enum ConversationIntegrity {
    /// The result recorded for a call the run never executed.
    public static let notExecutedMessage =
        "Not executed: the run was interrupted before this tool ran."

    /// The result recorded for a call that began and whose result was never
    /// recorded: the app stopped while it ran. It may have finished, half
    /// finished or not got far — a commit made, a migration applied, a file
    /// half written — and "Not executed" would invite the model to run it
    /// again blind.
    public static let outcomeUnknownMessage =
        "Outcome unknown: the app stopped while this was running; check the workspace before retrying."

    /// What the transcript knows about a call whose result never reached the
    /// model history, because the app stopped part-way through its batch.
    public enum InterruptedCall: Equatable, Sendable {
        /// It began executing and nothing more was recorded.
        case started
        /// It finished, and the transcript has the first line of its result;
        /// the app stopped before the whole result was saved.
        case finished(succeeded: Bool, summary: String)
        /// It was refused or stopped before it ran.
        case notRun(summary: String)
    }

    /// The state of every call in `events` that was proposed, from its latest
    /// proposal on: a call id a later turn used again starts over.
    public static func interruptedCalls(in events: [SessionEvent]) -> [String: InterruptedCall] {
        var states: [String: InterruptedCall] = [:]
        for event in events {
            switch event.payload {
            case let .toolProposed(proposed):
                states.removeValue(forKey: proposed.toolCallID)
            case let .toolStarted(started):
                states[started.toolCallID] = .started
            case let .toolCompleted(completed):
                switch completed.status {
                case .succeeded, .failed:
                    states[completed.toolCallID] = .finished(
                        succeeded: completed.status == .succeeded,
                        summary: completed.resultSummary
                    )
                case .denied, .cancelled:
                    states[completed.toolCallID] = .notRun(summary: completed.resultSummary)
                }
            default:
                continue
            }
        }
        return states
    }

    /// The result a call with no recorded result is given, from what the
    /// transcript says became of it.
    static func synthesizedResult(for id: String, state: InterruptedCall?) -> ModelMessage {
        switch state {
        case nil:
            return .toolResult(id: id, content: notExecutedMessage, isError: true)
        case .started:
            return .toolResult(id: id, content: outcomeUnknownMessage, isError: true)
        case let .finished(succeeded, summary):
            return .toolResult(
                id: id,
                content: "The app stopped before this result was saved. The tool \(succeeded ? "finished" : "failed"); its output began: \(summary)\nCheck the workspace before relying on it.",
                isError: !succeeded
            )
        case let .notRun(summary):
            return .toolResult(id: id, content: "Not executed: \(summary)", isError: true)
        }
    }

    /// Returns `messages` with every tool-call run completed by its results.
    ///
    /// - Missing results are synthesized as errors, in call order: "Not
    ///   executed" for a call that never ran, and — when `interrupted` says a
    ///   call began or finished before the app stopped — what is known of it.
    /// - User turns found between a call run and its results move after them.
    /// - Results that answer no preceding call are dropped.
    public static func repaired(
        _ messages: [ModelMessage],
        interrupted: [String: InterruptedCall] = [:]
    ) -> [ModelMessage] {
        var output: [ModelMessage] = []
        output.reserveCapacity(messages.count)
        var index = 0

        while index < messages.count {
            let message = messages[index]
            guard message.isAssistantSide else {
                // A result with no open call run above it answers nothing.
                if message.toolResultID == nil {
                    output.append(message)
                }
                index += 1
                continue
            }

            // One model turn: its reasoning, text and calls, in whatever order
            // the provider streamed them. Adaptive thinking puts reasoning
            // *between* calls, so the turn ends at the first non-model item,
            // not the first non-call.
            var callIDs: [String] = []
            while index < messages.count, messages[index].isAssistantSide {
                output.append(messages[index])
                if let id = messages[index].toolCallID { callIDs.append(id) }
                index += 1
            }
            guard !callIDs.isEmpty else { continue }

            var results: [String: ModelMessage] = [:]
            var deferred: [ModelMessage] = []
            while index < messages.count {
                let next = messages[index]
                if next.isAssistantSide { break }
                if let resultID = next.toolResultID {
                    if callIDs.contains(resultID), results[resultID] == nil {
                        results[resultID] = next
                    }
                } else {
                    deferred.append(next)
                }
                index += 1
            }

            for id in callIDs {
                output.append(
                    results[id] ?? synthesizedResult(for: id, state: interrupted[id])
                )
            }
            output.append(contentsOf: deferred)
        }
        return output
    }

    /// Whether `messages` already satisfies the invariant.
    public static func isValid(_ messages: [ModelMessage]) -> Bool {
        repaired(messages) == messages
    }

    /// Results for the calls in `calls` that are absent from `executed`, so a
    /// batch cut short still answers every call it was handed.
    static func skippedResults(
        for callIDs: [String],
        executed: Set<String>
    ) -> [ModelMessage] {
        callIDs
            .filter { !executed.contains($0) }
            .map { .toolResult(id: $0, content: notExecutedMessage, isError: true) }
    }
}

extension ModelMessage {
    var toolCallID: String? {
        switch self {
        case let .toolCall(id, _, _), let .toolCallWithExtra(id, _, _, _):
            id
        default:
            nil
        }
    }

    var toolResultID: String? {
        switch self {
        case let .toolResult(id, _, _), let .toolResultWithImages(id, _, _, _):
            id
        default:
            nil
        }
    }

    /// Anything the model authored: text, reasoning, or a tool call.
    var isAssistantSide: Bool {
        switch self {
        case .assistant, .assistantThinking, .assistantRedactedThinking, .toolCall, .toolCallWithExtra:
            true
        default:
            false
        }
    }
}
