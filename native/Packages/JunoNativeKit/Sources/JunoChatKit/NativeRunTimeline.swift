import Foundation

// MARK: - Activity payloads

/// The bytes behind a connector call, as the server redacted and truncated
/// them — the web's `ClientToolDetail`. Rendered verbatim: every absence comes
/// with a note saying why (`argsNote`, `resultNote`).
public struct NativeToolDetail: Equatable, Sendable {
    public let server: String
    public let name: String
    public let args: String?
    public let argsNote: String?
    public let argsTruncated: Bool
    public let result: String?
    public let resultNote: String?
    public let resultTruncated: Bool
    public let resultChars: Int?
    /// `ok` or `failed`; absent while the call has no ending to report.
    public let status: String?
    public let durationMs: Int?
    /// The tool contract's additions (TOOL_RUNTIME_DESIGN.md §6.4): the Alevr
    /// call id, the live phase (`queued`, `awaiting_approval`, `running`),
    /// the bound, the typed outcome (`outcome_unknown` included), the error
    /// code, the duplicate-cache flag, and for execution tools the run record
    /// and its live progress. All absent on a row from an older server.
    public let callID: String?
    public let phase: String?
    public let timeoutMs: Int?
    public let outcome: String?
    public let errorCode: String?
    public let cached: Bool
    public let run: NativeToolRun?
    public let progress: NativeToolRunProgress?

    public init(
        server: String,
        name: String,
        args: String? = nil,
        argsNote: String? = nil,
        argsTruncated: Bool = false,
        result: String? = nil,
        resultNote: String? = nil,
        resultTruncated: Bool = false,
        resultChars: Int? = nil,
        status: String? = nil,
        durationMs: Int? = nil,
        callID: String? = nil,
        phase: String? = nil,
        timeoutMs: Int? = nil,
        outcome: String? = nil,
        errorCode: String? = nil,
        cached: Bool = false,
        run: NativeToolRun? = nil,
        progress: NativeToolRunProgress? = nil
    ) {
        self.server = server
        self.name = name
        self.args = args
        self.argsNote = argsNote
        self.argsTruncated = argsTruncated
        self.result = result
        self.resultNote = resultNote
        self.resultTruncated = resultTruncated
        self.resultChars = resultChars
        self.status = status
        self.durationMs = durationMs
        self.callID = callID
        self.phase = phase
        self.timeoutMs = timeoutMs
        self.outcome = outcome
        self.errorCode = errorCode
        self.cached = cached
        self.run = run
        self.progress = progress
    }

    /// The sentence the panel prints in place of a missing argument box.
    public var argsNoteText: String? {
        switch argsNote {
        case "unavailable": "The provider did not report the arguments."
        case "empty": "Called with no arguments."
        case "unparsable": "The arguments were not valid JSON."
        case "over_budget": "Not kept: this run's detail budget was spent."
        default: nil
        }
    }

    /// The sentence the panel prints in place of a missing result box.
    public var resultNoteText: String? {
        switch resultNote {
        case "pending": "Still running."
        case "unfinished": "The run ended before this call returned."
        case "empty": "The tool returned nothing."
        case "over_budget": "Not kept: this run's detail budget was spent."
        default: nil
        }
    }
}

/// A saved fact about the reader that went into this turn.
public struct NativeMemoryReceipt: Equatable, Sendable, Identifiable {
    public let id: String
    public let content: String
    public let category: String?

    public init(id: String, content: String, category: String? = nil) {
        self.id = id
        self.content = content
        self.category = category
    }
}

/// A typed tool call, updated in place under one `callId` — the rework's
/// `ToolCallRecord` (Tool calls & research SPEC §2.4). Decoded when the server
/// sends it; a profile-1 server sends none, and ``NativeRunView`` builds the
/// same shape from the legacy rows instead.
public struct NativeToolCall: Equatable, Sendable {
    /// The eight `ToolCallStatus` values (SPEC §2.5), plus the tool runtime's
    /// `outcome_unknown` (TOOL_RUNTIME_DESIGN.md §6.4): a run whose end nobody
    /// saw. It is terminal, never a success, and never re-run.
    public enum Status: String, Equatable, Sendable, CaseIterable {
        case queued
        case awaitingApproval = "awaiting_approval"
        case running, succeeded, failed, denied, expired, cancelled
        case outcomeUnknown = "outcome_unknown"

        /// Unknown statuses read as running, as the SPEC's mirror checklist asks.
        /// A run record's `timed_out` is a failure (its code says why).
        public init(wire: String?) {
            if wire == "timed_out" {
                self = .failed
                return
            }
            self = wire.flatMap(Status.init(rawValue:)) ?? .running
        }

