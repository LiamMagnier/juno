import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// A research run the chat handed off to (Tool calls & research SPEC §9): one
/// feature called "Research", with no levels (R1), that runs in the background
/// and is followed by polling `GET /api/research/{id}`.
///
/// Decoded from `ResearchRunView`, every rework field optional: an older
/// server sends none of `phase`, `counts`, `questions` or `workingMs`, and the
/// run is then read from its `state` and `plan` alone.
public struct NativeResearchRun: Equatable, Sendable, Identifiable {
    /// `ResearchPhase` (SPEC §9.11.1), derived by the server.
    public enum Phase: String, Equatable, Sendable {
        case planning
        case awaitingStart = "awaiting_start"
        /// Waiting on the reader to fill in what the goal left open (the
        /// clarify gate) — a gate, not work: nothing moves and nothing polls
        /// fast until it is answered or skipped.
        case awaitingClarification = "awaiting_clarification"
        case searching, reading, reviewing, writing, checking, paused, done, stopped, failed

        public var isTerminal: Bool { self == .done || self == .stopped || self == .failed }
        /// Working: the glyph loops and the clock runs.
        public var isWorking: Bool {
            switch self {
            case .planning, .searching, .reading, .reviewing, .writing, .checking: true
            case .awaitingStart, .awaitingClarification, .paused, .done, .stopped, .failed: false
            }
        }

        /// A phase from a run's `state`, for a server that does not derive one.
        public init(state: String, latestEventKind: String? = nil) {
            switch state {
            case "accepted", "clarifying", "planning": self = .planning
            case "awaiting_clarification": self = .awaitingClarification
            case "awaiting_plan_confirmation", "awaiting_user_input": self = .awaitingStart
            case "investigating": self = latestEventKind == "source_read" ? .reading : .searching
            case "reviewing": self = .reviewing
            case "synthesizing": self = .writing
            case "validating_citations": self = .checking
            case "paused": self = .paused
            case "completed", "partially_completed": self = .done
            case "cancelled": self = .stopped
            default: self = .failed
            }
        }
    }

    public struct Question: Equatable, Sendable, Identifiable {
        public let id: String
        public let question: String
        public let rationale: String?
        /// `pending`, `searching`, `covered`, `partial` or `thin`.
        public let status: String

        public init(id: String, question: String, rationale: String? = nil, status: String = "pending") {
            self.id = id
            self.question = question
            self.rationale = rationale
            self.status = status
        }
    }

    public struct Source: Equatable, Sendable, Identifiable {
        public let id: String
        public let url: URL
        public let title: String
        /// Opened and read, not only found by a search.
        public let read: Bool

        public init(id: String, url: URL, title: String, read: Bool) {
            self.id = id
            self.url = url
            self.title = title
            self.read = read
        }
    }

    public struct Finding: Equatable, Sendable, Identifiable {
        public let id: String
        public let claim: String
        public let quote: String
        public let url: URL?
        public let title: String

        public init(id: String, claim: String, quote: String, url: URL?, title: String) {
            self.id = id
            self.claim = claim
            self.quote = quote
            self.url = url
            self.title = title
        }
    }

    public struct Steering: Equatable, Sendable {
        public let text: String
        public let appliedAtRound: Int?

        public init(text: String, appliedAtRound: Int?) {
            self.text = text
            self.appliedAtRound = appliedAtRound
        }
    }

    public struct Counts: Equatable, Sendable {
        public var found = 0
        public var read = 0
        public var cited = 0
        public var searches = 0
        public var pages = 0

        public init(found: Int = 0, read: Int = 0, cited: Int = 0, searches: Int = 0, pages: Int = 0) {
            self.found = found
            self.read = read
            self.cited = cited
            self.searches = searches
            self.pages = pages
        }
    }

    /// One line of the Progress view's activity stream.
    public struct Step: Equatable, Sendable, Identifiable {
        public let id: Int
        public let line: NativeRunPhraseLine
        public let isWarning: Bool
        public let at: Date?

        public init(id: Int, line: NativeRunPhraseLine, isWarning: Bool = false, at: Date? = nil) {
            self.id = id
            self.line = line
            self.isWarning = isWarning
            self.at = at
        }
    }

    /// What the goal left open, asked before the research starts (the web's
    /// `ResearchClarification`).
    public struct Clarification: Equatable, Sendable, Identifiable {
        public let id: String
        public let question: String
        /// One line: what changes about the research depending on the answer.
        public let why: String?
        /// Examples of the answer's shape; a press fills the field.
        public let suggestions: [String]
        /// False only when the answer is needed; nil or true is optional.
        public let skippable: Bool

        public init(id: String, question: String, why: String? = nil, suggestions: [String] = [], skippable: Bool = true) {
            self.id = id
            self.question = question
            self.why = why
            self.suggestions = suggestions
            self.skippable = skippable
        }
    }

    /// The citation check's totals (`auditSummary`): how many of the report's
    /// claims hold against the passages they cite.
    public struct AuditSummary: Equatable, Sendable {
        public var claims = 0
        public var supported = 0
        public var partiallySupported = 0
        public var unsupported = 0
        public var contradicted = 0
        public var unverified = 0

        public init(
            claims: Int = 0, supported: Int = 0, partiallySupported: Int = 0,
            unsupported: Int = 0, contradicted: Int = 0, unverified: Int = 0
        ) {
            self.claims = claims
            self.supported = supported
            self.partiallySupported = partiallySupported
            self.unsupported = unsupported
            self.contradicted = contradicted
            self.unverified = unverified
        }

        /// Every claim was checked and fully supported; absence or uncertainty is not clean.
        public var isClean: Bool {
            claims > 0 && supported == claims
                && partiallySupported + unsupported + contradicted + unverified == 0
        }

