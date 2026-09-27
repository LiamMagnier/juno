import Foundation
import JunoCore

// What an agent's page reads out of its tasks' runs: the gates a waiting task
// is stopped at, and what its latest run did on its computer.
//
// Both come from one read of each run (`NativeWorkClient.snapshot`), the same
// frame a task's thread starts from, so an approval answered on the page is
// the one the thread shows and a question asked here is the thread's question.
// Nothing in this file talks to the network; the model does the reading and
// hands the frames here.

// MARK: - Gates

/// What one of an agent's waiting tasks is stopped at.
public struct NativeAgentGate: Identifiable, Equatable, Sendable {
    public var id: String { task.sessionID }
    public let task: NativeAgentTask
    /// The run the gate belongs to. A run executing on this Mac raises its
    /// approvals in-process rather than as a server row, and those are keyed
    /// on the run, so this is what finds them.
    public let runID: String?
    /// Pending approvals, oldest first: a run asks in the order it needs
    /// answers, and showing the newest first makes the person answer backwards.
    public var approvals: [WorkApprovalRequest]
    public var question: WorkQuestionPrompt?

    public init(
        task: NativeAgentTask,
        runID: String?,
        approvals: [WorkApprovalRequest],
        question: WorkQuestionPrompt?
    ) {
        self.task = task
        self.runID = runID
        self.approvals = approvals
        self.question = question
    }

    /// Nothing on it can be answered here — the page says where to answer
    /// instead.
    public var isEmpty: Bool { approvals.isEmpty && question == nil }

    /// A task stopped for the person, by the same test the Now tab has always
    /// used: the server's own flag, or a status that says it is waiting.
    public static func isWaiting(_ task: NativeAgentTask) -> Bool {
        task.needsAttention || task.status == "waiting_input" || task.status == "waiting_approval"
    }

    /// The gate a run's snapshot describes.
    ///
    /// `hidingApprovals` holds the approvals answered from this device or
    /// being answered now, and `answeredQuestions` the questions answered from
    /// it. A read that left before an answer landed still carries them, and
    /// drawing them again would read as the tap not having worked. A question
    /// whose reply is still travelling stays: its card holds the reply.
    public static func read(
        _ update: WorkStreamUpdate,
        task: NativeAgentTask,
        hidingApprovals: Set<String> = [],
        answeredQuestions: Set<String> = [],
        now: Date = Date()
    ) -> NativeAgentGate {
        let approvals = update.approvals
            .filter { $0.isAnswerable(at: now) && !hidingApprovals.contains($0.approvalID) }
            // Every approval is minted with the same time to live, so the one
            // that expires first is the one that was asked first.
            .sorted { $0.expiresAt < $1.expiresAt }
        var question = NativeWorkModel.pendingQuestion(in: update.events)
        if let asked = question, answeredQuestions.contains(asked.questionID) {
            question = nil
        }
        let runID = update.run?.runID ?? update.session?.currentRunID
        return NativeAgentGate(task: task, runID: runID, approvals: approvals, question: question)
    }

    /// The task as the run now describes it. The roster's copy is up to a
    /// minute old, and a task answered elsewhere should stop reading as waiting
    /// the moment its run says so.
    public static func current(_ task: NativeAgentTask, from session: WorkSessionSummary?) -> NativeAgentTask {
        guard let session, session.sessionID == task.sessionID else { return task }
        return NativeAgentTask(
            sessionID: task.sessionID,
            title: task.title,
            status: session.status,
            needsAttention: session.needsAttention,
            lastActivityAt: session.lastActivityAt,
            conversationID: task.conversationID
        )
    }
}

// MARK: - Its computer

/// One call the run made, told in words (AGENTS.md §5.2) as the fallback
/// activity feed under "Its computer" when the agent does not have a dedicated
/// cloud computer enabled.
public struct NativeAgentComputerLine: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case running
        case done
        case failed
        case refused
        /// The run ended with the call still open.
        case unreported
    }

    /// The sequence of the event that opened the call.
    public let id: Int
    public let title: String
    public let state: State
    public let at: Date

    public init(id: Int, title: String, state: State, at: Date) {
        self.id = id
        self.title = title
        self.state = state
        self.at = at
    }
}

/// An agent's latest run, as its page shows it.
public struct NativeAgentComputer: Equatable, Sendable {
    public let sessionID: String
    /// The run has not finished, so the lines can still move.
    public let isLive: Bool
    public let lines: [NativeAgentComputerLine]