        public var isTerminal: Bool {
            switch self {
            case .succeeded, .failed, .denied, .expired, .cancelled, .outcomeUnknown: true
            case .queued, .awaitingApproval, .running: false
            }
        }

        /// Still working: queued or running (an approval wait is not work).
        public var isActive: Bool { self == .queued || self == .running }
    }

    public struct Figure: Equatable, Sendable {
        /// `results`, `pages`, `chars`, `files`, `matches`, `chats`, `value`,
        /// `exit` or `items`.
        public let kind: String
        public let n: Int?
        public let value: String?

        public init(kind: String, n: Int? = nil, value: String? = nil) {
            self.kind = kind
            self.n = n
            self.value = value
        }
    }

    /// `ToolCallApproval`: the receipt as of the call's end (INV-18).
    public struct Approval: Equatable, Sendable {
        public let id: String
        /// One of the nine receipt statuses; a stored non-terminal one reads
        /// back as `expired`.
        public let status: String
        public let riskClass: String?
        public let decision: String?
        public let decidedAt: Date?
        public let expiresAt: Date?

        public init(
            id: String,
            status: String,
            riskClass: String? = nil,
            decision: String? = nil,
            decidedAt: Date? = nil,
            expiresAt: Date? = nil
        ) {
            self.id = id
            self.status = status
            self.riskClass = riskClass
            self.decision = decision
            self.decidedAt = decidedAt
            self.expiresAt = expiresAt
        }
    }

    /// `ToolWebDetail`: what a search or a page read found.
    public struct Web: Equatable, Sendable {
        public struct Result: Equatable, Sendable {
            /// The number the model was given for it, when results were numbered.
            public let n: Int?
            public let title: String
            public let url: String
            public init(n: Int? = nil, title: String, url: String) {
                self.n = n
                self.title = title
                self.url = url
            }
        }

        public let query: String?
        public let engine: String?
        public let results: [Result]
        public let requestedURL: String?
        public let finalURL: String?
        /// `html`, `pdf`, `text`, `json` or `xml`.
        public let contentType: String?
        public let pages: Int?
        public let chars: Int?
        public let totalChars: Int?
        public let links: [String]
        /// `suspicious` or `hostile`: the page tried to instruct the assistant.
        public let injection: String?

        public init(
            query: String? = nil,
            engine: String? = nil,
            results: [Result] = [],
            requestedURL: String? = nil,
            finalURL: String? = nil,
            contentType: String? = nil,
            pages: Int? = nil,
            chars: Int? = nil,
            totalChars: Int? = nil,
            links: [String] = [],
            injection: String? = nil
        ) {
            self.query = query
            self.engine = engine
            self.results = results
            self.requestedURL = requestedURL
            self.finalURL = finalURL
            self.contentType = contentType
            self.pages = pages
            self.chars = chars
            self.totalChars = totalChars
            self.links = links
            self.injection = injection
        }
    }

    public let callID: String
    public let providerCallID: String?
    /// The canonical tool id: `web_search`, `web_fetch`, `run_code`, `mcp`, …
    public let tool: String
    /// `juno`, `connector` or `provider`.
    public let origin: String
    /// The English human title — never shown (INV-28); phrases come from
    /// ``NativeToolPresentation``.
    public let title: String
    public let connectorID: String?
    public let connectorLabel: String?
    /// A connector's own tool title, verbatim (third-party text).
    public let toolTitle: String?
    public var status: Status
    public let round: Int
    public let index: Int
    public let startedAt: Date?
    public let endedAt: Date?
    public let durationMs: Int?
    public let timeoutMs: Int?
    /// The safe presentation parameters (`ToolSpec.present`), as strings.
    public let args: [String: String]
    public let figure: Figure?
    public let errorCode: String?
    /// One line, shown verbatim under the failure phrase (third-party text).
    public let errorDetail: String?
    public let approval: Approval?
    public let web: Web?
    /// Served from the turn's duplicate cache.
    public let cached: Bool
    /// What a `run_code` / `check_run` call left behind (`call.run`): where it
    /// ran, its exit, its output, its files. Nil on every other tool.
    public let run: NativeToolRun?
    /// The last lines of a run still going (`call.progress`). Live only.
    public let progress: NativeToolRunProgress?

    /// The approval receipt's status as of the call's end.
    public var approvalStatus: String? { approval?.status }