        /// The web's `auditHeadline`, word for word.
        public var headline: String {
            let problems = unsupported + partiallySupported + contradicted
            if claims == 0 { return "No checkable claims in this answer" }
            if problems == 0, unverified == 0 { return "Every claim checks out against its sources" }
            var parts = ["\(supported)/\(claims) claims supported"]
            if contradicted > 0 { parts.append("\(contradicted) contradicted") }
            if unsupported > 0 { parts.append("\(unsupported) unsupported") }
            if partiallySupported > 0 { parts.append("\(partiallySupported) partly supported") }
            if unverified > 0 { parts.append("\(unverified) not checked") }
            return parts.joined(separator: " \u{00B7} ")
        }
    }

    /// One `state_changed` event, kept for the working clock on a server
    /// that sends no `workingMs`.
    public struct StateTransition: Equatable, Sendable {
        public let seq: Int
        public let state: String
        public let at: Date

        public init(seq: Int, state: String, at: Date) {
            self.seq = seq
            self.state = state
            self.at = at
        }
    }

    public let id: String
    public var conversationID: String?
    /// The question the run answers: the reader's message.
    public var userMessageID: String?
    public var goal: String
    public var state: String
    public var title: String?
    public var phase: Phase
    public var phaseQuery: String?
    public var phaseDomain: String?
    public var approach: String?
    public var questions: [Question]
    public var counts: Counts
    /// Working time, paused and gate time excluded, as of ``fetchedAt``.
    public var workingMs: Int?
    public var fetchedAt: Date
    public var createdAt: Date?
    public var finishedAt: Date?
    public var assistantMessageID: String?
    public var leadModel: String?
    public var findings: [Finding]
    public var sources: [Source]
    public var steering: [Steering]
    public var estimateMinutes: Int?
    public var estimatePages: Int?
    public var report: String?
    public var revising: Bool
    public var finishRequested: Bool
    /// The Progress stream, newest first, at most 50.
    public var steps: [Step]
    /// The last event this client has seen: the next poll's `after`.
    public var lastSeq: Int
    /// This client saw the run working: its row stays, as "Report ready",
    /// after it finishes. A run first seen finished is its completion
    /// message and has no row (SPEC §9.11.3).
    public var seenLive = false
    /// The clarify gate's questions (`plan.clarifications`).
    public var clarifications: [Clarification] = []
    /// What the run has spent, when the server says (`costMicroUsd`).
    public var costMicroUsd: Int?
    /// The citation check's totals, once the report has been checked.
    public var audit: AuditSummary?
    /// The run's own error sentence, when it ended on one.
    public var error: String?
    /// The newest event the server holds: while ``lastSeq`` is behind it, the
    /// next poll goes at once (`maxSeq`).
    public var maxSeq = 0
    /// Whether the server derived the phase itself — a background-research
    /// server. Today's server does not, and refuses "Finish now".
    public var derivesPhase = false
    /// Who confirmed the plan (`plan_confirmed.by`): "auto" on the in-chat
    /// path, whose report is already the chat's answer.
    public var confirmedBy: String?
    /// Every state change seen, oldest first, for the working clock.
    public var transitions: [StateTransition] = []

    public init(
        id: String,
        conversationID: String? = nil,
        userMessageID: String? = nil,
        goal: String = "",
        state: String = "planning",
        title: String? = nil,
        phase: Phase = .planning,
        phaseQuery: String? = nil,
        phaseDomain: String? = nil,
        approach: String? = nil,
        questions: [Question] = [],
        counts: Counts = Counts(),
        workingMs: Int? = nil,
        fetchedAt: Date = Date(),
        createdAt: Date? = nil,
        finishedAt: Date? = nil,
        assistantMessageID: String? = nil,
        leadModel: String? = nil,
        findings: [Finding] = [],
        sources: [Source] = [],
        steering: [Steering] = [],
        estimateMinutes: Int? = nil,
        estimatePages: Int? = nil,
        report: String? = nil,
        revising: Bool = false,
        finishRequested: Bool = false,
        steps: [Step] = [],
        lastSeq: Int = 0
    ) {
        self.id = id
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.goal = goal
        self.state = state
        self.title = title
        self.phase = phase
        self.phaseQuery = phaseQuery
        self.phaseDomain = phaseDomain
        self.approach = approach
        self.questions = questions
        self.counts = counts
        self.workingMs = workingMs
        self.fetchedAt = fetchedAt
        self.createdAt = createdAt
        self.finishedAt = finishedAt
        self.assistantMessageID = assistantMessageID
        self.leadModel = leadModel
        self.findings = findings
        self.sources = sources
        self.steering = steering
        self.estimateMinutes = estimateMinutes
        self.estimatePages = estimatePages
        self.report = report
        self.revising = revising
        self.finishRequested = finishRequested
        self.steps = steps
        self.lastSeq = lastSeq
    }

    /// Working time now: extrapolated between polls while working, frozen at
    /// gates and while paused, so the clock never jumps on a poll (SPEC
    /// §9.11.3).
    public func workingTime(at now: Date) -> TimeInterval? {
        guard let workingMs else { return nil }
        let base = TimeInterval(workingMs) / 1_000
        return phase.isWorking ? base + max(0, now.timeIntervalSince(fetchedAt)) : base
    }

    /// Behind the server's newest event: poll again at once.
    public var isBehind: Bool { lastSeq < maxSeq }

    /// The report's own words: the first Markdown artifact's body, else the
    /// raw text (the web's `reportBody`).
    public var reportBody: String? {
        guard let report else { return nil }
        return Self.reportBody(report)
    }

    /// The name a report goes by: its artifact's title unless that is the
    /// generic "Research report", then the run's title, then the goal.
    public var displayTitle: String {
        if let report, let title = Self.reportTitle(report) { return title }
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        return goal
    }

