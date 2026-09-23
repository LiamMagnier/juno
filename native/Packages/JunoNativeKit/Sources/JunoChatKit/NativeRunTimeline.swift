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
        durationMs: Int? = nil
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

/// A typed tool call, updated in place under one id — the rework's
/// `ToolCallRecord` (Tool calls & research SPEC §2.4). Decoded when the server
/// sends it; today's server sends none, and ``NativeRunView`` builds the same
/// shape from the legacy rows instead.
public struct NativeToolCall: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case queued
        case awaitingApproval = "awaiting_approval"
        case running, succeeded, failed, denied, expired, cancelled

        /// Unknown statuses read as running, as the SPEC's mirror checklist asks.
        public init(wire: String?) {
            self = wire.flatMap(Status.init(rawValue:)) ?? .running
        }

        public var isTerminal: Bool {
            switch self {
            case .succeeded, .failed, .denied, .expired, .cancelled: true
            case .queued, .awaitingApproval, .running: false
            }
        }
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

    public struct Web: Equatable, Sendable {
        public struct Result: Equatable, Sendable {
            public let title: String
            public let url: String
            public init(title: String, url: String) {
                self.title = title
                self.url = url
            }
        }

        public let query: String?
        public let results: [Result]
        public let requestedURL: String?
        public let finalURL: String?
        public let pages: Int?
        public let chars: Int?

        public init(
            query: String? = nil,
            results: [Result] = [],
            requestedURL: String? = nil,
            finalURL: String? = nil,
            pages: Int? = nil,
            chars: Int? = nil
        ) {
            self.query = query
            self.results = results
            self.requestedURL = requestedURL
            self.finalURL = finalURL
            self.pages = pages
            self.chars = chars
        }
    }

    public let callID: String
    /// The canonical tool id: `web_search`, `web_fetch`, `run_code`, `mcp`, …
    public let tool: String
    /// `juno`, `connector` or `provider`.
    public let origin: String
    /// The English human title — for legacy consumers only; phrases come from
    /// ``NativeToolPresentation``.
    public let title: String
    public let connectorLabel: String?
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
    /// The approval receipt's status as of the call's end.
    public let approvalStatus: String?
    public let web: Web?

    public init(
        callID: String,
        tool: String,
        origin: String = "juno",
        title: String = "",
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
        approvalStatus: String? = nil,
        web: Web? = nil
    ) {
        self.callID = callID
        self.tool = tool
        self.origin = origin
        self.title = title
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
        self.approvalStatus = approvalStatus
        self.web = web
    }
}

/// Answer-channel text from a round that ended in tool calls: the model
/// talking while it works, kept out of the answer.
public struct NativeRunCommentary: Equatable, Sendable {
    public let round: Int
    public let text: String
    /// True when it streamed into the answer area live.
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

/// A typed notice (`RunNotice`), by code.
public struct NativeRunNotice: Equatable, Sendable {
    public let code: String
    public let params: [String: String]

    public init(code: String, params: [String: String] = [:]) {
        self.code = code
        self.params = params
    }
}

// MARK: - The run view

/// A turn's run — its thinking, tool calls and notices in the order they
/// happened — as the transcript's run block and the Activity panel read it.
///
/// Built from the message's activity by ``build(activity:reasoning:reasoningParts:sources:)``:
/// typed when the server sent `seq` on its events (the rework's timeline), and
/// otherwise by the legacy adapter (SPEC §7.7), which reads today's rows —
/// the only place titles are matched.
public struct NativeRunView: Equatable, Sendable {
    public enum Item: Equatable, Sendable, Identifiable {
        case reasoning(id: String, text: String)
        case commentary(id: String, text: String)
        case tool(id: String, call: NativeToolCall, detail: NativeToolDetail?)
        case notice(id: String, title: String, detail: String?)

        public var id: String {
            switch self {
            case .reasoning(let id, _), .commentary(let id, _), .tool(let id, _, _), .notice(let id, _, _): id
            }
        }

        public var call: NativeToolCall? {
            if case .tool(_, let call, _) = self { return call }
            return nil
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
        public var warnings = 0
    }

    public struct Timing: Equatable, Sendable {
        public var startedAt: Date?
        public var firstAnswerAt: Date?
        public var endedAt: Date?