    public init(
        callID: String,
        providerCallID: String? = nil,
        tool: String,
        origin: String = "juno",
        title: String = "",
        connectorID: String? = nil,
        connectorLabel: String? = nil,
        toolTitle: String? = nil,
        status: Status,
        round: Int = 0,
        index: Int = 0,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        durationMs: Int? = nil,
        timeoutMs: Int? = nil,
        args: [String: String] = [:],
        figure: Figure? = nil,
        errorCode: String? = nil,
        errorDetail: String? = nil,
        approval: Approval? = nil,
        web: Web? = nil,
        cached: Bool = false,
        run: NativeToolRun? = nil,
        progress: NativeToolRunProgress? = nil
    ) {
        self.callID = callID
        self.providerCallID = providerCallID
        self.tool = tool
        self.origin = origin
        self.title = title
        self.connectorID = connectorID
        self.connectorLabel = connectorLabel
        self.toolTitle = toolTitle
        self.status = status
        self.round = round
        self.index = index
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.durationMs = durationMs
        self.timeoutMs = timeoutMs
        self.args = args
        self.figure = figure
        self.errorCode = errorCode
        self.errorDetail = errorDetail
        self.approval = approval
        self.web = web
        self.cached = cached
        self.run = run
        self.progress = progress
    }
}

/// Answer-channel text from a round that ended in tool calls: the model
/// talking while it works, kept out of the answer.
public struct NativeRunCommentary: Equatable, Sendable {
    public let round: Int
    public let text: String
    /// True when it streamed into the answer area live; false when the
    /// provider declared it commentary up front. Only inline commentary shows
    /// above the answer at rest (SPEC §7.5).
    public let inline: Bool

    public init(round: Int, text: String, inline: Bool) {
        self.round = round
        self.text = text
        self.inline = inline
    }
}

/// Where a reasoning segment starts in the flat reasoning string.
public struct NativeReasoningSegment: Equatable, Sendable {
    public let round: Int
    public let part: Int?
    /// A UTF-16 offset into the message's `reasoning`.
    public let offset: Int

    public init(round: Int, part: Int? = nil, offset: Int) {
        self.round = round
        self.part = part
        self.offset = offset
    }
}

/// A typed notice (`RunNotice`), by code. The code is authoritative; the
/// legacy title never shows on a typed notice (SPEC §7.6).
public struct NativeRunNotice: Equatable, Sendable {
    /// The five codes a reader must act on — the only ones the server sends
    /// as `kind: "warning"` (SPEC §2.4).
    public static let mustActCodes: Set<String> = [
        "finish_length", "usage_limit", "connector_unavailable", "hostile_content", "research_skipped",
    ]

    public let code: String
    public let params: [String: String]

    public init(code: String, params: [String: String] = [:]) {
        self.code = code
        self.params = params
    }

    public var isMustAct: Bool { Self.mustActCodes.contains(code) }
}

/// A typed turn fact (`RunFact`), for the Activity panel's Details.
public enum NativeRunFact: Equatable, Sendable {
    public struct Connector: Equatable, Sendable {
        public let id: String
        public let label: String
        /// Ready connectors: how many tools they brought.
        public let tools: Int?
        /// Failed connectors: `auth_expired`, `unreachable`, `misconfigured`,
        /// `timeout` or `not_linked`.
        public let reason: String?

        public init(id: String, label: String, tools: Int? = nil, reason: String? = nil) {
            self.id = id
            self.label = label
            self.tools = tools
            self.reason = reason
        }
    }

    public struct Research: Equatable, Sendable {
        public let runID: String
        public let title: String
        public let workedMs: Int
        public let cited: Int
        public let read: Int
        public let pages: Int
        public let leadModel: String
        /// `completed` or `partially_completed`.
        public let state: String

        public init(
            runID: String, title: String, workedMs: Int, cited: Int, read: Int, pages: Int, leadModel: String,
            state: String
        ) {
            self.runID = runID
            self.title = title
            self.workedMs = workedMs
            self.cited = cited
            self.read = read
            self.pages = pages
            self.leadModel = leadModel
            self.state = state
        }
    }

    case model(modelID: String, provider: String, label: String, routed: Bool)
    case effort(effort: String, auto: Bool)
    case context(historyMessages: Int, attachments: Int, projectFiles: Int)
    case tools(offered: [String], nativeSearch: Bool, roundBudget: Int)
    case connectors(ready: [Connector], failed: [Connector])
    case memory
    case research(Research)
}

// MARK: - The run view

