import Foundation
import JunoCore

/// What a run's log says, read as a person would read it: the plan and how far
/// it has got, what it is doing now, what it said, what it asked, and which of
/// the reader's instructions it has not reached yet.
///
/// Pure functions of the event list, shared by every surface that draws a run
/// — the chat's task card, its follower (``NativeConversationWork``) and the
/// Task panel — so two drawings of one run cannot disagree about how far it
/// has got. Moved here from the Mac's `DesktopWorkLog` (Phase 5 A2, and the
/// rest in Stage D, when the old Work window went). Icons and tints are the
/// app's: nothing here knows how a state is drawn.
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

    // MARK: What it changed

    /// One thing the run did that left a mark outside Juno.
    public struct PerformedAction: Identifiable, Equatable, Sendable {
        public let id: Int
        public let summary: String
        public let at: Date
        /// True for the ones the reader personally allowed.
        public let approved: Bool

        public init(id: Int, summary: String, at: Date, approved: Bool) {
            self.id = id
            self.summary = summary
            self.at = at
            self.approved = approved
        }
    }

    /// What the run changed, and how many calls never said either way.
    public struct PerformedActions: Equatable, Sendable {
        public let actions: [PerformedAction]
        /// Tool calls that finished without saying whether they changed
        /// anything: counted, never assumed either way. A Mac run reports
        /// neither a risk nor a mutating flag, so on a local run this is every
        /// call it made.
        public let unclassified: Int

        public init(actions: [PerformedAction], unclassified: Int) {
            self.actions = actions
            self.unclassified = unclassified
        }

        public static let none = PerformedActions(actions: [], unclassified: 0)
    }

    /// The subset of the run that changed something outside Juno — the web's
    /// `derivePerformedActions`, rule for rule.
    ///
    /// A tool call counts when it said so: `mutating: true` at face value,
    /// otherwise the risk the executor gave it on the *start* event (anything
    /// but `safe`), joined to the finish on the call id. A call that failed
    /// changed nothing worth undoing. Approvals are joined on their id, since
    /// a resolution carries only the id and the decision.
    ///
    /// - Parameters:
    ///   - toolPresent: a tool's name as a present-tense phrase, for a call
    ///     that wrote no summary of its own.
    ///   - toolPast: the same in the past tense, for a finished call.
    public static func performedActions(
        in events: [WorkEvent],
        toolPresent: (String?) -> String = WorkEventLog.humanizedTool,
        toolPast: (String?) -> String = WorkEventLog.humanizedTool
    ) -> PerformedActions {
        var actionByApproval: [String: String] = [:]
        var approvedActions: Set<String> = []
        for event in events {
            guard let kind = JunoWorkEventKind(rawValue: event.kind) else { continue }
            let payload = WorkEventPayload.fields(of: event)
            guard let approvalID = string(payload, "approvalId", "requestId", "id") else { continue }
            if kind == .approvalRequested {
                if let action = string(payload, "action") { actionByApproval[approvalID] = action }
                continue
            }
            guard kind == .approvalResolved else { continue }
            let decision = string(payload, "decision")
            let action = string(payload, "action") ?? actionByApproval[approvalID]
            if let action, let decision, decision.hasPrefix("allowed") {
                approvedActions.insert(action)
            }
        }

        struct Started {
            let title: String
            let mutating: Bool?
            let action: String?
        }
        var started: [String: Started] = [:]
        var actions: [PerformedAction] = []
        var unclassified = 0

        for (event, kind) in visible(events) {
            let payload = WorkEventPayload.fields(of: event)
            switch kind {
            case .toolStarted:
                guard let callID = string(payload, "callId", "toolCallId") else { continue }
                let risk = string(payload, "risk")
                started[callID] = Started(
                    title: string(payload, "summary") ?? toolPresent(string(payload, "tool", "name")),
                    mutating: payload["mutating"]?.boolValue ?? risk.map { $0 != "safe" },
                    action: string(payload, "action")
                )
            case .filesChanged, .batchApplied, .batchUndone, .artifactCreated, .artifactUpdated:
                actions.append(PerformedAction(
                    id: event.seq, summary: markTitle(kind, payload), at: event.createdAt, approved: false
                ))
            case .toolFinished:
                if payload["isError"]?.boolValue == true { continue }
                let callID = string(payload, "callId", "toolCallId")
                let start = callID.flatMap { started[$0] }
                guard let mutating = payload["mutating"]?.boolValue ?? start?.mutating else {
                    unclassified += 1
                    continue
                }
                guard mutating else { continue }
                let action = string(payload, "action") ?? start?.action
                actions.append(PerformedAction(
                    id: event.seq,
                    summary: string(payload, "summary") ?? start?.title
                        ?? toolPast(string(payload, "tool", "name")),
                    at: event.createdAt,
                    approved: action.map { approvedActions.contains($0) } ?? false
                ))
            default:
                continue
            }
        }
        return PerformedActions(actions: actions, unclassified: unclassified)
    }

    /// A tool's name in words when nothing better is known: `read_file` →
    /// "Read file".
    public static func humanizedTool(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "Did something" }
        return WorkApprovalWords.humanize(name)
    }

    /// The title of an event that left a mark, as the log words it.
    private static func markTitle(_ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue]) -> String {
        func count(_ key: String) -> Int? {
            if let value = payload[key]?.numberValue { return Int(value) }
            if case .array(let items)? = payload[key] { return items.count }
            return nil
        }
        func changes(_ n: Int) -> String { n == 1 ? "1 change" : "\(n) changes" }
        switch kind {
        case .filesChanged:
            let changed = count("files") ?? count("count")
            return changed.map { $0 == 1 ? "1 file changed" : "\($0) files changed" } ?? "Changed files"
        case .batchApplied:
            return (count("items") ?? count("count")).map { "Applied \(changes($0))" }
                ?? "Applied a batch of changes"
        case .batchUndone:
            return (count("reversedCount") ?? count("count")).map { "Undid \(changes($0))" }
                ?? "Undid a batch of changes"
        case .artifactCreated:
            return "Created \(string(payload, "title") ?? "a file")"
        case .artifactUpdated:
            return "Updated \(string(payload, "title") ?? "a file")"
        default:
            return string(payload, "summary", "title") ?? "Changed something"
        }
    }

    // MARK: Artifacts

    /// How many files the run has said it made or changed, for knowing when the
    /// artifact list is worth reading again (the web's `deriveArtifacts`
    /// length, which keys its refetch).
    public static func producedArtifactCount(in events: [WorkEvent]) -> Int {
        visible(events).filter { $0.1 == .artifactCreated || $0.1 == .artifactUpdated }.count
    }
}