    /// A report the in-chat path wrote: its chat answer already carries it,
    /// so it gets nothing more in the transcript (the native mirror's C4.2).
    public var isInChatReport: Bool {
        confirmedBy == "auto" && (report?.contains("identifier=\"research-report\"") ?? false)
    }

    /// Sources opened and read.
    public var readSourceCount: Int { sources.filter(\.read).count }

    /// "a/b objectives answered", when the plan had objectives.
    public var objectivesAnswered: (covered: Int, total: Int)? {
        guard !questions.isEmpty else { return nil }
        return (questions.filter { $0.status == "covered" }.count, questions.count)
    }

    /// How the transcript draws a run (the native mirror's C4).
    public enum Presentation: Equatable, Sendable {
        /// The one-line row, the plan card or the clarify gate.
        case row
        /// A finished run with no answer of its own in the chat.
        case recap
        /// Nothing: its answer in the chat is the report.
        case none
    }

    public var presentation: Presentation {
        guard phase.isTerminal else { return .row }
        if isInChatReport { return .none }
        // A background run that finished with a completion message: that
        // message is the report; the row stays only where it was seen working.
        if assistantMessageID != nil { return seenLive ? .row : .none }
        // Today's web background runs write the report on the run alone.
        if report != nil || !sources.isEmpty { return .recap }
        return seenLive ? .row : .none
    }

    /// The web's `RESEARCH_STATE_MESSAGE` for a state.
    public static func stateSentence(_ state: String) -> String {
        switch state {
        case "accepted": "Getting ready"
        case "clarifying": "Working out what the question leaves open"
        case "awaiting_clarification": "Waiting for you to fill in a few details"
        case "planning": "Working out what to look up"
        case "awaiting_plan_confirmation": "Waiting for you to confirm the plan"
        case "investigating": "Researchers are searching and reading"
        case "reviewing": "Reviewing what the researchers found"
        case "synthesizing": "Writing the report"
        case "validating_citations": "Checking every citation against its source"
        case "awaiting_user_input": "Waiting for your answer"
        case "paused": "Paused"
        case "completed": "Finished"
        case "partially_completed": "Stopped early with what it had"
        case "cancelled": "Cancelled"
        default: "Stopped after an error"
        }
    }

    /// Working states: the clock runs only in these.
    static let workingStates: Set<String> = [
        "clarifying", "planning", "investigating", "reviewing", "synthesizing", "validating_citations",
    ]

    /// Working time from the state changes, gates and pauses left out — the
    /// web's `workingElapsedMs` (`run-clock.ts`), for a server that sends no
    /// `workingMs`.
    public static func workingElapsedMs(
        transitions: [StateTransition], state: String, createdAt: Date?, now: Date
    ) -> Int? {
        var total: TimeInterval = 0
        var current: String?
        var since = Date.distantPast
        for transition in transitions.sorted(by: { $0.seq < $1.seq }) {
            if let current, workingStates.contains(current) {
                total += max(0, transition.at.timeIntervalSince(since))
            }
            current = transition.state
            since = transition.at
        }
        if transitions.isEmpty {
            guard workingStates.contains(state), let createdAt else { return nil }
            return Int((max(0, now.timeIntervalSince(createdAt)) * 1_000).rounded())
        }
        if let current, workingStates.contains(current) { total += max(0, now.timeIntervalSince(since)) }
        if total == 0, !workingStates.contains(state) { return nil }
        return Int((total * 1_000).rounded())
    }