/// A turn's run — its thinking, tool calls and notices in the order they
/// happened — as the transcript's run block and the Activity panel read it
/// (SPEC §7.2, `RunView`).
///
/// Built from the message's activity by
/// ``build(activity:reasoning:reasoningParts:sources:)``: typed when the
/// server sent `seq` on its events (the timeline grammar), and otherwise by the
/// legacy adapter (SPEC §7.7), which reads profile-1 rows — the only place a
/// title is matched (INV-28).
public struct NativeRunView: Equatable, Sendable {
    public enum Item: Equatable, Sendable, Identifiable {
        case reasoning(id: String, text: String)
        case commentary(id: String, text: String, inline: Bool)
        case tool(id: String, call: NativeToolCall, detail: NativeToolDetail?)
        /// A typed notice carries its code; a legacy warning only its words.
        case notice(id: String, notice: NativeRunNotice?, title: String, detail: String?)

        public var id: String {
            switch self {
            case .reasoning(let id, _), .commentary(let id, _, _), .tool(let id, _, _), .notice(let id, _, _, _): id
            }
        }

        public var call: NativeToolCall? {
            if case .tool(_, let call, _) = self { return call }
            return nil
        }

        public var isReasoning: Bool {
            if case .reasoning = self { return true }
            return false
        }

        public var isCommentary: Bool {
            if case .commentary = self { return true }
            return false
        }
    }

    public struct Counts: Equatable, Sendable {
        public var sources = 0
        public var searches = 0
        public var codeRuns = 0
        public var filesCreated = 0
        public var connectorsUsed: [String] = []
        public var filesRead: [String] = []
        public var failedTools = 0
        /// Notices a reader must act on (the must-act codes, or a legacy
        /// warning row).
        public var warnings = 0

        public init() {}
    }

    public struct Timing: Equatable, Sendable {
        public var startedAt: Date?
        public var firstAnswerAt: Date?
        public var endedAt: Date?
        /// Tool time after the first answer token (a tool that re-entered a
        /// working phase), as the union of those calls' intervals.
        public var postAnswerToolMs: Int = 0

        public init(startedAt: Date? = nil, firstAnswerAt: Date? = nil, endedAt: Date? = nil) {
            self.startedAt = startedAt
            self.firstAnswerAt = firstAnswerAt
            self.endedAt = endedAt
        }

        /// The honest working time (SPEC §7.2): to the first answer token, or
        /// to the end when there was none, plus tool time after the answer
        /// started. Nil when a timestamp is missing — no figure is invented.
        public var workedMs: Int? {
            guard let startedAt, let until = firstAnswerAt ?? endedAt, until >= startedAt else { return nil }
            return Int((until.timeIntervalSince(startedAt) * 1_000).rounded()) + postAnswerToolMs
        }
    }

    /// The turn's facts, for the Details view. Typed facts win; the legacy
    /// rows' words fill in on a profile-1 turn.
    public struct Facts: Equatable, Sendable {
        public struct ContextCounts: Equatable, Sendable {
            public let historyMessages: Int
            public let attachments: Int
            public let projectFiles: Int
        }

        /// The model's display name.
        public var model: String?
        public var modelProvider: String?
        public var modelRouted = false
        /// The effort rung's wire value (`high`), or a legacy row's words.
        public var effort: String?
        public var effortAuto = false
        /// A legacy context row's detail ("3 messages").
        public var context: String?
        public var contextCounts: ContextCounts?
        /// Canonical tool ids the turn offered.
        public var toolsOffered: [String] = []
        public var connectorsReady: [NativeRunFact.Connector] = []
        public var connectorsFailed: [NativeRunFact.Connector] = []
        /// A legacy "Connected tools ready" row's detail.
        public var connectors: String?
        public var memory: [NativeMemoryReceipt] = []
        public var research: NativeRunFact.Research?

        public init() {}

        public var isEmpty: Bool {
            model == nil && effort == nil && context == nil && contextCounts == nil && toolsOffered.isEmpty
                && connectorsReady.isEmpty && connectorsFailed.isEmpty && connectors == nil && memory.isEmpty
        }
    }

    public var typed: Bool
    public var items: [Item]
    public var counts: Counts
    public var timing: Timing
    public var facts: Facts
    public var hasReasoning: Bool

    public var calls: [NativeToolCall] { items.compactMap(\.call) }

    public var notices: [Item] {
        items.filter { if case .notice = $0 { return true } else { return false } }
    }

    /// Inline commentary, for the region above the answer at rest.
    public var inlineCommentary: [String] {
        items.compactMap { if case .commentary(_, let text, true) = $0 { return text } else { return nil } }
    }

    /// The approval receipts calls are waiting on.
    public var pendingApprovalIDs: [String] {
        calls.filter { $0.status == .awaitingApproval }.compactMap { $0.approval?.id }
    }