// MARK: - The log, line by line

/// The rest of what the Mac's old Work window read out of a run's log, moved
/// here when Phase 5 Stage D removed the window (`DesktopWorkLog`): every
/// visible event as a sentence, what the run read and wrote, whether a batch
/// of changes still stands, and the work between two turns. The chat's Task
/// panel reads the first two; the phone keeps its own copy
/// (`JunoMobileWorkView`).
///
/// The words are the Mac's; the marks are semantic (``Entry/Mark``) and the
/// app draws them, since nothing here knows how a state is drawn.
extension WorkEventLog {
    // MARK: Reading, continued

    private static func number(_ payload: [String: JunoJSONValue], _ keys: String...) -> Int? {
        for key in keys {
            if let value = payload[key]?.numberValue { return Int(value) }
        }
        return nil
    }

    /// A count that may have been written either as a number or as the array
    /// it counts.
    private static func count(_ payload: [String: JunoJSONValue], _ key: String) -> Int? {
        if let value = payload[key]?.numberValue { return Int(value) }
        if case .array(let items)? = payload[key] { return items.count }
        return nil
    }

    /// Plural forms written out rather than left to `^[…](inflect: true)`,
    /// which only resolves through a `LocalizedStringKey`; these are `String`s
    /// rendered verbatim.
    private static func fileCount(_ count: Int) -> String {
        count == 1 ? "1 file changed" : "\(count) files changed"
    }

    private static func changeCount(_ count: Int) -> String {
        count == 1 ? "1 change" : "\(count) changes"
    }

    // MARK: References

    public enum ReferenceDirection: Equatable, Sendable {
        case read
        case written
    }

    /// Something the run read or wrote, named without a path.
    public struct Reference: Identifiable, Equatable, Sendable {
        public let id: String
        public let direction: ReferenceDirection
        public let label: String
        public let detail: String?

        public init(id: String, direction: ReferenceDirection, label: String, detail: String?) {
            self.id = id
            self.direction = direction
            self.label = label
            self.detail = detail
        }
    }