    /// The first Markdown `<juno:artifact>`'s body, else the whole text.
    public static func reportBody(_ report: String) -> String {
        if let artifact = reportArtifact(report) {
            let body = artifact.content.trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { return body }
        }
        return report.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The artifact's title, unless it is the generic "research report".
    public static func reportTitle(_ report: String) -> String? {
        guard let title = reportArtifact(report)?.title?.trimmingCharacters(in: .whitespacesAndNewlines),
            !title.isEmpty, title.lowercased() != "research report"
        else { return nil }
        return title
    }

    /// The first `<juno:artifact>` of type MARKDOWN, else the first at all.
    private static func reportArtifact(_ report: String) -> (title: String?, content: String)? {
        var artifacts: [(type: String?, title: String?, content: String)] = []
        var rest = report[...]
        while let open = rest.range(of: "<juno:artifact") {
            guard let tagEnd = rest[open.upperBound...].range(of: ">") else { break }
            let attributes = String(rest[open.upperBound..<tagEnd.lowerBound])
            let bodyStart = tagEnd.upperBound
            let close = rest[bodyStart...].range(of: "</juno:artifact>")
            let content = String(rest[bodyStart..<(close?.lowerBound ?? rest.endIndex)])
            artifacts.append((attribute("type", in: attributes), attribute("title", in: attributes), content))
            guard let close else { break }
            rest = rest[close.upperBound...]
        }
        guard let chosen = artifacts.first(where: { $0.type?.uppercased() == "MARKDOWN" }) ?? artifacts.first
        else { return nil }
        return (chosen.title, chosen.content)
    }

    private static func attribute(_ name: String, in attributes: String) -> String? {
        // A leading space, so `title` never matches inside `subtitle`.
        guard let start = attributes.range(of: " \(name)=\"") else { return nil }
        guard let end = attributes[start.upperBound...].range(of: "\"") else { return nil }
        return String(attributes[start.upperBound..<end.lowerBound])
    }

    /// The row's count: sources read while live, cited at rest.
    public var shownSourceCount: Int {
        phase.isTerminal ? counts.cited : counts.read
    }

    /// The phase line (SPEC §9.11.1).
    public var phaseLine: NativeRunPhraseLine {
        switch phase {
        case .planning: return NativeRunPhraseLine([NativeRunPhrase("Planning the research")])
        case .awaitingStart: return NativeRunPhraseLine([NativeRunPhrase("Ready to start")])
        case .awaitingClarification:
            return NativeRunPhraseLine([NativeRunPhrase("Waiting for you to fill in a few details")])
        case .searching:
            if let query = phaseQuery, !query.isEmpty {
                return NativeRunPhraseLine([NativeRunPhrase([.phrase("Searching for"), .quote(query)])])
            }
            return NativeRunPhraseLine([NativeRunPhrase("Searching the web")])
        case .reading:
            if let domain = phaseDomain, !domain.isEmpty {
                return NativeRunPhraseLine([NativeRunPhrase([.phrase("Reading"), .domain(domain)])])
            }
            return NativeRunPhraseLine([NativeRunPhrase("Reading sources")])
        case .reviewing: return NativeRunPhraseLine([NativeRunPhrase("Reviewing what it found")])
        case .writing: return NativeRunPhraseLine([NativeRunPhrase("Writing the report")])
        case .checking: return NativeRunPhraseLine([NativeRunPhrase("Checking citations")])
        case .paused: return NativeRunPhraseLine([NativeRunPhrase("Paused")])
        case .done: return NativeRunPhraseLine([NativeRunPhrase("Report ready")])
        case .stopped: return NativeRunPhraseLine([NativeRunPhrase("Research stopped")])
        case .failed: return NativeRunPhraseLine([NativeRunPhrase("Research couldn't finish")])
        }
    }

    /// The panel header's static phase word.
    public var phaseWord: String {
        switch phase {
        case .planning: "Planning"
        case .awaitingStart: "Ready to start"
        case .awaitingClarification: "Before Juno starts"
        case .searching: "Searching"
        case .reading: "Reading"
        case .reviewing: "Reviewing"
        case .writing: "Writing"
        case .checking: "Checking citations"
        case .paused: "Paused"
        case .done: "Report ready"
        case .stopped: "Stopped"
        case .failed: "Couldn't finish"
        }
    }

    /// A question's status chip — "In progress", never "Searching", which is
    /// the verb prefix elsewhere (SPEC §7.6 homographs).
    public static func questionStatus(_ status: String) -> String {
        switch status {
        case "searching": "In progress"
        case "covered": "Covered"
        case "partial": "Partly covered"
        case "thin": "Little evidence"
        default: "Not started"
        }
    }

    /// The estimate line: "About 12 min · Reads up to ~150 pages". No money.
    public var estimateLine: NativeRunPhraseLine? {
        guard let minutes = estimateMinutes else { return nil }
        var phrases = [NativeRunPhrase([.phrase("About"), .label("\(minutes) min")])]
        if let pages = estimatePages {
            phrases.append(NativeRunPhrase([.phrase("Reads up to"), .count(pages, one: "page", other: "pages", approx: true)]))
        }
        return NativeRunPhraseLine(phrases)
    }

    /// A step line from one research event, or nil for an event the stream
    /// does not show (SPEC §9.11.4: round boundaries and notable events).
    static func step(kind: String, payload: [String: JunoJSONValue], seq: Int, at: Date?) -> Step? {
        func text(_ key: String) -> String? {
            if case .string(let value)? = payload[key], !value.isEmpty { return value }
            return nil
        }
        func number(_ key: String) -> Int? {
            if case .number(let value)? = payload[key] { return Int(value) }
            return nil
        }
        switch kind {
        case "plan_confirmed":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Research started")]), at: at)
        case "query_issued":
            guard let query = text("query") else { return nil }
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Searching for"), .quote(query)])]), at: at)
        case "source_read":
            guard let raw = text("url"), let host = URL(string: raw)?.host() else { return nil }
            let domain = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Read"), .domain(domain)])]), at: at)
        case "round_reviewed":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Reviewing what it found")]), at: at)
        case "follow_up_scheduled":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Following an evidence gap")]), at: at)
        case "worker_spawned":
            if let round = number("round"), round > 1 {
                return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Round"), .number(Double(round), approx: false)])]), at: at)
            }
            return nil
        case "citation_audit_started":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Checking citations")]), at: at)
        case "state_changed":
            guard text("state") == "synthesizing" else { return nil }
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Writing the report")]), at: at)
        case "budget_exhausted":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("Stopped at the research budget")]), isWarning: true, at: at)
        case "error":
            return Step(id: seq, line: NativeRunPhraseLine([NativeRunPhrase("A source could not be read")]), isWarning: true, at: at)
        default:
            return nil
        }
    }
}

// MARK: - Client

/// `/api/research`: the run a chat handed off to, the runs a conversation
/// holds, and the reader's controls over them.
extension NativeChatAPIClient {
    /// One run and its events since `after`, in one round trip.
    public func researchRun(
        id: String,
        after: Int = 0,
        previous: NativeResearchRun? = nil,
        for accountID: AccountID
    ) async throws -> NativeResearchRun {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research/\(id)",
                queryItems: [URLQueryItem(name: "after", value: String(max(0, after)))]
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
        guard let wire = try? JSONDecoder().decode(ResearchRunEnvelopeWire.self, from: response.body) else {
            throw NativeChatAPIError.malformedResponse
        }
        return wire.run(previous: previous, parseDate: parseDate)
    }

    /// The conversation's runs, newest first.
    public func researchRuns(
        conversationID: String,
        for accountID: AccountID
    ) async throws -> [NativeResearchRunSummary] {
        try requireIdentifier(conversationID)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research",
                queryItems: [URLQueryItem(name: "conversationId", value: conversationID)]
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
        guard let wire = try? JSONDecoder().decode(ResearchRunListWire.self, from: response.body) else {
            throw NativeChatAPIError.malformedResponse
        }
        return (wire.runs.elements).map {
            NativeResearchRunSummary(
                id: $0.id,
                conversationID: $0.conversationId,
                state: $0.state,
                phase: $0.phase.flatMap(NativeResearchRun.Phase.init(rawValue:)),
                live: $0.live ?? !["completed", "partially_completed", "failed", "cancelled"].contains($0.state),
                assistantMessageID: $0.assistantMessageId,
                createdAt: $0.createdAt.flatMap(parseDate)
            )
        }
    }