    /// Whether a settled turn has anything to show: a trivial answer renders
    /// no run block at all.
    public func hasContent(sourceCount: Int) -> Bool {
        hasReasoning || !calls.isEmpty || !notices.isEmpty || sourceCount > 0 || items.contains(where: \.isCommentary)
    }

    // MARK: Building

    public static func build(
        activity: [NativeChatActivity],
        reasoning: String?,
        reasoningParts: [String]? = nil,
        sources: [NativeChatSource] = []
    ) -> NativeRunView {
        let typed = activity.contains { $0.seq != nil }
        var view = typed
            ? buildTyped(activity: activity, reasoning: reasoning)
            : buildLegacy(activity: activity, reasoning: reasoning, reasoningParts: reasoningParts)
        view.facts = facts(from: activity)
        view.timing = timing(from: activity, calls: view.calls)
        view.counts = counts(items: view.items, sources: sources)
        return view
    }

    private static func buildTyped(activity: [NativeChatActivity], reasoning: String?) -> NativeRunView {
        let ordered = activity.enumerated().sorted {
            ($0.element.seq ?? Int.max, $0.offset) < ($1.element.seq ?? Int.max, $1.offset)
        }.map(\.element)
        let flat = (reasoning ?? "") as NSString
        let segmentOffsets = ordered.compactMap(\.segment).map(\.offset).sorted()
        var items: [Item] = []
        for event in ordered {
            if let segment = event.segment {
                let end = segmentOffsets.first { $0 > segment.offset } ?? flat.length
                let start = min(max(segment.offset, 0), flat.length)
                let text = flat.substring(with: NSRange(location: start, length: max(0, min(end, flat.length) - start)))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { items.append(.reasoning(id: event.id, text: text)) }
            } else if let commentary = event.commentary {
                let text = commentary.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { items.append(.commentary(id: event.id, text: text, inline: commentary.inline)) }
            } else if let call = event.call {
                items.append(.tool(id: event.id, call: call, detail: event.tool))
            } else if let notice = event.notice {
                items.append(.notice(id: event.id, notice: notice, title: event.title, detail: event.detail))
            } else if event.kind == .warning {
                items.append(.notice(id: event.id, notice: nil, title: event.title, detail: event.detail))
            }
            // Provider-search `visit` rows without a call feed the sources only.
        }
        // A reasoning string with no segments (an older provider path) still
        // reads, first.
        if !items.contains(where: \.isReasoning), let text = reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty
        {
            items.insert(.reasoning(id: "reasoning", text: text), at: 0)
        }
        return NativeRunView(
            typed: true,
            items: items,
            counts: Counts(),
            timing: Timing(),
            facts: Facts(),
            hasReasoning: items.contains(where: \.isReasoning)
        )
    }