    /// Everything the run read or wrote, as far as the stream reported it.
    ///
    /// Sources and file changes are one list because that is the question
    /// somebody actually has — what did it touch. A changed file is listed only
    /// by its name: an entry that arrives as a bare string is overwhelmingly a
    /// path, and no surface prints one, so a change that cannot be named is
    /// stated by its size instead.
    public static func references(in events: [WorkEvent]) -> [Reference] {
        var references: [Reference] = []

        for (event, kind) in visible(events) {
            switch kind {
            case .sourceCited:
                let url = string(event.payload, "url", "href")
                guard let label = string(event.payload, "title", "label") ?? url else { continue }
                references.append(
                    Reference(
                        id: "\(event.seq)",
                        direction: .read,
                        label: label,
                        detail: string(event.payload, "publisher", "site") ?? url
                    )
                )

            case .filesChanged, .batchApplied:
                var entries: [JunoJSONValue] = []
                if case .array(let files)? = event.payload["files"] {
                    entries = files
                } else if case .array(let items)? = event.payload["items"] {
                    entries = items
                }

                let named = entries.enumerated().compactMap { index, entry -> Reference? in
                    let record = fields(entry)
                    guard let label = string(record, "label", "name", "displayName", "title")
                    else { return nil }
                    let bytes = number(record, "bytes", "size")
                    return Reference(
                        id: "\(event.seq)-\(index)",
                        direction: .written,
                        label: label,
                        // The change verb sentence-cased, not the raw `created`
                        // / `moved` / `renamed` token the executor writes.
                        detail: bytes.map { "\($0.formatted(.byteCount(style: .file)))" }
                            ?? string(record, "change", "action")
                                .map(JunoWorkVocabulary.sentenceCased)
                    )
                }

                if !named.isEmpty {
                    references.append(contentsOf: named)
                    continue
                }

                let changed = count(event.payload, "count") ?? entries.count
                guard changed > 0 else { continue }
                references.append(
                    Reference(
                        id: "\(event.seq)",
                        direction: .written,
                        label: fileCount(changed),
                        detail: string(event.payload, "summary")
                    )
                )

            default:
                continue
            }
        }

        return references
    }

    /// Whether the run has applied a batch of changes that was not later
    /// undone — read only to decide whether saying that undo is not available
    /// from here is worth saying.
    public static func hasAppliedBatch(in events: [WorkEvent]) -> Bool {
        var applied = 0
        var undone = 0
        for (_, kind) in visible(events) {
            if kind == .batchApplied { applied += 1 }
            if kind == .batchUndone { undone += 1 }
        }
        return applied > undone
    }

    // MARK: Entries

    /// One visible event as a line a person can read.
    public struct Entry: Identifiable, Equatable, Sendable {
        /// What kind of thing happened, for the app to draw a mark for.
        public enum Mark: Equatable, Sendable {
            case started, plan, check, message, tool, refused, approval, file,
                link, batch, undo, agent, problem, limit, device, paused
        }

        public enum Tone: Equatable, Sendable {
            case quiet
            case normal
            case warning
            case bad
            case good
        }

        public let id: Int
        public let title: String
        public let detail: String?
        public let mark: Mark
        public let tone: Tone
        /// When it happened.
        public let at: Date

        public init(id: Int, title: String, detail: String?, mark: Mark, tone: Tone, at: Date) {
            self.id = id
            self.title = title
            self.detail = detail
            self.mark = mark
            self.tone = tone
            self.at = at
        }
    }

    /// Kinds whose whole content is already shown by a section of its own.
    private static let renderedElsewhere: Set<JunoWorkEventKind> = [.planCreated, .planUpdated]

    /// Every visible event but the plan's, oldest first.
    public static func entries(in events: [WorkEvent]) -> [Entry] {
        visible(events)
            .filter { !renderedElsewhere.contains($0.1) }
            .map { describe($0.0, $0.1) }
    }

    // MARK: Work between turns

    /// A stretch of activity between two things somebody said, folded into
    /// one "Worked for…" line.
    public struct WorkGroup: Identifiable, Equatable, Sendable {
        public let id: Int
        public let entries: [Entry]
        /// The turn this work led up to, or nil for work after the last turn —
        /// the run still going, or a run that ended without a closing word.
        public let beforeTurnID: String?

        public init(id: Int, entries: [Entry], beforeTurnID: String?) {
            self.id = id
            self.entries = entries
            self.beforeTurnID = beforeTurnID
        }

        public var duration: TimeInterval {
            guard let first = entries.first, let last = entries.last else { return 0 }
            return max(0, last.at.timeIntervalSince(first.at))
        }