    /// Pause, resume, finish now, or cancel.
    public func controlResearch(
        id: String,
        action: NativeResearchControl,
        for accountID: AccountID
    ) async throws {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research/\(id)/control",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(["action": action.rawValue])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
    }

    /// Starts a planned run as planned, or cancels it at the plan.
    public func decideResearchPlan(
        id: String,
        confirm: Bool,
        for accountID: AccountID
    ) async throws {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research/\(id)/plan",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(["decision": confirm ? "confirm" : "cancel"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
    }
}

extension NativeChatAPIClient {
    /// Steers a run that is already going (`POST /api/research/{id}/steer`):
    /// a link pins a source, anything else is a constraint written into the
    /// plan — the web's rule (`use-conversation-run.ts`). Neither costs the
    /// work already done. The server refuses a run that is not accepting input
    /// with a sentence of its own, which the error carries.
    public func steerResearch(id: String, input: String, for accountID: AccountID) async throws {
        try requireIdentifier(id)
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NativeChatAPIError.invalidMessage }
        let isSource = text.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research/\(id)/steer",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(isSource ? ["sourceUrl": text] : ["constraint": text])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
    }
}

extension NativeChatAPIClient {
    /// Answers the clarify gate (`POST /api/research/{id}/clarify`): the
    /// answers the reader gave, by question id; none at all is "skip and
    /// research as written". The response is nested, so it is not read as a
    /// view; the caller reads the run again.
    public func clarifyResearch(id: String, answers: [String: String], for accountID: AccountID) async throws {
        try requireIdentifier(id)
        let trimmed = answers.compactMapValues { value -> String? in
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.isEmpty ? nil : String(clean.prefix(600))
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/research/\(id)/clarify",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(["answers": trimmed])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw serverError(response) }
    }

    /// The citation check for an answer (`GET /api/research/citations`), or
    /// nil when there is none. A failure is also nil: a report with no marks
    /// reads fine, and an error here would be noise.
    public func researchCitations(messageID: String, for accountID: AccountID) async -> NativeResearchAudit? {
        guard (try? requireIdentifier(messageID)) != nil,
            let request = try? NativeBearerRequest(
                path: "/api/research/citations",
                queryItems: [URLQueryItem(name: "messageId", value: messageID)]
            ),
            let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode)
        else { return nil }
        return NativeResearchAudit.decode(response.body)
    }
}

/// A report's citation check, claim by claim (`ClaimAuditView`): what each
/// cited source was used for, and whether the passage holds the claim up.
public struct NativeResearchAudit: Equatable, Sendable {
    public struct Link: Equatable, Sendable {
        /// The citation's number, `[n]`: 1-based and positional.
        public let sourceIndex: Int
        /// `supports` or `contradicts`.
        public let stance: String
        /// The passage, verbatim from the copy Juno saved.
        public let passage: String

        public init(sourceIndex: Int, stance: String, passage: String) {
            self.sourceIndex = sourceIndex
            self.stance = stance
            self.passage = passage
        }
    }

    public struct Claim: Equatable, Sendable {
        public let text: String
        /// `supported`, `partially supported`, `unsupported`, `contradicted`
        /// or `unverified`.
        public let label: String
        public let links: [Link]

        public init(text: String, label: String, links: [Link]) {
            self.text = text
            self.label = label
            self.links = links
        }
    }

    public let claims: [Claim]

    public init(claims: [Claim]) {
        self.claims = claims
    }

    /// The claims that cite source `n`, with the passage each rests on.
    public func evidence(forSource number: Int) -> [(claim: Claim, link: Link)] {
        claims.flatMap { claim in
            claim.links.filter { $0.sourceIndex == number }.map { (claim, $0) }
        }
    }

    /// The web's `STATES` label for a claim's verdict.
    public static func verdict(_ label: String) -> String {
        switch label {
        case "supported": "Supported"
        case "partially supported": "Partly supported"
        case "unsupported": "Unsupported"
        case "contradicted": "Contradicted"
        default: "Not checked"
        }
    }

    /// `{audit: ClaimAuditView | null}`; nil for null or anything unreadable.
    static func decode(_ data: Data) -> NativeResearchAudit? {
        struct Envelope: Decodable {
            struct Audit: Decodable {
                struct Claim: Decodable {
                    struct Link: Decodable {
                        let sourceIndex: Int
                        let stance: String?
                        let passage: String?
                    }
                    let text: String
                    let label: String?
                    let links: LossyList<Link>?
                }
                let claims: LossyList<Claim>?
            }
            let audit: Audit?
        }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), let audit = envelope.audit
        else { return nil }
        return NativeResearchAudit(claims: (audit.claims?.elements ?? []).map { claim in
            Claim(
                text: claim.text,
                label: claim.label ?? "unverified",
                links: (claim.links?.elements ?? []).map {
                    Link(sourceIndex: $0.sourceIndex, stance: $0.stance ?? "supports", passage: $0.passage ?? "")
                }
            )
        })
    }
}

public enum NativeResearchControl: String, Sendable {
    case pause, resume, finish, cancel
}

/// One row of `GET /api/research?conversationId=`.
public struct NativeResearchRunSummary: Equatable, Sendable {
    public let id: String
    public let conversationID: String?
    public let state: String
    /// Present only on a server that derives phases — a background run.
    public let phase: NativeResearchRun.Phase?
    public let live: Bool
    public let assistantMessageID: String?
    public let createdAt: Date?
}