    /// The legacy adapter (SPEC §7.7): array order; the reasoning first (one
    /// item per part when the parts are known); connector rows that carry their
    /// detail become calls; the task hand-off's rows become `start_task`;
    /// "Searching the web" rows become provider searches; warnings become
    /// notices. Approval-request rows are dropped — their outcome is unknown —
    /// and visits only feed the sources.
    private static func buildLegacy(
        activity: [NativeChatActivity],
        reasoning: String?,
        reasoningParts: [String]?
    ) -> NativeRunView {
        var items: [Item] = []
        let parts = (reasoningParts ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if parts.count > 1 {
            for (index, part) in parts.enumerated() {
                items.append(.reasoning(id: "reasoning-\(index)", text: part))
            }
        } else if let text = reasoning?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            items.append(.reasoning(id: "reasoning", text: text))
        }
        var index = 0
        for event in activity {
            switch event.kind {
            case .tool:
                if event.title.hasSuffix("needs approval") || event.title == "Starting a task needs your approval" {
                    continue
                }
                if event.title == "Started a task" || event.title == "Task not started" || event.title == "Starting a task" {
                    let status: NativeToolCall.Status = event.title == "Started a task"
                        ? .succeeded : (event.title == "Task not started" ? .failed : .running)
                    items.append(.tool(id: event.id, call: NativeToolCall(
                        callID: event.id, tool: "start_task", origin: "juno", title: event.title,
                        status: status, index: index, startedAt: event.createdAt,
                        args: event.detail.map { ["title": $0] } ?? [:],
                        errorCode: status == .failed ? "tool_error" : nil
                    ), detail: event.tool))
                    index += 1
                } else if event.title.hasPrefix("Using "), let detail = event.tool {
                    let label = String(event.title.dropFirst("Using ".count))
                    var status: NativeToolCall.Status
                    var contractCode: String?
                    let canonical = canonicalToolID(detail.name)
                    let isRun = NativeToolRunPresentation.isRunTool(canonical)
                    switch (detail.status, detail.resultNote) {
                    case ("ok", _): status = .succeeded
                    case ("failed", _): status = .failed
                    case (_, "pending"): status = .running
                    // A run whose call never returned: nobody saw its end, so
                    // the end is unknown (never "cancelled", which would be a
                    // claim about who stopped it).
                    case (_, "unfinished"): status = isRun ? .outcomeUnknown : .cancelled
                    default: status = .succeeded
                    }
                    // The tool contract's fields, when the server sent them,
                    // are the better witness than the legacy pair.
                    if let typed = NativeToolRunWire.status(of: detail) {
                        status = typed.status
                        contractCode = typed.errorCode
                    }
                    var runArgs: [String: String] = [:]
                    if isRun {
                        // The pre-rework tool ran one language.
                        if detail.name == "code_interpreter" { runArgs["language"] = "python" }
                        if let language = detail.run?.language?.rawValue ?? NativeToolRunWire.language(fromArgs: detail.argsTruncated ? nil : detail.args) {
                            runArgs["language"] = language
                        }
                    }
                    let isConnector = detail.name.contains("__")
                    items.append(.tool(id: event.id, call: NativeToolCall(
                        callID: event.id,
                        tool: isConnector ? "mcp" : canonicalToolID(detail.name),
                        origin: isConnector ? "connector" : "juno",
                        title: event.title,
                        connectorLabel: label,
                        toolTitle: humanizedToolName(detail.name),
                        status: status,
                        index: index,
                        startedAt: event.createdAt,
                        durationMs: detail.run?.durationMs ?? detail.durationMs,
                        timeoutMs: detail.timeoutMs,
                        args: runArgs,
                        // A legacy row that never returned is unknown because the
                        // reply ended, not because a server said so: the words
                        // under it must not claim a restart (`reply_ended`).
                        errorCode: contractCode ?? (status == .failed ? "tool_error" : (status == .cancelled ? "cancelled" : (status == .outcomeUnknown && detail.resultNote == "unfinished" ? NativeToolRunPresentation.replyEndedCode : nil))),
                        cached: detail.cached,
                        run: detail.run,
                        progress: detail.progress
                    ), detail: detail))
                    index += 1
                }
            case .search where event.title == "Searching the web":
                items.append(.tool(id: event.id, call: NativeToolCall(
                    callID: event.id,
                    tool: "provider_web_search",
                    origin: "provider",
                    title: event.title,
                    status: .succeeded,
                    index: index,
                    startedAt: event.createdAt,
                    args: event.detail.map { ["query": $0] } ?? [:],
                    web: NativeToolCall.Web(query: event.detail)
                ), detail: nil))
                index += 1
            case .warning:
                items.append(.notice(id: event.id, notice: nil, title: event.title, detail: event.detail))
            default:
                continue
            }
        }
        return NativeRunView(
            typed: false,
            items: items,
            counts: Counts(),
            timing: Timing(),
            facts: Facts(),
            hasReasoning: items.contains(where: \.isReasoning)
        )
    }

    /// A Juno tool's id from the function name the model called (INV-23).
    static func canonicalToolID(_ name: String) -> String {
        switch name {
        case "code_interpreter": "run_code"
        case "browser_agent", "read_page": "web_fetch"
        default: name
        }
    }

