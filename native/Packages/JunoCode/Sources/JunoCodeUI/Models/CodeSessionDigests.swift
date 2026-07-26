import Foundation
import JunoCodeCore

/// Pure derivations over one session's transcript.
///
/// The runtime records what happened as ordered events and nothing else: there is
/// no sub-agent table and no index from a test result to the output it produced.
/// Deriving both from the transcript — rather than keeping a parallel set of
/// counters that could disagree with it — is what makes the Activity and Console
/// surfaces incapable of showing a state the session never reached.

// MARK: - Sub-agents

/// One delegated task, reconstructed from the parent transcript.
///
/// `CodeSession` has no `parentSessionID`, so a sub-agent's own session is
/// correlated through the `Sub-agent session: <id>` line `DelegateTaskTool`
/// returns as the first line of its result — which the orchestrator stores
/// verbatim as `ToolCompletedEvent.resultSummary`. There is no live child status
/// locally, which is why `state` here describes the *delegating call*, and the
/// child's own status is loaded separately from the store.
public struct SubagentRun: Identifiable, Sendable, Equatable {
    public enum State: Equatable, Sendable {
        /// Proposed, and waiting on authorization or an approval.
        case pending
        case running
        case finished(ToolCompletionStatus)
    }

    public var id: String { toolCallID }
    public let toolCallID: String
    public let title: String
    public let task: String
    public let role: AgentRole?
    public let state: State
    /// The child session, when the delegation got far enough to create one.
    public let childSessionID: CodeSessionID?
    public let resultSummary: String?
    public let durationSeconds: Double?
    public let proposedAt: Date
}

public enum SubagentDigest {
    public static let toolName = "delegate_task"
    /// The exact prefix `DelegateTaskTool` writes; changing one without the
    /// other silently breaks the only correlation that exists.
    static let sessionMarker = "Sub-agent session:"

    public static func runs(in events: [SessionEvent]) -> [SubagentRun] {
        var order: [String] = []
        var proposals: [String: (proposed: ToolProposedEvent, at: Date)] = [:]
        var startedCallIDs: Set<String> = []
        var completions: [String: ToolCompletedEvent] = [:]

        for event in events {
            switch event.payload {
            case let .toolProposed(proposed) where proposed.toolName == toolName:
                order.append(proposed.toolCallID)
                proposals[proposed.toolCallID] = (proposed, event.timestamp)
            case let .toolStarted(started):
                startedCallIDs.insert(started.toolCallID)
            case let .toolCompleted(completed):
                completions[completed.toolCallID] = completed
            default:
                break
            }
        }

        return order.compactMap { toolCallID in
            guard let proposal = proposals[toolCallID] else { return nil }
            let input = proposal.proposed.input
            let task = input["task"]?.stringValue ?? proposal.proposed.summary
            let completion = completions[toolCallID]
            let state: SubagentRun.State
            if let completion {
                state = .finished(completion.status)
            } else if startedCallIDs.contains(toolCallID) {
                state = .running
            } else {
                state = .pending
            }
            let rawRole: String? = input["role"]?.stringValue
            return SubagentRun(
                toolCallID: toolCallID,
                title: title(fromInput: input, task: task),
                task: task,
                role: rawRole.flatMap(AgentRole.init(rawValue:)),
                state: state,
                childSessionID: completion.flatMap {
                    childSessionID(in: $0.resultSummary)
                },
                resultSummary: completion?.resultSummary,
                durationSeconds: completion?.durationSeconds,
                proposedAt: proposal.at
            )
        }
    }

    /// The child session id carried in a `delegate_task` result summary, or
    /// `nil` when the call was denied, cancelled or failed before creating one.
    public static func childSessionID(in resultSummary: String) -> CodeSessionID? {
        guard let range = resultSummary.range(of: sessionMarker) else { return nil }
        let value = resultSummary[range.upperBound...]
            .drop(while: \.isWhitespace)
            .prefix(while: { !$0.isWhitespace })
        guard !value.isEmpty else { return nil }
        return CodeSessionID(value: String(value))
    }

    private static func title(fromInput input: JSONValue, task: String) -> String {
        let requested = input["title"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let requested, !requested.isEmpty {
            return requested
        }
        let firstLine = task.split(separator: "\n").first.map(String.init) ?? task
        return String(firstLine.prefix(80))
    }
}

/// One sub-agent session as the store holds it: its real status, its result, and
/// the tool calls it made. Loaded on demand — a child's transcript is a separate
/// session and is not mirrored into the parent's event list.
public struct SubagentDetail: Sendable, Equatable {
    public struct Step: Identifiable, Sendable, Equatable {
        public var id: String { toolCallID }
        public let toolCallID: String
        public let summary: String
        public let status: ToolCompletionStatus?
    }

    public let session: CodeSession
    public let answer: String?
    public let steps: [Step]

    public init(session: CodeSession, events: [SessionEvent]) {
        self.session = session
        var answer: String?
        var order: [String] = []
        var summaries: [String: String] = [:]
        var statuses: [String: ToolCompletionStatus] = [:]
        for event in events {
            switch event.payload {
            case let .assistantMessage(message):
                answer = message.text
            case let .toolProposed(proposed):
                order.append(proposed.toolCallID)
                summaries[proposed.toolCallID] = proposed.summary
            case let .toolCompleted(completed):
                statuses[completed.toolCallID] = completed.status
            default:
                break
            }
        }
        self.answer = answer
        self.steps = order.compactMap { id in
            guard let summary = summaries[id] else { return nil }
            return Step(toolCallID: id, summary: summary, status: statuses[id])
        }
    }
}

// MARK: - Test runs

// MARK: - In-flight tools

public enum CodeToolDigest {
    /// The tool calls that have started and not yet completed.
    ///
    /// Derived rather than counted, for the reason stated at the top of this
    /// file: a parallel counter can disagree with the transcript, and the
    /// transcript is what the reader is looking at. A call is in flight when a
    /// `toolStarted` has no matching `toolCompleted` — which is also how a run
    /// interrupted by a crash or a stop reads, correctly, as no longer running
    /// once its completion event lands.
    public static func runningToolCallIDs(in events: [SessionEvent]) -> Set<String> {
        var running: Set<String> = []
        for event in events {
            switch event.payload {
            case let .toolStarted(started):
                running.insert(started.toolCallID)
            case let .toolCompleted(completed):
                running.remove(completed.toolCallID)
            default:
                break
            }
        }
        return running
    }
}

public enum CodeTestDigest {
    /// The most recent test run, with the tool call that produced it.
    ///
    /// `TestRunCompletedEvent` carries no tool-call identifier, so the only
    /// honest correlation is position: the runtime appends a tool's side effects
    /// while that call is still open, so the run belongs to whichever call had
    /// started and not yet completed.
    public static func lastTestRun(
        in events: [SessionEvent]
    ) -> (run: TestRunCompletedEvent, toolCallID: String?)? {
        var openToolCallID: String?
        var result: (run: TestRunCompletedEvent, toolCallID: String?)?
        for event in events {
            switch event.payload {
            case let .toolStarted(started):
                openToolCallID = started.toolCallID
            case let .toolCompleted(completed):
                if openToolCallID == completed.toolCallID {
                    openToolCallID = nil
                }
            case let .testRunCompleted(run):
                result = (run, openToolCallID)
            default:
                break
            }
        }
        return result
    }
}

// MARK: - Controller conveniences

public extension SessionController {
    /// Delegated tasks in this session, derived from the transcript.
    var subagents: [SubagentRun] { SubagentDigest.runs(in: events) }
}