        /// The honest working time: to the first answer token, or to the end
        /// when there was none. Nil when a timestamp is missing — no figure is
        /// invented for it.
        public var workedMs: Int? {
            guard let startedAt, let until = firstAnswerAt ?? endedAt, until >= startedAt else { return nil }
            return Int((until.timeIntervalSince(startedAt) * 1_000).rounded())
        }
    }

    /// The turn's facts, for the Details view.
    public struct Facts: Equatable, Sendable {
        public var model: String?
        public var effort: String?
        public var context: String?
        public var connectors: String?
        public var memory: [NativeMemoryReceipt] = []
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

    /// Whether a settled turn has anything to show: a trivial answer renders
    /// no run block at all.
    public func hasContent(sourceCount: Int) -> Bool {
        hasReasoning || !calls.isEmpty || counts.warnings > 0 || sourceCount > 0
            || items.contains { if case .commentary = $0 { return true } else { return false } }
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
        view.timing = timing(from: activity)
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
                if !text.isEmpty { items.append(.commentary(id: event.id, text: text)) }
            } else if let call = event.call {
                items.append(.tool(id: event.id, call: call, detail: event.tool))
            } else if event.kind == .warning {
                items.append(.notice(id: event.id, title: event.title, detail: event.detail))
            }
        }
        // A reasoning string with no segments (an older provider path) still
        // reads, first.
        let hasSegments = items.contains { if case .reasoning = $0 { return true } else { return false } }
        if !hasSegments, let text = reasoning?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            items.insert(.reasoning(id: "reasoning", text: text), at: 0)
        }
        return NativeRunView(
            typed: true,
            items: items,
            counts: Counts(),
            timing: Timing(),
            facts: Facts(),
            hasReasoning: items.contains { if case .reasoning = $0 { return true } else { return false } }
        )
    }

    /// The legacy adapter (SPEC §7.7): array order; the reasoning first (one
    /// item per part when the parts are known); connector rows that carry their
    /// detail become calls; the task hand-off's rows become `start_task`; deep
    /// research's "Searching the web" rows become searches; warnings become
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
                        args: event.detail.map { ["title": $0] } ?? [:]
                    ), detail: event.tool))
                    index += 1
                } else if event.title.hasPrefix("Using "), let detail = event.tool {
                    let label = String(event.title.dropFirst("Using ".count))
                    let status: NativeToolCall.Status
                    switch (detail.status, detail.resultNote) {
                    case ("ok", _): status = .succeeded
                    case ("failed", _): status = .failed
                    case (_, "pending"): status = .running
                    case (_, "unfinished"): status = .cancelled
                    default: status = .succeeded
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
                        durationMs: detail.durationMs,
                        errorCode: status == .failed ? "tool_error" : nil
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
                items.append(.notice(id: event.id, title: event.title, detail: event.detail))
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
            hasReasoning: items.contains { if case .reasoning = $0 { return true } else { return false } }
        )
    }

    /// A Juno tool's id from the function name the model called.
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
            switch event.kind {
            case .model where event.title == "Selected model":
                facts.model = event.detail
            case .reasoning where event.title == "Reasoning mode enabled" || event.title == "Auto thinking":
                facts.effort = event.detail
            case .context:
                if !event.memory.isEmpty {
                    facts.memory = event.memory
                } else if event.title.hasPrefix("Reading the conversation") || event.title.hasPrefix("Rebuilding") {
                    facts.context = event.detail
                }
            case .tool where event.title == "Connected tools ready":
                facts.connectors = event.detail
            default:
                continue
            }
        }
        return facts
    }

    private static func timing(from activity: [NativeChatActivity]) -> Timing {
        var timing = Timing()
        timing.startedAt = activity.compactMap(\.createdAt).min()
        timing.firstAnswerAt = activity.first { $0.kind == .write }?.createdAt
        timing.endedAt = activity.last { $0.kind == .done }?.createdAt
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
                    if call.figure?.kind == "files" { counts.filesCreated += call.figure?.n ?? 0 }
                case "web_fetch":
                    if call.status == .succeeded, let final = call.web?.finalURL { urls.insert(final) }
                case "read_document":
                    if let file = call.args["file"] ?? call.args["fileName"] { counts.filesRead.append(file) }
                case "mcp":
                    if let label = call.connectorLabel, !connectors.contains(label) { connectors.append(label) }
                default:
                    break
                }
                if call.status == .failed { counts.failedTools += 1 }
            case .notice:
                counts.warnings += 1
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
/// match wins.
public enum NativeRunPhase: Equatable, Sendable {
    case queued, thinking, searching, reading, tool, waiting, answering, done, stopped, failed

