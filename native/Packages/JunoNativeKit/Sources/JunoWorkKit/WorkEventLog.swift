import Foundation
import JunoCore

/// What a run's log says, read as a person would read it: the plan and how far
/// it has got, what it is doing now, what it said, what it asked, and which of
/// the reader's instructions it has not reached yet.
///
/// Pure functions of the event list, shared by every surface that draws a run
/// — the chat's task card and its follower (``NativeConversationWork``), and
/// the Mac's legacy Tasks window until it goes — so two drawings of one run
/// cannot disagree about how far it has got. Moved here from the Mac's
/// `DesktopWorkLog`, which now forwards to it. Icons and tints are the app's:
/// nothing here knows how a state is drawn.
///
/// Every reader is defensive, for the reason the log is: `WorkEvent.payload` is
/// JSON written by an executor that may be a release ahead of this build, so a
/// field that is missing or the wrong type degrades to "no detail" rather than
/// dropping the event. The key names are the web's (`work-timeline.tsx`,
/// `work-conversation.tsx`, `work-decisions.tsx`, `pending-steers.tsx`),
/// because the executor writing them is the same one for every client.
public enum WorkEventLog {
    // MARK: Reading

    private static func string(_ payload: [String: JunoJSONValue], _ keys: String...) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue else { continue }
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return value }
        }
        return nil
    }

    private static func fields(_ value: JunoJSONValue) -> [String: JunoJSONValue] {
        if case .object(let object) = value { return object }
        return [:]
    }

    /// The events a person is meant to see.
    ///
    /// `visibility` is the contract's own classification and the only correct
    /// filter: an operator or internal event is withheld because it may carry
    /// a raw tool payload. A kind this build does not know is dropped for the
    /// same reason — it cannot be classified, and an unclassified kind hides
    /// rather than leaks.
    static func visible(_ events: [WorkEvent]) -> [(WorkEvent, JunoWorkEventKind)] {
        events.compactMap { event in
            guard let kind = JunoWorkEventKind(rawValue: event.kind),
                kind.visibility == "user"
            else { return nil }
            return (event, kind)
        }
    }

    // MARK: Plan

    public enum StepState: Equatable, Sendable {
        case pending
        case active
        case done
        case skipped
        case failed
        /// The run stopped — finished, failed or paused — while this step was
        /// open. Never asserted by an executor; derived here, as the web's
        /// `derivePlan` does, so a step cannot keep turning under a run that
        /// is over. Drawn as a dashed ring with "never finished".
        case unreported

        /// The states an executor may assert. `unreported` is deliberately
        /// absent: it is this reader's conclusion, not a report.
        public init?(rawValue: String) {
            switch rawValue {
            case "pending": self = .pending
            case "active": self = .active
            case "done": self = .done
            case "skipped": self = .skipped
            case "failed": self = .failed
            default: return nil
            }
        }
    }

    public struct PlanStep: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let state: StepState

        public init(id: String, title: String, state: StepState) {
            self.id = id
            self.title = title
            self.state = state
        }
    }

    /// The current plan, rebuilt from the newest plan event and advanced by the
    /// step events that followed it.
    ///
    /// Rebuilt rather than patched: a re-plan can drop, reorder or rename
    /// steps, and merging two versions produces a list that was never anybody's
    /// plan. Then reconciled against the run being over, whatever order the
    /// executor wrote its last events in: a step still `active` once the run
    /// has finished, failed or paused is `unreported` — the web's rule, and the
    /// fix for a spinner that outlived its run.
    public static func plan(from events: [WorkEvent]) -> [PlanStep] {
        var steps: [PlanStep] = []
        var planSeq = -1

        for (event, kind) in visible(events) {
            guard kind == .planCreated || kind == .planUpdated else { continue }
            let payload = WorkEventPayload.fields(of: event)
            guard case .array(let raw)? = payload["steps"] ?? event.payload["steps"] else { continue }
            planSeq = event.seq
            steps = raw.enumerated().compactMap { index, entry in
                let step = fields(entry)
                guard let title = string(step, "title", "label", "summary") else { return nil }
                let state = string(step, "state", "status").flatMap(StepState.init(rawValue:))
                return PlanStep(
                    id: string(step, "id", "stepId") ?? "\(index)",
                    title: title,
                    state: state ?? .pending
                )
            }
        }

        guard !steps.isEmpty else { return steps }

        var byID = Dictionary(steps.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var ended = false
        for event in events where event.seq > planSeq {
            guard let kind = JunoWorkEventKind(rawValue: event.kind) else { continue }
            if kind == .runFinished || kind == .error || kind == .paused { ended = true }
            guard kind.visibility == "user" else { continue }
            guard let id = string(event.payload, "stepId", "id"), let step = byID[id] else {
                continue
            }
            switch kind {
            case .stepStarted:
                byID[id] = PlanStep(id: step.id, title: step.title, state: .active)
            case .stepFinished:
                let state = string(event.payload, "state", "status")
                    .flatMap(StepState.init(rawValue:)) ?? .done
                byID[id] = PlanStep(id: step.id, title: step.title, state: state)
            default:
                continue
            }
        }
        return steps.compactMap { byID[$0.id] }.map { step in
            guard ended, step.state == .active else { return step }
            return PlanStep(id: step.id, title: step.title, state: .unreported)
        }
    }

    /// "3/7": done and skipped count as behind the reader, the web's
    /// `planTally`. A step the run chose not to take is not work left.
    public static func tally(_ steps: [PlanStep]) -> (done: Int, total: Int) {
        (steps.filter { $0.state == .done || $0.state == .skipped }.count, steps.count)
    }

    // MARK: The answer

    /// The last thing the run said in prose — the one that answers the goal.
    public static func finalAnswer(in events: [WorkEvent]) -> String? {
        var answer: String?
        for (event, kind) in visible(events) where kind == .assistantMessage {
            let payload = WorkEventPayload.fields(of: event)
            guard let text = string(payload, "text", "message") else { continue }
            answer = text
        }
        return answer
    }

    // MARK: Conversation

    /// One side of the run's conversation.
    public struct Turn: Identifiable, Equatable, Sendable {
        public enum Role: Equatable, Sendable { case you, juno }
        public let id: String
        public let role: Role
        public let text: String
        /// True for something the reader volunteered rather than an answer to
        /// a question Juno asked.
        public let unprompted: Bool

        public init(id: String, role: Role, text: String, unprompted: Bool) {
            self.id = id
            self.role = role
            self.text = text
            self.unprompted = unprompted
        }
    }

    /// The readable conversation, pulled out of the log — `deriveTurns`, kind
    /// for kind. A `question_answered` row carrying `steering: true` is an
    /// instruction written before the vocabulary had a kind for it.
    public static func turns(in events: [WorkEvent]) -> [Turn] {
        var turns: [Turn] = []
        for (event, kind) in visible(events) {
            let payload = WorkEventPayload.fields(of: event)
            switch kind {
            case .assistantMessage:
                guard let text = string(payload, "text", "message") else { continue }
                turns.append(Turn(id: "\(event.id)", role: .juno, text: text, unprompted: false))
            case .questionAsked:
                guard let text = string(payload, "question", "text") else { continue }
                turns.append(Turn(id: "\(event.id)", role: .juno, text: text, unprompted: false))
            case .questionAnswered:
                guard let text = string(payload, "text", "answer") else { continue }
                let steering = payload["steering"]?.boolValue == true
                turns.append(Turn(id: "\(event.id)", role: .you, text: text, unprompted: steering))
            case .userMessage:
                guard let text = string(payload, "text") else { continue }
                turns.append(Turn(id: "\(event.id)", role: .you, text: text, unprompted: true))
            default:
                continue
            }
        }
        return turns
    }

    // MARK: Current action

    /// The action in flight. `title` is what the executor wrote; a tool call
    /// that wrote none carries its `tool` name for the app to put in words.
    public struct CurrentAction: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case tool, step }
        public let kind: Kind
        public let title: String?
        public let tool: String?
        public let detail: String?
        /// When it started, for the ticking duration beside it.
        public let startedAt: Date

        public init(kind: Kind, title: String?, tool: String?, detail: String?, startedAt: Date) {
            self.kind = kind
            self.title = title
            self.tool = tool
            self.detail = detail
            self.startedAt = startedAt
        }
    }

    /// The action in flight, or nil when nothing is.
    ///
    /// Cleared by the matching finish and by every terminal or blocking event:
    /// the failure this guards against is a banner still saying "Reading your
    /// Downloads folder" long after the run died.
    public static func currentAction(in events: [WorkEvent]) -> CurrentAction? {
        var current: CurrentAction?
        for (event, kind) in visible(events) {
            switch kind {
            case .toolStarted:
                current = CurrentAction(
                    kind: .tool,
                    title: string(event.payload, "summary", "title"),
                    tool: string(event.payload, "tool", "name"),
                    detail: string(event.payload, "detail", "target"),
                    startedAt: event.createdAt
                )
            case .stepStarted:
                current = CurrentAction(
                    kind: .step,
                    title: string(event.payload, "title", "label"),
                    tool: nil,
                    detail: nil,
                    startedAt: event.createdAt
                )
            case .toolFinished, .toolDenied, .stepFinished, .runFinished, .paused, .error,
                .questionAsked, .approvalRequested:
                current = nil
            default:
                continue
            }
        }
        return current
    }

    // MARK: Questions

    /// Every question the run asked and nobody has answered yet, oldest first
    /// — `deriveOpenQuestions`. The composer answers the first; the card offers
    /// each one's one-press replies.
    public static func openQuestions(in events: [WorkEvent]) -> [WorkQuestionPrompt] {
        var open: [String: WorkQuestionPrompt] = [:]
        var order: [String] = []
        for event in events {
            guard let kind = JunoWorkEventKind(rawValue: event.kind) else { continue }
            let payload = WorkEventPayload.fields(of: event)
            guard let id = WorkEventPayload.string(payload, "questionId", "id") else { continue }
            switch kind {
            case .questionAsked:
                guard let text = WorkEventPayload.string(payload, "question", "text", "prompt") else {
                    continue
                }
                let prompt = WorkQuestionPrompt(
                    questionID: id, text: text,
                    options: NativeWorkModel.questionOptions(payload["options"] ?? payload["choices"]),
                    why: WorkEventPayload.string(payload, "why", "reason"),
                    askedAt: event.createdAt
                )
                if open.updateValue(prompt, forKey: id) == nil { order.append(id) }
            case .questionAnswered:
                open.removeValue(forKey: id)
            default:
                continue
            }
        }
        return order.compactMap { open[$0] }
    }

    // MARK: Pending steers

    /// An instruction the reader gave a running task that it has not visibly
    /// acted on yet.
    public struct PendingSteer: Identifiable, Equatable, Sendable {
        public let id: Int
        public let text: String
        public let at: Date

        public init(id: Int, text: String, at: Date) {
            self.id = id
            self.text = text
            self.at = at
        }
    }

    /// The steers the run has not taken a turn on — `derivePendingSteers`.
    ///
    /// Walked back from the end: the first `assistant_message` or
    /// `step_started` met going back is the run having spoken, and every
    /// `user_message` after it is still queued. `question_answered` is not a
    /// boundary — an answer unblocks the run, it is not the run taking a turn.
    /// Oldest first, the order the run will read them in.
    public static func pendingSteers(in events: [WorkEvent]) -> [PendingSteer] {
        var pending: [PendingSteer] = []
        for (event, kind) in visible(events).reversed() {
            if kind == .assistantMessage || kind == .stepStarted { break }
            guard kind == .userMessage else { continue }
            let payload = WorkEventPayload.fields(of: event)
            guard let text = string(payload, "text", "instruction", "message") else { continue }
            pending.append(PendingSteer(id: event.seq, text: text, at: event.createdAt))
        }
        return pending.reversed()
    }

    // MARK: Artifacts

    /// How many files the run has said it made or changed, for knowing when the
    /// artifact list is worth reading again (the web's `deriveArtifacts`
    /// length, which keys its refetch).
    public static func producedArtifactCount(in events: [WorkEvent]) -> Int {
        visible(events).filter { $0.1 == .artifactCreated || $0.1 == .artifactUpdated }.count
    }
}