    /// `linear__create_issue` → "Create issue".
    static func humanizedToolName(_ name: String) -> String {
        let bare = name.components(separatedBy: "__").last ?? name
        let words = bare.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private static func facts(from activity: [NativeChatActivity]) -> Facts {
        var facts = Facts()
        for event in activity {
            if let fact = event.fact {
                switch fact {
                case .model(_, let provider, let label, let routed):
                    facts.model = label
                    facts.modelProvider = provider
                    facts.modelRouted = routed
                case .effort(let effort, let auto):
                    facts.effort = effort
                    facts.effortAuto = auto
                case .context(let history, let attachments, let projectFiles):
                    facts.contextCounts = Facts.ContextCounts(
                        historyMessages: history, attachments: attachments, projectFiles: projectFiles
                    )
                case .tools(let offered, _, _):
                    facts.toolsOffered = offered
                case .connectors(let ready, let failed):
                    facts.connectorsReady = ready
                    facts.connectorsFailed = failed
                case .memory:
                    if !event.memory.isEmpty { facts.memory = event.memory }
                case .research(let research):
                    facts.research = research
                }
                continue
            }
            switch event.kind {
            case .model where event.title == "Selected model":
                if facts.model == nil { facts.model = event.detail }
            case .reasoning where event.title == "Reasoning mode enabled" || event.title == "Auto thinking":
                if facts.effort == nil { facts.effort = event.detail }
            case .context:
                if !event.memory.isEmpty {
                    facts.memory = event.memory
                } else if event.title.hasPrefix("Reading the conversation") || event.title.hasPrefix("Rebuilding") {
                    facts.context = event.detail
                }
            case .tool where event.title == "Connected tools ready":
                facts.connectors = event.detail
            default:
                if !event.memory.isEmpty { facts.memory = event.memory }
            }
        }
        return facts
    }

    private static func timing(from activity: [NativeChatActivity], calls: [NativeToolCall]) -> Timing {
        var timing = Timing()
        timing.startedAt = activity.compactMap(\.createdAt).min()
        timing.firstAnswerAt = activity.first { $0.kind == .write }?.createdAt
        timing.endedAt = activity.last { $0.kind == .done }?.createdAt
        if let answered = timing.firstAnswerAt {
            // The union of tool intervals that start after the first answer
            // token: re-entered work the clock counted.
            let intervals = calls.compactMap { call -> (Date, Date)? in
                guard let start = call.startedAt, start > answered, let end = call.endedAt, end > start else { return nil }
                return (start, end)
            }.sorted { $0.0 < $1.0 }
            var total: TimeInterval = 0
            var current: (Date, Date)?
            for interval in intervals {
                if let open = current, interval.0 <= open.1 {
                    current = (open.0, max(open.1, interval.1))
                } else {
                    if let open = current { total += open.1.timeIntervalSince(open.0) }
                    current = interval
                }
            }
            if let open = current { total += open.1.timeIntervalSince(open.0) }
            timing.postAnswerToolMs = Int((total * 1_000).rounded())
        }
        return timing
    }

    private static func counts(items: [Item], sources: [NativeChatSource]) -> Counts {
        var counts = Counts()
        var urls = Set(sources.map(\.url.absoluteString))
        var connectors: [String] = []
        for item in items {
            switch item {
            case .tool(_, let call, _):
                switch call.tool {
                case "web_search", "provider_web_search", "provider_x_search": counts.searches += 1
                case "run_code":
                    counts.codeRuns += 1
                    if let files = call.run?.files, !files.isEmpty {
                        counts.filesCreated += files.count
                    } else if call.figure?.kind == "files" {
                        counts.filesCreated += call.figure?.n ?? 0
                    }
                case "web_fetch":
                    if call.status == .succeeded, let final = call.web?.finalURL { urls.insert(final) }
                case "read_document":
                    if let file = call.args["file"] ?? call.args["fileName"], !counts.filesRead.contains(file) {
                        counts.filesRead.append(file)
                    }
                case "mcp":
                    if let label = call.connectorLabel, !connectors.contains(label) { connectors.append(label) }
                default:
                    break
                }
                if call.status == .failed { counts.failedTools += 1 }
            case .notice(_, let notice, _, _):
                if notice?.isMustAct ?? true { counts.warnings += 1 }
            case .reasoning, .commentary:
                break
            }
        }
        counts.sources = urls.count
        counts.connectorsUsed = connectors
        return counts
    }
}

// MARK: - Phase

/// What a run is doing now — the rework's `derivePhase` (SPEC §7.3), first
/// match wins. Chat never shows `writing`: that word belongs to Research.
public enum NativeRunPhase: Equatable, Sendable {
    case queued, thinking, searching, reading, tool, waiting, answering, done, stopped, failed

    /// - Parameters:
    ///   - live: the turn is still streaming.
    ///   - answerStarted: answer text has been released to the answer area.
    ///   - awaitingApproval: an approval card is open on this turn.
    public static func derive(
        view: NativeRunView,
        live: Bool,
        failed: Bool,
        finishReason: NativeChatFinishReason?,
        answerStarted: Bool,
        awaitingApproval: Bool
    ) -> NativeRunPhase {
        guard live else {
            if finishReason == .userStopped { return .stopped }
            if failed { return .failed }
            return .done
        }
        let calls = view.calls
        if awaitingApproval || calls.contains(where: { $0.status == .awaitingApproval }) { return .waiting }
        if let active = calls.last(where: { $0.status.isActive }) {
            return phase(of: active)
        }
        if answerStarted { return .answering }
        return view.hasReasoning ? .thinking : .queued
    }