    /// - Parameters:
    ///   - live: the turn is still streaming.
    ///   - answerStarted: answer text has arrived and no tool started since.
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
        if let active = calls.last(where: { $0.status == .running || $0.status == .queued }) {
            switch active.tool {
            case "web_search", "provider_web_search", "provider_x_search", "search_chats": return .searching
            case "web_fetch", "read_document", "inspect_image": return .reading
            default: return .tool
            }
        }
        if answerStarted { return .answering }
        return view.hasReasoning ? .thinking : .queued
    }

    public var isWorking: Bool {
        switch self {
        case .queued, .thinking, .searching, .reading, .tool: true
        case .waiting, .answering, .done, .stopped, .failed: false
        }
    }
}

// MARK: - Words

/// The run's words: tool phrases (SPEC §7.6), failure phrases (§7.6.1), the
/// summary line (§7.6.2) and the live copy. One place, so the transcript's
/// line and the Activity panel can never word the same call two ways.
public enum NativeToolPresentation {
    public static func running(_ call: NativeToolCall) -> String {
        switch call.tool {
        case "web_search", "provider_web_search":
            if let query = query(call) { return "Searching the web for \(quoted(query))" }
            return "Searching the web"
        case "provider_x_search":
            if let query = query(call) { return "Searching X for \(quoted(query))" }
            return "Searching X"
        case "web_fetch":
            if let domain = domain(call) { return "Reading \(domain)" }
            return "Reading a page"
        case "read_document":
            if let file = file(call) { return "Reading \(middleTruncated(file))" }
            return "Reading a document"
        case "inspect_image":
            if let file = file(call) { return "Looking closer at \(middleTruncated(file))" }
            return "Looking closer at an image"
        case "run_code": return "Running code"
        case "search_chats":
            if let query = query(call) { return "Searching your chats for \(quoted(query))" }
            return "Searching your chats"
        case "current_time": return "Checking the time"
        case "calculate": return "Calculating"
        case "start_task": return "Handing this to a task"
        case "suggest_research": return "Suggested research"
        case "mcp":
            let connector = call.connectorLabel ?? "Connector"
            if let title = call.toolTitle { return "\(connector): \(title)" }
            return "Using \(connector)"
        default:
            return call.title.isEmpty ? "Using a tool" : call.title
        }
    }

    public static func done(_ call: NativeToolCall) -> String {
        switch call.tool {
        case "web_search", "provider_web_search":
            if let query = query(call) { return "Searched the web for \(quoted(query))" }
            return "Searched the web"
        case "provider_x_search":
            if let query = query(call) { return "Searched X for \(quoted(query))" }
            return "Searched X"
        case "web_fetch":
            if let domain = domain(call) { return "Read \(domain)" }
            return "Read a page"
        case "read_document":
            if let file = file(call) { return "Read \(middleTruncated(file))" }
            return "Read a document"
        case "inspect_image":
            if let file = file(call) { return "Looked closer at \(middleTruncated(file))" }
            return "Looked closer at an image"
        case "run_code": return "Ran code"
        case "search_chats": return "Searched your chats"
        case "current_time": return "Checked the time"
        case "calculate": return "Calculated"
        case "start_task":
            if let title = call.args["title"] { return "Started a task: \(quoted(title))" }
            return "Started a task"
        case "suggest_research": return "Suggested research"
        case "mcp": return "Used \(call.connectorLabel ?? "a connector")"
        default:
            return call.title.isEmpty ? "Used a tool" : call.title
        }
    }