extension NativeResearchRun {
    /// A run view's bytes as a run — the client's own decoding, for tests.
    static func decodedView(_ data: Data, previous: NativeResearchRun? = nil) -> NativeResearchRun? {
        guard let wire = try? JSONDecoder().decode(ResearchRunEnvelopeWire.self, from: data) else { return nil }
        return wire.run(previous: previous) { value in
            let precise = ISO8601DateFormatter()
            precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = precise.date(from: value) { return date }
            return ISO8601DateFormatter().date(from: value)
        }
    }
}

private struct ResearchRunListWire: Decodable {
    struct Row: Decodable {
        let id: String
        let conversationId: String?
        let state: String
        let phase: String?
        let live: Bool?
        let assistantMessageId: String?
        let createdAt: String?
    }

    let runs: LossyList<Row>
}

private struct ResearchRunEnvelopeWire: Decodable {
    struct Event: Decodable {
        let seq: Int
        let kind: String
        let payload: [String: JunoJSONValue]?
        let createdAt: String?
    }

    struct Run: Decodable {
        struct Plan: Decodable {
            struct Objective: Decodable {
                let id: String?
                let question: String?
                let status: String?
            }
            struct Clarification: Decodable {
                let id: String
                let question: String
                let why: String?
                let suggestions: [String]?
                let skippable: Bool?

                private enum CodingKeys: String, CodingKey { case id, question, why, suggestions, skippable }

                init(from decoder: any Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    id = try container.decode(String.self, forKey: .id)
                    question = try container.decode(String.self, forKey: .question)
                    why = try? container.decodeIfPresent(String.self, forKey: .why)
                    suggestions = try? container.decodeIfPresent([String].self, forKey: .suggestions)
                    skippable = try? container.decodeIfPresent(Bool.self, forKey: .skippable)
                }
            }
            let approach: String?
            let objectives: LossyList<Objective>?
            let clarifications: LossyList<Clarification>?
        }
        struct Audit: Decodable {
            let claims: Int?
            let supported: Int?
            let partiallySupported: Int?
            let unsupported: Int?
            let contradicted: Int?
            let unverified: Int?
        }
        /// A money figure the server sends as a decimal string or a number.
        struct Micros: Decodable {
            let value: Int?

            init(from decoder: any Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let text = try? container.decode(String.self) {
                    value = Int(text)
                } else if let number = try? container.decode(Double.self) {
                    value = Int(number)
                } else {
                    value = nil
                }
            }
        }
        struct Question: Decodable {
            let id: String
            let question: String
            let rationale: String?
            let status: String?
        }
        struct Counts: Decodable {
            let found: Int?
            let read: Int?
            let cited: Int?
            let searches: Int?
            let pages: Int?
        }
        struct PhaseDetail: Decodable {
            let query: String?
            let domain: String?
        }
        struct Lead: Decodable {
            let id: String?
            let label: String?
        }
        struct Finding: Decodable {
            let id: String
            let claim: String
            let quote: String
            let url: String?
            let title: String?
        }
        struct Source: Decodable {
            let id: String
            let url: String
            let title: String?
            let read: Bool?
        }
        struct Steering: Decodable {
            let text: String
            let appliedAtRound: Int?
        }
        struct Estimate: Decodable {
            let minutesUpTo: Int?
            let pagesUpTo: Int?
        }

        let id: String
        let conversationId: String?
        let goal: String?
        let state: String
        let title: String?
        let phase: String?
        let phaseDetail: PhaseDetail?
        let plan: Plan?
        let questions: LossyList<Question>?
        let counts: Counts?
        let workingMs: Double?
        let createdAt: String?
        let finishedAt: String?
        let assistantMessageId: String?
        let leadModel: Lead?
        let latestFindings: LossyList<Finding>?
        let sources: LossyList<Source>?
        let steering: LossyList<Steering>?
        let estimate: Estimate?
        let report: String?
        let revising: Bool?
        let finishRequested: Bool?
        let costMicroUsd: Micros?
        let auditSummary: Audit?
        let error: String?

        private enum CodingKeys: String, CodingKey {
            case id, conversationId, goal, state, title, phase, phaseDetail, plan, questions, counts, workingMs,
                 createdAt, finishedAt, assistantMessageId, leadModel, latestFindings, sources, steering, estimate,
                 report, revising, finishRequested, costMicroUsd, auditSummary, error
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            state = try container.decode(String.self, forKey: .state)
            conversationId = try? container.decodeIfPresent(String.self, forKey: .conversationId)
            goal = try? container.decodeIfPresent(String.self, forKey: .goal)
            title = try? container.decodeIfPresent(String.self, forKey: .title)
            phase = try? container.decodeIfPresent(String.self, forKey: .phase)
            phaseDetail = try? container.decodeIfPresent(PhaseDetail.self, forKey: .phaseDetail)
            plan = try? container.decodeIfPresent(Plan.self, forKey: .plan)
            questions = try? container.decodeIfPresent(LossyList<Question>.self, forKey: .questions)
            counts = try? container.decodeIfPresent(Counts.self, forKey: .counts)
            workingMs = try? container.decodeIfPresent(Double.self, forKey: .workingMs)
            createdAt = try? container.decodeIfPresent(String.self, forKey: .createdAt)
            finishedAt = try? container.decodeIfPresent(String.self, forKey: .finishedAt)
            assistantMessageId = try? container.decodeIfPresent(String.self, forKey: .assistantMessageId)
            leadModel = try? container.decodeIfPresent(Lead.self, forKey: .leadModel)
            latestFindings = try? container.decodeIfPresent(LossyList<Finding>.self, forKey: .latestFindings)
            sources = try? container.decodeIfPresent(LossyList<Source>.self, forKey: .sources)
            steering = try? container.decodeIfPresent(LossyList<Steering>.self, forKey: .steering)
            estimate = try? container.decodeIfPresent(Estimate.self, forKey: .estimate)
            report = try? container.decodeIfPresent(String.self, forKey: .report)
            revising = try? container.decodeIfPresent(Bool.self, forKey: .revising)
            finishRequested = try? container.decodeIfPresent(Bool.self, forKey: .finishRequested)
            costMicroUsd = try? container.decodeIfPresent(Micros.self, forKey: .costMicroUsd)
            auditSummary = try? container.decodeIfPresent(Audit.self, forKey: .auditSummary)
            error = try? container.decodeIfPresent(String.self, forKey: .error)
        }
    }