    public init(sessionID: String, isLive: Bool, lines: [NativeAgentComputerLine]) {
        self.sessionID = sessionID
        self.isLive = isLive
        self.lines = lines
    }

    /// The latest run of a task, read from its snapshot. `status` is the
    /// task's own when the snapshot carries no session.
    public static func read(_ update: WorkStreamUpdate, sessionID: String, status: String) -> NativeAgentComputer {
        let current = update.session?.status ?? status
        let isLive = JunoWorkStatus(rawValue: current).map { !$0.isTerminal } ?? false
        return NativeAgentComputer(
            sessionID: sessionID,
            isLive: isLive,
            lines: NativeAgentComputerFeed.lines(from: update.events)
        )
    }
}

/// The calls a run made, paired start to end, newest last.
///
/// A mirror of the web's `deriveActivity` cut down to what the page shows:
/// tool calls only, one line each, no step groups. A start and its end are
/// paired by call id, or — where the Mac writes an ending with no id — by the
/// newest open call of the same tool, so a refused local call does not leave
/// its line running for the rest of the run.
public enum NativeAgentComputerFeed {
    /// How many lines the page shows: the latest few, enough to say what it is
    /// doing without becoming the run's log, which lives in its thread.
    public static let visibleLines = 6

    public static func lines(from events: [WorkEvent], limit: Int = visibleLines) -> [NativeAgentComputerLine] {
        var calls: [Call] = []
        // Indices into `calls` of the ones still waiting for their ending.
        var open: [Int] = []

        for event in events {
            guard let kind = JunoWorkEventKind(rawValue: event.kind), kind.visibility == "user" else {
                continue
            }
            let payload = WorkEventPayload.fields(of: event)
            let tool = WorkEventPayload.string(payload, "tool", "name")
            let callID = WorkEventPayload.string(payload, "callId", "toolCallId")
            switch kind {
            case .toolStarted:
                let call = Call(
                    seq: event.seq,
                    tool: tool,
                    callID: callID,
                    summary: WorkEventPayload.string(payload, "summary", "title"),
                    state: .running,
                    at: event.createdAt
                )
                calls.append(call)
                open.append(calls.count - 1)
            case .toolFinished, .toolDenied:
                let state = endState(kind: kind, payload: payload)
                if let index = takeOpen(&open, calls: calls, callID: callID, tool: tool) {
                    calls[index].state = state
                } else {
                    let call = Call(
                        seq: event.seq,
                        tool: tool,
                        callID: callID,
                        summary: WorkEventPayload.string(payload, "summary"),
                        state: state,
                        at: event.createdAt
                    )
                    calls.append(call)
                }
            case .runFinished, .error, .paused:
                // A call that never reported back is said to have not, rather
                // than left running on the record of a run that stopped.
                for index in open {
                    calls[index].state = .unreported
                }
                open.removeAll()
            default:
                continue
            }
        }

        let shown = calls.suffix(max(0, limit))
        return shown.map { call in
            NativeAgentComputerLine(id: call.seq, title: call.title, state: call.state, at: call.at)
        }
    }

    /// One call while it is being paired.
    private struct Call {
        let seq: Int
        let tool: String?
        let callID: String?
        let summary: String?
        var state: NativeAgentComputerLine.State
        let at: Date

        /// The executor's own sentence when it wrote one; otherwise the tool
        /// in the tense its state calls for. A refused call is named as the
        /// action it asked for — the row itself says it was refused.
        var title: String {
            if let summary { return summary }
            switch state {
            case .running, .unreported:
                return JunoWorkVocabulary.toolPresent(tool)
            case .done, .failed:
                return JunoWorkVocabulary.toolPast(tool)
            case .refused:
                return JunoWorkVocabulary.action(tool)
            }
        }
    }

    private static func endState(
        kind: JunoWorkEventKind,
        payload: [String: JunoJSONValue]
    ) -> NativeAgentComputerLine.State {
        if kind == .toolDenied { return .refused }
        if payload["isError"]?.boolValue == true { return .failed }
        return .done
    }

    /// Removes and returns the open call this ending belongs to: by call id
    /// where there is one, otherwise the newest open call of the same tool.
    private static func takeOpen(
        _ open: inout [Int],
        calls: [Call],
        callID: String?,
        tool: String?
    ) -> Int? {
        var position = open.count - 1
        while position >= 0 {
            let candidate = calls[open[position]]
            let matches: Bool
            if let callID {
                matches = candidate.callID == callID
            } else {
                matches = tool == nil || candidate.tool == tool
            }
            if matches {
                return open.remove(at: position)
            }
            position -= 1
        }
        return nil
    }
}