    /// The failure phrase, by `error.code`. A denial is never a failure.
    public static func failed(_ call: NativeToolCall) -> String {
        switch call.status {
        case .denied: return "You declined this"
        case .expired: return "Approval expired"
        case .cancelled: return "Cancelled"
        default: break
        }
        switch call.errorCode {
        case "timeout":
            if let ms = call.timeoutMs ?? call.durationMs { return "Timed out after \(duration(ms: ms))" }
            return "Timed out"
        case "invalid_args": return "The model sent arguments this tool can't use"
        case "denied": return "You declined this"
        case "expired": return "Approval expired"
        case "blocked": return "Blocked by your settings"
        case "cancelled": return "Cancelled"
        case "url_not_in_prior_context": return "Didn't open a link that wasn't in this conversation"
        case "url_not_allowed": return "This address can't be opened"
        case "url_not_accessible":
            if let domain = domain(call) { return "Couldn't open \(domain)" }
            return "Couldn't open the page"
        case "unsupported_content_type": return "Can't read this kind of file"
        case "too_large": return "Too large to read"
        case "needs_browser": return "Needs a browser"
        case "rate_limited": return "Reading limit reached"
        case "no_results": return "No results"
        default: return "Failed"
        }
    }

    /// The call's phrase for its current status.
    public static func phrase(_ call: NativeToolCall) -> String {
        switch call.status {
        case .queued, .running, .awaitingApproval: running(call)
        case .succeeded: done(call)
        case .failed, .denied, .expired, .cancelled: failed(call)
        }
    }

    /// "10 results", "3 pages", "= 42" — never invented.
    public static func figure(_ call: NativeToolCall) -> String? {
        guard let figure = call.figure else { return nil }
        switch figure.kind {
        case "results": return figure.n.map { plural($0, "result") }
        case "pages": return figure.n.map { plural($0, "page") }
        case "chars":
            return figure.n.map { n in
                n >= 1_000 ? "\(Int((Double(n) / 1_000).rounded()))k characters" : plural(n, "character")
            }
        case "files": return figure.n.map { $0 == 1 ? "1 file created" : "\($0) files created" }
        case "matches": return figure.n.map { $0 == 1 ? "1 match" : "\($0) matches" }
        case "chats": return figure.n.map { plural($0, "chat") }
        case "items": return figure.n.map { plural($0, "item") }
        case "value": return figure.value.map { call.tool == "calculate" ? "= \($0)" : $0 }
        case "exit": return figure.value.map { "exit \($0)" }
        default: return nil
        }
    }

    /// The glyph a call's row wears, as a `JunoIcon` raw name.
    public static func iconName(_ call: NativeToolCall) -> String {
        switch call.tool {
        case "web_search", "provider_web_search", "provider_x_search": "search"
        case "web_fetch": "web"
        case "read_document": "file"
        case "inspect_image": "image"
        case "run_code": "terminal"
        case "search_chats": "message"
        case "current_time": "clock"
        case "calculate": "equal"
        case "start_task": "work"
        case "suggest_research": "research"
        case "mcp": "connectors"
        default: "tools"
        }
    }

    // MARK: Summary

    /// The settled line's lead (SPEC §7.6.2): "Thought for 12s" when the run
    /// only reasoned, "Worked for 12s" when a tool ran, "Answered in 12s"
    /// otherwise. Without a measured duration it invents none: a run that
    /// reasoned says "Thought process", and anything else has no lead — its
    /// facts ("6 sources") are the line.
    public static func summaryLead(_ view: NativeRunView, workedMs: Int?) -> String? {
        guard let workedMs else { return view.hasReasoning ? "Thought process" : nil }
        let time = duration(ms: workedMs)
        if !view.calls.isEmpty { return "Worked for \(time)" }
        if view.hasReasoning { return "Thought for \(time)" }
        return "Answered in \(time)"
    }

    /// At most two facts, non-zero only, in the SPEC's order.
    public static func summaryFacts(_ view: NativeRunView, sourceCount: Int) -> [String] {
        var facts: [String] = []
        let counts = view.counts
        let sources = max(sourceCount, counts.sources)
        if sources > 0 { facts.append(plural(sources, "source")) }
        if counts.codeRuns == 1 { facts.append("ran code") }
        if counts.codeRuns > 1 { facts.append("ran code \(counts.codeRuns) times") }
        if sources == 0, counts.searches > 0 { facts.append(counts.searches == 1 ? "1 search" : "\(counts.searches) searches") }
        if let first = counts.connectorsUsed.first {
            facts.append(counts.connectorsUsed.count > 1 ? "used \(first) and \(counts.connectorsUsed.count - 1) more" : "used \(first)")
        }
        if let file = counts.filesRead.first { facts.append("read \(middleTruncated(file))") }
        if counts.filesCreated > 0 {
            facts.append(counts.filesCreated == 1 ? "1 file created" : "\(counts.filesCreated) files created")
        }
        return Array(facts.prefix(2))
    }