    /// The working phase a running call puts the run in (rule 3).
    public static func phase(of call: NativeToolCall) -> NativeRunPhase {
        switch call.tool {
        case "web_search", "provider_web_search", "provider_x_search", "search_chats": .searching
        case "web_fetch", "read_document", "inspect_image": .reading
        default: .tool
        }
    }

    /// Working: the glyph loops and the clock runs.
    public var isWorking: Bool {
        switch self {
        case .queued, .thinking, .searching, .reading, .tool: true
        case .waiting, .answering, .done, .stopped, .failed: false
        }
    }

    /// The line is its summary: answering, done, stopped or failed.
    public var isSettled: Bool {
        switch self {
        case .answering, .done, .stopped, .failed: true
        case .queued, .thinking, .searching, .reading, .tool, .waiting: false
        }
    }

    /// Phases that skip the pacer's dwell (SPEC §7.3).
    public var skipsDwell: Bool {
        switch self {
        case .waiting, .answering, .done, .stopped, .failed: true
        case .queued, .thinking, .searching, .reading, .tool: false
        }
    }
}

/// The run's live-line timing states (SPEC §7.3): calm after 20s of work,
/// stalled after 30s of silence, and the two escalation captions.
public struct NativeRunPacing: Equatable, Sendable {
    public static let glyphDelay: TimeInterval = 0.15
    public static let showDelay: TimeInterval = 0.4
    public static let minVisible: TimeInterval = 0.6
    public static let dwell: TimeInterval = 0.7
    public static let sameSubjectSwap: TimeInterval = 1.5
    public static let timerAfter: TimeInterval = 3
    public static let calmAfter: TimeInterval = 20
    public static let stalledAfter: TimeInterval = 30
    public static let escalateAfter: TimeInterval = 120
    public static let escalateAgainAfter: TimeInterval = 600

    /// Whether the run has gone calm: 20s of continuous work.
    public static func calm(working: TimeInterval, stalled: Bool) -> Bool {
        stalled || working >= calmAfter
    }

    /// Stalled: a working phase other than waiting, 30s without a frame, and
    /// no call running within its own timeout (a long `run_code` sends
    /// nothing and is not a stall).
    public static func stalled(
        phase: NativeRunPhase,
        view: NativeRunView,
        lastEventAt: Date?,
        now: Date
    ) -> Bool {
        guard phase.isWorking, let lastEventAt, now.timeIntervalSince(lastEventAt) >= stalledAfter else { return false }
        let runningWithinTimeout = view.calls.contains { call in
            guard call.status == .running else { return false }
            guard let timeout = call.timeoutMs, let started = call.startedAt else { return true }
            return now.timeIntervalSince(started) * 1_000 < Double(timeout)
        }
        return !runningWithinTimeout
    }

    /// 0, 1 after two minutes of work, 2 after ten.
    public static func escalation(working: TimeInterval) -> Int {
        if working >= escalateAgainAfter { return 2 }
        if working >= escalateAfter { return 1 }
        return 0
    }
}

/// The live label's pacer (SPEC §7.3): a shown label stays at least 600ms,
/// changes are at least 700ms apart and the newest phase wins; a new subject
/// in the same phase swaps only after 1.5s; waiting and the settled phases
/// skip the dwell. Pure: the view asks it what to show and when to ask again.
public struct NativeRunLabelPacer: Equatable, Sendable {
    public struct Shown: Equatable, Sendable {
        public let phase: NativeRunPhase
        public let subject: String
        public let at: Date
    }

    public private(set) var shown: Shown?

    public init() {}

    /// Offers the derived phase and subject at `now`. Returns true when the
    /// shown label changed; `nextCheck` says when a held change may land.
    @discardableResult
    public mutating func offer(phase: NativeRunPhase, subject: String, now: Date) -> Bool {
        guard let current = shown else {
            shown = Shown(phase: phase, subject: subject, at: now)
            return true
        }
        if current.phase == phase, current.subject == subject { return false }
        let since = now.timeIntervalSince(current.at)
        if phase.skipsDwell || since >= Self.minimumGap(from: current, to: phase) {
            shown = Shown(phase: phase, subject: subject, at: now)
            return true
        }
        return false
    }

    /// When a change offered now, and held, could be shown.
    public func nextCheck(phase: NativeRunPhase, subject: String) -> Date? {
        guard let current = shown, current.phase != phase || current.subject != subject else { return nil }
        return current.at.addingTimeInterval(Self.minimumGap(from: current, to: phase))
    }

    private static func minimumGap(from current: Shown, to phase: NativeRunPhase) -> TimeInterval {
        current.phase == phase ? NativeRunPacing.sameSubjectSwap : max(NativeRunPacing.dwell, NativeRunPacing.minVisible)
    }
}