    let run: Run
    let events: LossyList<Event>?
    let lastSeq: Int?
    let maxSeq: Int?

    func run(previous: NativeResearchRun?, parseDate: (String) -> Date?) -> NativeResearchRun {
        let events = self.events?.elements ?? []
        let latestKind = events.last { $0.kind == "query_issued" || $0.kind == "source_read" }?.kind
        var steps = previous?.steps ?? []
        let known = Set(steps.map(\.id))
        for event in events where !known.contains(event.seq) {
            if let step = NativeResearchRun.step(
                kind: event.kind,
                payload: event.payload ?? [:],
                seq: event.seq,
                at: event.createdAt.flatMap(parseDate)
            ) {
                steps.insert(step, at: 0)
            }
        }
        steps = Array(steps.sorted { $0.id > $1.id }.prefix(50))
        let report = run.report.flatMap { $0.isEmpty ? nil : $0 }
        let serverPhase = run.phase.flatMap(NativeResearchRun.Phase.init(rawValue:))
        var phase = serverPhase ?? NativeResearchRun.Phase(state: run.state, latestEventKind: latestKind)
        // The clarify gate is a gate on either server: nothing moves until the
        // reader answers or skips (the native mirror's C6).
        if run.state == "awaiting_clarification" { phase = .awaitingClarification }
        // Stopped early with nothing written reads as stopped, never "Report
        // ready" with no report to open.
        if run.state == "partially_completed", report == nil { phase = .stopped }
        let questions: [NativeResearchRun.Question]
        if let typed = run.questions?.elements, !typed.isEmpty {
            questions = typed.map {
                NativeResearchRun.Question(id: $0.id, question: $0.question, rationale: $0.rationale, status: $0.status ?? "pending")
            }
        } else {
            questions = (run.plan?.objectives?.elements ?? []).enumerated().compactMap { index, objective in
                guard let question = objective.question, !question.isEmpty else { return nil }
                // An objective's coverage in the question chips' words.
                let status: String =
                    switch objective.status {
                    case "covered": "covered"
                    case "partially_covered": "partial"
                    case "blocked": "thin"
                    default: "pending"
                    }
                return NativeResearchRun.Question(id: objective.id ?? "q\(index)", question: question, status: status)
            }
        }
        let sources = (run.sources?.elements ?? []).compactMap { source -> NativeResearchRun.Source? in
            guard let url = URL(string: source.url), let scheme = url.scheme?.lowercased(),
                scheme == "https" || scheme == "http", url.host() != nil
            else { return nil }
            let title = (source.title?.isEmpty == false ? source.title : nil) ?? url.host() ?? source.url
            return NativeResearchRun.Source(id: source.id, url: url, title: title, read: source.read ?? false)
        }
        let readCount = sources.filter(\.read).count
        let counts = NativeResearchRun.Counts(
            found: run.counts?.found ?? sources.count,
            read: run.counts?.read ?? readCount,
            cited: run.counts?.cited ?? 0,
            searches: run.counts?.searches ?? 0,
            pages: run.counts?.pages ?? readCount
        )
        // The plan's confirmation and every state change, kept across polls:
        // each poll carries only the events after the last.
        var confirmedBy = previous?.confirmedBy
        var transitions = previous?.transitions ?? []
        let knownTransitions = Set(transitions.map(\.seq))
        for event in events {
            if event.kind == "plan_confirmed", confirmedBy == nil,
                case .string(let by)? = event.payload?["by"]
            {
                confirmedBy = by
            }
            if event.kind == "state_changed", !knownTransitions.contains(event.seq),
                case .string(let state)? = event.payload?["state"],
                let at = event.createdAt.flatMap(parseDate)
            {
                transitions.append(NativeResearchRun.StateTransition(seq: event.seq, state: state, at: at))
            }
        }
        let fetchedAt = Date()
        let createdAt = run.createdAt.flatMap(parseDate)
        let workingMs = run.workingMs.map { Int($0.rounded()) }
            ?? NativeResearchRun.workingElapsedMs(
                transitions: transitions, state: run.state, createdAt: createdAt, now: fetchedAt
            )
        let cursor = max(previous?.lastSeq ?? 0, lastSeq ?? events.map(\.seq).max() ?? 0)
        var decoded = NativeResearchRun(
            id: run.id,
            conversationID: run.conversationId ?? previous?.conversationID,
            userMessageID: previous?.userMessageID,
            goal: run.goal ?? previous?.goal ?? "",
            state: run.state,
            title: run.title ?? previous?.title,
            phase: phase,
            phaseQuery: run.phaseDetail?.query,
            phaseDomain: run.phaseDetail?.domain,
            approach: run.plan?.approach.flatMap { $0.isEmpty ? nil : $0 },
            questions: questions,
            counts: counts,
            workingMs: workingMs,
            fetchedAt: fetchedAt,
            createdAt: createdAt,
            finishedAt: run.finishedAt.flatMap(parseDate),
            assistantMessageID: run.assistantMessageId,
            leadModel: run.leadModel?.label,
            findings: (run.latestFindings?.elements ?? []).prefix(5).map {
                NativeResearchRun.Finding(
                    id: $0.id, claim: $0.claim, quote: $0.quote, url: $0.url.flatMap(URL.init(string:)),
                    title: $0.title ?? ""
                )
            },
            sources: sources,
            steering: (run.steering?.elements ?? []).map { NativeResearchRun.Steering(text: $0.text, appliedAtRound: $0.appliedAtRound) },
            estimateMinutes: run.estimate?.minutesUpTo,
            estimatePages: run.estimate?.pagesUpTo,
            report: report,
            revising: run.revising ?? false,
            finishRequested: run.finishRequested ?? false,
            steps: steps,
            lastSeq: cursor
        )
        decoded.clarifications = (run.plan?.clarifications?.elements ?? []).map {
            NativeResearchRun.Clarification(
                id: $0.id, question: $0.question,
                why: $0.why.flatMap { $0.isEmpty ? nil : $0 },
                suggestions: ($0.suggestions ?? []).filter { !$0.isEmpty },
                skippable: $0.skippable ?? true
            )
        }
        decoded.costMicroUsd = run.costMicroUsd?.value
        decoded.audit = run.auditSummary.map {
            NativeResearchRun.AuditSummary(
                claims: $0.claims ?? 0, supported: $0.supported ?? 0,
                partiallySupported: $0.partiallySupported ?? 0, unsupported: $0.unsupported ?? 0,
                contradicted: $0.contradicted ?? 0, unverified: $0.unverified ?? 0
            )
        }
        decoded.error = run.error.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        decoded.maxSeq = max(maxSeq ?? 0, cursor)
        decoded.derivesPhase = serverPhase != nil
        decoded.confirmedBy = confirmedBy
        decoded.transitions = transitions
        return decoded
    }
}