    // MARK: Live copy

    /// The live line's words for a phase.
    ///
    /// The thinking rungs are the web's own (`message-item.tsx`
    /// `StreamStatus`, verbatim): "Thinking", then after two minutes of it
    /// "Still thinking. This can take a few minutes.", then after ten "Still
    /// working. You can leave; the answer will be here." A provider's own
    /// headline for the reasoning in progress wins over "Thinking" when it
    /// has one.
    public static func liveLabel(
        phase: NativeRunPhase,
        view: NativeRunView,
        elapsed: TimeInterval,
        recovering: Bool
    ) -> String {
        if recovering { return "Reconnecting…" }
        switch phase {
        case .waiting:
            return "Waiting for your approval"
        case .searching, .reading, .tool:
            let active = view.calls.filter { $0.status == .running || $0.status == .queued }
            if phase == .reading, active.count > 1 { return "Reading \(active.count) sources" }
            if phase == .searching, active.count > 1 { return "Searching \(active.count) queries" }
            if let call = active.last { return running(call) }
            return "Thinking"
        case .queued, .thinking:
            if elapsed >= 600 { return "Still working. You can leave; the answer will be here." }
            if elapsed >= 120 { return "Still thinking. This can take a few minutes." }
            if let headline = latestHeadline(view) { return headline }
            return "Thinking"
        case .answering, .done:
            return summaryLead(view, workedMs: view.timing.workedMs) ?? "Done"
        case .stopped:
            if let ms = view.timing.workedMs { return "Stopped after \(duration(ms: ms))" }
            return "Stopped"
        case .failed:
            if let ms = view.timing.workedMs { return "Couldn't finish after \(duration(ms: ms))" }
            return "Couldn't finish"
        }
    }

    /// A provider's summary heading — `**Weighing the options**` on a line of
    /// its own — at the head of the latest reasoning item.
    public static func latestHeadline(_ view: NativeRunView) -> String? {
        let reasoning = view.items.reversed().first { if case .reasoning = $0 { return true } else { return false } }
        guard case .reasoning(_, let text)? = reasoning else { return nil }
        for line in text.components(separatedBy: "\n").reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("**"), trimmed.hasSuffix("**"), trimmed.count >= 7 else { continue }
            let inner = String(trimmed.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
            if (3...80).contains(inner.count), !inner.contains("**") { return inner }
        }
        return nil
    }

    // MARK: Formatting

    /// "12s", "1m 4s" — the SPEC's narrow duration.
    public static func duration(ms: Int) -> String {
        let seconds = max(0, Int((Double(ms) / 1_000).rounded()))
        if seconds < 60 { return "\(max(seconds, 1))s" }
        let minutes = seconds / 60
        let rest = seconds % 60
        if minutes < 60 { return rest == 0 ? "\(minutes)m" : "\(minutes)m \(rest)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    /// The live clock: "12s" under a minute, "1:04" from there (D-6).
    public static func clock(seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    public static func plural(_ n: Int, _ noun: String) -> String {
        n == 1 ? "1 \(noun)" : "\(n) \(noun)s"
    }

    /// A query in curly quotes, cut at 40 characters.
    static func quoted(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = trimmed.count > 40 ? String(trimmed.prefix(39)) + "…" : trimmed
        return "\u{201C}\(cut)\u{201D}"
    }

    static func middleTruncated(_ text: String, limit: Int = 32) -> String {
        guard text.count > limit else { return text }
        let head = (limit - 1) / 2
        let tail = limit - 1 - head
        return String(text.prefix(head)) + "…" + String(text.suffix(tail))
    }

    static func query(_ call: NativeToolCall) -> String? {
        let value = call.web?.query ?? call.args["query"] ?? call.args["q"]
        return value.flatMap { $0.isEmpty ? nil : $0 }
    }

    static func file(_ call: NativeToolCall) -> String? {
        call.args["file"] ?? call.args["fileName"] ?? call.args["name"]
    }

    static func domain(_ call: NativeToolCall) -> String? {
        let raw = call.web?.finalURL ?? call.web?.requestedURL ?? call.args["url"] ?? call.args["domain"]
        guard let raw else { return nil }
        guard let host = URL(string: raw)?.host() else { return raw }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