        /// "Worked for 4m", or "Worked" when everything happened in one second.
        public var title: String {
            let seconds = Int(duration.rounded())
            if seconds < 1 { return "Worked" }
            if seconds < 60 { return "Worked for \(seconds)s" }
            let minutes = seconds / 60
            if minutes < 60 { return "Worked for \(minutes)m" }
            let hours = minutes / 60
            let rest = minutes % 60
            return rest == 0 ? "Worked for \(hours)h" : "Worked for \(hours)h \(rest)m"
        }
    }

    /// The kinds that become a turn, and therefore break a group. Mirrors
    /// ``turns(in:)``: a kind added there is added here.
    private static let turnKinds: Set<JunoWorkEventKind> = [
        .assistantMessage, .questionAsked, .questionAnswered, .userMessage,
    ]

    public static func workGroups(in events: [WorkEvent]) -> [WorkGroup] {
        var groups: [WorkGroup] = []
        var pending: [Entry] = []
        for (event, kind) in visible(events) {
            if turnKinds.contains(kind) {
                if !pending.isEmpty {
                    groups.append(WorkGroup(id: pending[0].id, entries: pending, beforeTurnID: "\(event.id)"))
                    pending = []
                }
                continue
            }
            guard !renderedElsewhere.contains(kind) else { continue }
            pending.append(describe(event, kind))
        }
        if !pending.isEmpty {
            groups.append(WorkGroup(id: pending[0].id, entries: pending, beforeTurnID: nil))
        }
        return groups
    }