// MARK: - Research answered in the chat (profile 1)

extension NativeResearchRun {
    /// The titles the in-chat research path gives its rows (`deep-research.ts`
    /// `toActivity` and INV-7's "Research corpus ready") — read only here, to
    /// tell a profile-1 research turn from a plain one after a reload.
    static let inChatTitles: Set<String> = [
        "Research corpus ready", "Starting the research", "Plan approved — starting the research",
        "Researchers are searching and reading", "Working out what to look up", "Reviewing what the researchers found",
        "Prioritizing the strongest sources", "Checking every citation against its source", "A researcher reported back",
    ]

    /// Whether a turn's rows are the in-chat research path's.
    public static func isInChatResearch(activity: [NativeChatActivity]) -> Bool {
        activity.contains { event in
            inChatTitles.contains(event.title) || event.title.hasPrefix("Planned the research")
                || event.title.hasPrefix("Sending a researcher")
        }
    }

    /// A research turn a profile-1 server answers inside the chat — today's
    /// production — read as a run, so the transcript row and the Research
    /// panel describe it the way they describe a background run: searches as
    /// they are issued, pages as they are read, the report as it is written.
    public static func inChat(
        message: NativeChatMessage,
        live: Bool,
        now: Date = Date()
    ) -> NativeResearchRun {
        var steps: [Step] = []
        var searches = 0
        var readURLs: [URL] = []
        var lastQuery: String?
        var lastDomain: String?
        var lastKind: NativeChatActivity.Kind?
        for (index, event) in message.activity.enumerated() {
            switch event.kind {
            case .search where event.title == "Searching the web" || event.title == "Following an evidence gap":
                guard let query = event.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else { continue }
                searches += 1
                lastQuery = query
                lastKind = .search
                steps.append(Step(id: index, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Searching for"), .quote(query)])]), at: event.createdAt))
            case .visit:
                guard let raw = event.url, let url = URL(string: raw), let host = url.host() else { continue }
                let domain = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
                if !readURLs.contains(url) { readURLs.append(url) }
                lastDomain = domain
                lastKind = .visit
                steps.append(Step(id: index, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Read"), .domain(domain)])]), at: event.createdAt))
            case .warning:
                steps.append(Step(
                    id: index,
                    line: NativeToolPresentation.noticeLine(event.notice, title: event.title, detail: event.detail),
                    isWarning: true,
                    at: event.createdAt
                ))
            default:
                continue
            }
        }
        let answerStarted = message.answerStartedAt != nil || (!message.content.isEmpty && !live)
        let phase: Phase
        if !live {
            if message.finishReason == .userStopped {
                phase = .stopped
            } else if message.errorDescription != nil {
                phase = .failed
            } else {
                phase = .done
            }
        } else if answerStarted {
            phase = .writing
        } else if lastKind == .visit {
            phase = .reading
        } else if lastKind == .search {
            phase = .searching
        } else {
            phase = .planning
        }
        let sources = readURLs.enumerated().map { index, url in
            Source(id: "read-\(index)", url: url, title: url.host() ?? url.absoluteString, read: true)
        }
        let worked = message.runStartedAt.map { started -> Int in
            let until = live ? now : (message.answerStartedAt ?? message.createdAt)
            return Int(max(0, until.timeIntervalSince(started)) * 1_000)
        }
        return NativeResearchRun(
            id: "message:\(message.id)",
            conversationID: message.conversationID,
            goal: "",
            state: live ? "investigating" : "completed",
            phase: phase,
            phaseQuery: lastQuery,
            phaseDomain: lastDomain,
            counts: Counts(
                found: readURLs.count,
                read: readURLs.count,
                cited: message.sources.count,
                searches: searches,
                pages: readURLs.count
            ),
            workingMs: worked,
            fetchedAt: now,
            assistantMessageID: live ? nil : message.id,
            sources: sources,
            steps: Array(steps.reversed().prefix(50))
        )
    }
}