    /// One event as a sentence a person can read.
    ///
    /// An exhaustive switch, not a lookup with a fallback: a kind added to the
    /// contract and forgotten here is a compile error rather than a blank row.
    /// The payload is lifted (``WorkEventPayload/fields(of:)``), because the
    /// cloud runner wraps each kind's facts in one sub-object and this Mac's
    /// run host does not; one reader is then correct for both executors.
    private static func describe(_ event: WorkEvent, _ kind: JunoWorkEventKind) -> Entry {
        let payload = WorkEventPayload.fields(of: event)
        let vocabulary = JunoWorkVocabulary.self
        switch kind {
        case .runStarted:
            return entry(
                event, "Started",
                string(payload, "target").map { vocabulary.target($0, hostName: nil) },
                .started, .quiet
            )
        case .planCreated:
            return entry(event, "Wrote a plan", nil, .plan, .quiet)
        case .planUpdated:
            return entry(event, "Revised the plan", string(payload, "reason"), .plan, .quiet)
        case .stepStarted:
            return entry(
                event, string(payload, "title", "label") ?? "Started a step", nil, .started, .normal
            )
        case .stepFinished:
            return entry(
                event, string(payload, "title", "label") ?? "Finished a step",
                string(payload, "summary"), .check, .quiet
            )
        case .assistantMessage:
            return entry(
                event, string(payload, "text", "message") ?? "Said something", nil, .message, .normal
            )
        case .toolStarted:
            return entry(
                event, string(payload, "summary") ?? vocabulary.toolPresent(string(payload, "tool", "name")),
                string(payload, "target", "detail"), .tool, .normal
            )
        case .toolFinished:
            // Past tense here, present tense on `toolStarted`: a log that says
            // "Reading a file" under a finished run describes nothing happening.
            return entry(
                event,
                string(payload, "summary") ?? vocabulary.toolPast(string(payload, "tool", "name")),
                string(payload, "result", "detail"), .check, .quiet
            )
        case .toolDenied:
            return entry(
                event,
                "Refused: \(vocabulary.action(string(payload, "tool", "name")))",
                string(payload, "reason", "explanation"), .refused, .warning
            )
        case .questionAsked:
            return entry(
                event, string(payload, "question", "text") ?? "Asked you a question", nil,
                .message, .warning
            )
        case .questionAnswered:
            return entry(event, "You answered", string(payload, "text", "answer"), .message, .quiet)
        // Said without being asked, which is why it does not read as an answer.
        // The payload keeps `question_answered`'s field names, so a row an
        // older build wrote renders through the same accessor.
        case .userMessage:
            return entry(event, "You added an instruction", string(payload, "text"), .message, .quiet)
        case .approvalRequested:
            return entry(
                event, string(payload, "summary") ?? "Asked for approval",
                string(payload, "action").map(vocabulary.action), .approval, .warning
            )
        case .approvalResolved:
            return entry(
                event,
                string(payload, "decision") == "denied" ? "You refused an action" : "You allowed an action",
                string(payload, "summary") ?? string(payload, "action").map(vocabulary.action),
                .approval, .quiet
            )
        case .artifactCreated:
            return entry(
                event, "Created \(string(payload, "title") ?? "a file")",
                artifactKindPhrase(payload), .file, .good
            )
        case .artifactUpdated:
            return entry(
                event, "Updated \(string(payload, "title") ?? "a file")",
                artifactKindPhrase(payload), .file, .quiet
            )
        case .sourceCited:
            return entry(
                event, string(payload, "title", "url") ?? "Cited a source",
                string(payload, "url"), .link, .quiet
            )
        case .filesChanged:
            let changed = count(payload, "files") ?? count(payload, "count")
            return entry(
                event, changed.map(fileCount) ?? "Changed files", string(payload, "summary"), .file, .normal
            )
        case .batchPreview:
            let size = count(payload, "items") ?? count(payload, "count")
            return entry(
                event,
                size.map { "Prepared \(changeCount($0)) for review" } ?? "Prepared a batch of changes",
                string(payload, "summary"), .batch, .normal
            )
        case .batchApplied:
            let size = count(payload, "items") ?? count(payload, "count")
            return entry(
                event, size.map { "Applied \(changeCount($0))" } ?? "Applied a batch of changes",
                string(payload, "summary"), .check, .good
            )
        case .batchUndone:
            let size = count(payload, "reversedCount") ?? count(payload, "count")
            return entry(
                event, size.map { "Undid \(changeCount($0))" } ?? "Undid a batch of changes",
                string(payload, "summary"), .undo, .quiet
            )
        case .subagentUpdate:
            // Never the bare `agentId`: an identifier in the title slot is the
            // one row that is unreadable to the person it is for.
            return entry(
                event, string(payload, "title") ?? "A sub-agent reported in",
                string(payload, "status", "summary"), .agent, .quiet
            )
        case .degraded:
            return entry(
                event, "Ran with less than you asked for", string(payload, "explanation"), .problem, .warning
            )
        case .budgetWarning:
            return entry(
                event, "Approaching a limit", string(payload, "detail", "explanation"), .limit, .warning
            )
        case .hostDisconnected:
            return entry(
                event, "\(string(payload, "hostName") ?? "The Mac") disconnected",
                string(payload, "detail"), .device, .warning
            )
        case .hostReconnected:
            return entry(
                event, "\(string(payload, "hostName") ?? "The Mac") reconnected", nil, .device, .good
            )
        case .paused:
            return entry(event, "Paused", string(payload, "reason"), .paused, .quiet)
        case .resumed:
            return entry(event, "Resumed", nil, .started, .quiet)
        case .validationResult:
            let passed = payload["ok"]?.boolValue != false
            return entry(
                event, passed ? "Checked its own work" : "A check did not pass",
                string(payload, "detail", "summary"),
                passed ? .check : .problem,
                passed ? .quiet : .warning
            )
        case .runFinished:
            // ``JunoWorkVocabulary/terminalReason(_:)`` is nil where the reason
            // adds nothing, so a clean finish is just "Finished".
            let reason = string(payload, "reason")
            // A failure is not a finish: "Finished because it could not
            // finish" contradicted itself under a tick. It takes the status
            // copy ("This stopped before it finished"), and the problem mark.
            if reason == "failed" {
                return entry(
                    event, "Stopped before it finished",
                    string(payload, "detail", "summary"),
                    .problem, .bad
                )
            }
            let because = vocabulary.terminalReason(reason)
            return entry(
                event, because.map { "Finished because \($0)" } ?? "Finished",
                string(payload, "detail", "summary"),
                .check, reason == "completed" ? .good : .warning
            )
        case .error:
            return entry(
                event, "Something went wrong", string(payload, "message", "detail"), .problem, .bad
            )
        }
    }

    private static func entry(
        _ event: WorkEvent, _ title: String, _ detail: String?, _ mark: Entry.Mark, _ tone: Entry.Tone
    ) -> Entry {
        Entry(id: event.seq, title: title, detail: detail, mark: mark, tone: tone, at: event.createdAt)
    }

    /// An artifact event's kind as a noun, never the raw `spreadsheet` token.
    private static func artifactKindPhrase(_ payload: [String: JunoJSONValue]) -> String? {
        string(payload, "kind")
            .flatMap(JunoWorkArtifactKind.init(rawValue:))
            .map(JunoWorkVocabulary.artifactKind)
    }
}
