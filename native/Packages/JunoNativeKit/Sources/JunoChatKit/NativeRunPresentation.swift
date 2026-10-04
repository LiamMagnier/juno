import Foundation

// MARK: - Phrases

/// One translatable unit — the rework's `PhraseSpec` (Tool calls & research
/// SPEC §7.6): at most one fixed phrase, first or last, plus argument nodes.
/// A displayed line is complete phrases joined by the design separator
/// " · ", never a sentence stitched from fragments.
public struct NativeRunPhrase: Equatable, Sendable {
    public enum Part: Equatable, Sendable {
        /// A fixed phrase from the copy table.
        case phrase(String)
        /// A query or title, in curly quotes, cut at 40 characters.
        case quote(String)
        /// A site's host, without `www.`.
        case domain(String)
        /// A file name, middle-truncated at 32 characters.
        case file(String)
        /// A connector label or a third-party tool title, verbatim.
        case label(String)
        case number(Double, approx: Bool)
        /// A duration, narrow ("12s", "1m 4s").
        case duration(ms: Int)
        /// An ISO instant, shown as a short date and time.
        case date(String)
        /// A whole-phrase plural: the number, then `one` or `other`.
        case count(Int, one: String, other: String, approx: Bool)
    }

    public var parts: [Part]

    public init(_ parts: [Part]) {
        self.parts = parts
    }

    public init(_ phrase: String) {
        parts = [.phrase(phrase)]
    }

    public var text: String {
        parts.map(Self.render).joined(separator: " ")
    }

    static func render(_ part: Part) -> String {
        switch part {
        case .phrase(let text), .label(let text), .domain(let text): text
        case .quote(let text): NativeToolPresentation.quoted(text)
        case .file(let text): NativeToolPresentation.middleTruncated(text)
        case .number(let value, let approx): (approx ? "~" : "") + NativeToolPresentation.number(value)
        case .duration(let ms): NativeToolPresentation.duration(ms: ms)
        case .date(let iso): NativeToolPresentation.shortDate(iso)
        case .count(let n, let one, let other, let approx):
            (approx ? "~" : "") + NativeToolPresentation.number(Double(n)) + " " + (n == 1 ? one : other)
        }
    }
}

/// A displayed line: complete phrases joined by " · ".
public struct NativeRunPhraseLine: Equatable, Sendable {
    public var phrases: [NativeRunPhrase]

    public init(_ phrases: [NativeRunPhrase]) {
        self.phrases = phrases
    }

    public var text: String {
        phrases.map(\.text).filter { !$0.isEmpty }.joined(separator: " · ")
    }

    public var isEmpty: Bool { phrases.isEmpty }
}

// MARK: - Words

/// The run's words: tool phrases (SPEC §3.8, §7.6), failure phrases (§7.6.1),
/// notices, the summary line (§7.6.2) and the live copy. One place, so the
/// transcript's line and the Activity panel can never word the same call two
/// ways — and never with the record's English `title` (INV-28).
public enum NativeToolPresentation {
    // MARK: Calls

    /// The running line: "Searching the web for “…”", "GitHub · Create issue".
    public static func runningLine(_ call: NativeToolCall) -> NativeRunPhraseLine {
        switch call.tool {
        case "web_search", "provider_web_search":
            return query(call).map { line(["Searching the web for"], .quote($0)) } ?? single("Searching the web")
        case "search_news":
            return query(call).map { line(["Searching the news for"], .quote($0)) } ?? single("Searching the news")
        case "provider_x_search":
            return query(call).map { line(["Searching X for"], .quote($0)) } ?? single("Searching X")
        case "web_fetch", "find_in_page":
            return domain(call).map { line(["Reading"], .domain($0)) } ?? single("Reading a page")
        case "read_document":
            if call.args["action"] == "search" {
                var phrases = [file(call).map { NativeRunPhrase([.phrase("Searching"), .file($0)]) } ?? NativeRunPhrase("Searching a document")]
                if let query = call.args["query"], !query.isEmpty { phrases.append(NativeRunPhrase([.quote(query)])) }
                return NativeRunPhraseLine(phrases)
            }
            var phrases = [file(call).map { NativeRunPhrase([.phrase("Reading"), .file($0)]) } ?? NativeRunPhrase("Reading a document")]
            if let pages = call.args["pages"], !pages.isEmpty { phrases.append(NativeRunPhrase([.phrase("Pages"), .label(pages)])) }
            return NativeRunPhraseLine(phrases)
        case "inspect_image":
            return file(call).map { line(["Looking closer at"], .file($0)) } ?? single("Looking closer at an image")
        case "run_code", "check_run", "use_skill", "read_skill_file":
            // A real run says what it runs (NativeToolRunPresentation): "Running Python".
            return single(NativeToolRunPresentation.label(call))
        case "search_chats":
            return query(call).map { line(["Searching your chats for"], .quote($0)) } ?? single("Searching your chats")
        case "current_time": return single("Checking the time")
        case "calculate": return single("Calculating")
        case "start_task": return single("Handing this to a task")
        case "suggest_research": return single("Suggested research")
        case "create_agent": return single("Creating an agent")
        case "update_agent", "agent_profile": return single("Updating its profile")
        case "agent_goal", "manage_agent_goal", "agent_goals": return single("Updating its goals")
        case "agent_routine", "manage_agent_routine", "agent_routines": return single("Updating its routines")
        case "agent_memory", "manage_agent_note", "agent_notes": return single("Saving a note")
        case "manage_agent_computer", "agent_computer": return single("Setting up its computer")
        case "computer_screenshot", "computer_screen": return single("Looking at its screen")
        case "computer_click": return single("Clicking on its screen")
        case "computer_type": return single("Typing on its computer")
        case "computer_key": return single("Pressing a key")
        case "computer_scroll": return single("Scrolling its screen")
        case "computer_wait": return single("Waiting on its computer")
        case "computer_shell", "computer_exec": return single("Running a command")
        case "computer_files", "computer_read_file", "computer_read_page": return single("Working with files on its computer")
        case "computer_write_file": return single("Writing a file on its computer")
        case "computer_open_url": return single("Opening a page on its computer")
        case "mcp":
            var phrases = [NativeRunPhrase([.label(call.connectorLabel ?? "Connector")])]
            if let title = call.toolTitle, !title.isEmpty { phrases.append(NativeRunPhrase([.label(title)])) }
            return NativeRunPhraseLine(phrases)
        default:
            return single("Using a tool")
        }
    }

    /// The done line: "Searched the web for “…”", "GitHub · Create issue".
    public static func doneLine(_ call: NativeToolCall) -> NativeRunPhraseLine {
        switch call.tool {
        case "web_search", "provider_web_search":
            return query(call).map { line(["Searched the web for"], .quote($0)) } ?? single("Searched the web")
        case "search_news":
            return query(call).map { line(["Searched the news for"], .quote($0)) } ?? single("Searched the news")
        case "provider_x_search":
            return query(call).map { line(["Searched X for"], .quote($0)) } ?? single("Searched X")
        case "web_fetch", "find_in_page":
            return domain(call).map { line(["Read"], .domain($0)) } ?? single("Read a page")
        case "read_document":
            return file(call).map { line(["Read"], .file($0)) } ?? single("Read a document")
        case "inspect_image":
            return file(call).map { line(["Looked closer at"], .file($0)) } ?? single("Looked closer at an image")
        case "run_code", "check_run", "use_skill", "read_skill_file":
            return single(NativeToolRunPresentation.label(call))
        case "search_chats": return single("Searched your chats")
        case "current_time": return single("Checked the time")
        case "calculate": return single("Calculated")
        case "start_task":
            if let title = call.args["title"], !title.isEmpty { return line(["Started a task"], .quote(title)) }
            return single("Started a task")
        case "suggest_research": return single("Suggested research")
        case "create_agent": return single("Created an agent")
        case "update_agent", "agent_profile": return single("Updated its profile")
        case "agent_goal", "manage_agent_goal", "agent_goals": return single("Updated its goals")
        case "agent_routine", "manage_agent_routine", "agent_routines": return single("Updated its routines")
        case "agent_memory", "manage_agent_note", "agent_notes": return single("Saved a note")
        case "manage_agent_computer", "agent_computer": return single("Updated its computer")
        case "computer_screenshot", "computer_screen": return single("Looked at its screen")
        case "computer_click": return single("Clicked on its screen")
        case "computer_type": return single("Typed on its computer")
        case "computer_key": return single("Pressed a key")
        case "computer_scroll": return single("Scrolled its screen")
        case "computer_wait": return single("Waited on its computer")
        case "computer_shell", "computer_exec": return single("Ran a command")
        case "computer_files", "computer_read_file", "computer_read_page": return single("Worked with files on its computer")
        case "computer_write_file": return single("Wrote a file on its computer")
        case "computer_open_url": return single("Opened a page on its computer")
        case "mcp":
            // The connector and its tool ARE the label, settled or running
            // (web `receiptLabelForCall`): "GitHub · Create issue". Only a call
            // with no tool title falls back to "Used GitHub".
            if let title = call.toolTitle, !title.isEmpty {
                return NativeRunPhraseLine([
                    NativeRunPhrase([.label(call.connectorLabel ?? "Connector")]),
                    NativeRunPhrase([.label(title)]),
                ])
            }
            return NativeRunPhraseLine([NativeRunPhrase([.phrase("Used"), .label(call.connectorLabel ?? "a connector")])])
        default:
            return single("Used a tool")
        }
    }

    /// The failed line (SPEC §7.6.1): what failed, then why. A denial reads
    /// as a denial, never as a failure.
    public static func failedLine(_ call: NativeToolCall) -> NativeRunPhraseLine {
        let reason = failurePhrase(call)
        switch call.tool {
        case "web_fetch":
            let subject = domain(call).map { NativeRunPhrase([.phrase("Couldn't open"), .domain($0)]) }
                ?? NativeRunPhrase("Couldn't open the page")
            if call.status == .failed, ["url_not_accessible", "tool_error", "provider_error", "unknown_tool", nil].contains(call.errorCode) {
                return NativeRunPhraseLine([subject])
            }
            return NativeRunPhraseLine([subject, reason])
        case "run_code", "check_run", "use_skill", "read_skill_file":
            // The run's own words and evidence: "Python failed · exit 1",
            // "Timed out after 2 min", "Stopped", "Outcome unknown".
            // The exit code rides the row's figure slot ("exit 1"), not the line.
            if call.run != nil || NativeToolRunPresentation.language(call) != nil || call.tool != "run_code" {
                return single(NativeToolRunPresentation.label(call))
            }
            if call.status == .failed {
                if let name = call.figure?.value, call.figure?.kind == "exit", !name.isEmpty, name != "0" {
                    return NativeRunPhraseLine([NativeRunPhrase("Code failed"), NativeRunPhrase([.label(name)])])
                }
                return NativeRunPhraseLine(reason.text == "Failed" ? [NativeRunPhrase("Code failed")] : [NativeRunPhrase("Code failed"), reason])
            }
            if call.status == .outcomeUnknown { return single("Outcome unknown") }
            return NativeRunPhraseLine(runningLine(call).phrases + [reason])
        case "start_task":
            return call.status == .failed ? single("Task not started") : NativeRunPhraseLine(runningLine(call).phrases + [reason])
        default:
            return NativeRunPhraseLine(runningLine(call).phrases + [reason])
        }
    }

    /// The failure phrase, by `error.code`; a status that is not a failure
    /// (declined, expired, cancelled) says so instead.
    public static func failurePhrase(_ call: NativeToolCall) -> NativeRunPhrase {
        switch call.status {
        case .denied: return NativeRunPhrase("You declined this")
        case .expired: return NativeRunPhrase("Approval expired")
        case .cancelled: return NativeRunPhrase("Cancelled")
        case .outcomeUnknown: return NativeRunPhrase("Outcome unknown")
        default: break
        }
        switch call.errorCode {
        case "timeout":
            if let ms = call.timeoutMs ?? call.durationMs { return NativeRunPhrase([.phrase("Timed out after"), .duration(ms: ms)]) }
            return NativeRunPhrase("Timed out")
        case "invalid_args": return NativeRunPhrase("The model sent arguments this tool can't use")
        case "denied": return NativeRunPhrase("You declined this")
        case "expired": return NativeRunPhrase("Approval expired")
        case "blocked": return NativeRunPhrase("Blocked by your settings")
        case "cancelled": return NativeRunPhrase("Cancelled")
        case "url_not_in_prior_context": return NativeRunPhrase("Didn't open a link that wasn't in this conversation")
        case "url_not_allowed": return NativeRunPhrase("This address can't be opened")
        case "url_not_accessible":
            if let domain = domain(call) { return NativeRunPhrase([.phrase("Couldn't open"), .domain(domain)]) }
            return NativeRunPhrase("Couldn't open the page")
        case "unsupported_content_type": return NativeRunPhrase("Can't read this kind of file")
        case "too_large": return NativeRunPhrase("Too large to read")
        case "needs_browser": return NativeRunPhrase("Needs a browser")
        case "rate_limited": return NativeRunPhrase("Reading limit reached")
        case "no_results": return NativeRunPhrase("No results")
        default: return NativeRunPhrase("Failed")
        }
    }

    /// The call's line for its current status.
    public static func line(_ call: NativeToolCall) -> NativeRunPhraseLine {
        switch call.status {
        case .queued, .running, .awaitingApproval: runningLine(call)
        case .succeeded: doneLine(call)
        case .failed, .denied, .expired, .cancelled, .outcomeUnknown: failedLine(call)
        }
    }

    /// The call's words for its current status, as one string.
    public static func phrase(_ call: NativeToolCall) -> String {
        line(call).text
    }

    /// Whether the call's row wears the failure ink: failures and expiries,
    /// never a denial the reader chose (SPEC §7.6.1).
    public static func readsAsFailure(_ call: NativeToolCall) -> Bool {
        // An unknown outcome wears the same attention ink: it is not a success.
        call.status == .failed || call.status == .expired || call.status == .outcomeUnknown
    }

    /// The figure — "8 results", "12,480 characters", "Exit code 0" — only
    /// what the server measured, never invented.
    public static func figurePhrase(_ call: NativeToolCall) -> NativeRunPhrase? {
        guard let figure = call.figure else {
            // A run's evidence when no figure was sent: "2 files", "exit 1".
            guard NativeToolRunPresentation.isRunTool(call.tool) else { return nil }
            return NativeToolRunPresentation.figure(call).map { NativeRunPhrase([.label($0)]) }
        }
        switch figure.kind {
        case "results":
            guard let n = figure.n else { return nil }
            return call.tool == "provider_x_search"
                ? NativeRunPhrase([.count(n, one: "post", other: "posts", approx: false)])
                : NativeRunPhrase([.count(n, one: "result", other: "results", approx: false)])
        case "pages": return figure.n.map { NativeRunPhrase([.count($0, one: "page", other: "pages", approx: false)]) }
        case "chars": return figure.n.map { NativeRunPhrase([.count($0, one: "character", other: "characters", approx: false)]) }
        case "files":
            guard let n = figure.n else { return nil }
            return call.tool == "run_code"
                ? NativeRunPhrase([.count(n, one: "file created", other: "files created", approx: false)])
                : NativeRunPhrase([.count(n, one: "file", other: "files", approx: false)])
        case "matches": return figure.n.map { NativeRunPhrase([.count($0, one: "match", other: "matches", approx: false)]) }
        case "chats": return figure.n.map { NativeRunPhrase([.count($0, one: "chat", other: "chats", approx: false)]) }
        case "items": return figure.n.map { NativeRunPhrase([.count($0, one: "item", other: "items", approx: false)]) }
        case "value":
            guard let value = figure.value, !value.isEmpty else { return nil }
            if call.tool == "current_time" { return NativeRunPhrase([.date(value)]) }
            if call.tool == "calculate" {
                if let number = Double(value) { return NativeRunPhrase([.phrase("Result"), .number(number, approx: false)]) }
                return NativeRunPhrase([.phrase("Result"), .label(value)])
            }
            return NativeRunPhrase([.label(value)])
        case "exit":
            guard let value = figure.value, !value.isEmpty else { return nil }
            if let number = Double(value) { return NativeRunPhrase([.phrase("Exit code"), .number(number, approx: false)]) }
            return NativeRunPhrase([.phrase("Exit code"), .label(value)])
        default:
            return nil
        }
    }

    public static func figure(_ call: NativeToolCall) -> String? {
        figurePhrase(call)?.text
    }

    /// The glyph a call's row wears, as a `JunoIcon` raw name — the SPEC's
    /// `ToolIconKind` registry (§3.1).
    public static func iconName(_ call: NativeToolCall) -> String {
        switch call.tool {
        case "web_search", "provider_web_search", "provider_x_search": "search"
        case "web_fetch": "web"
        case "read_document": "file"
        case "inspect_image": "image"
        case "run_code", "check_run": "codeBrackets"
        case "use_skill", "read_skill_file": "skills"
        case "search_chats": "chats"
        case "current_time": "clock"
        case "calculate": "calculator"
        case "start_task": "task"
        case "suggest_research": "research"
        case "update_agent", "agent_profile": "agents"
        case "manage_agent_goal", "agent_goals": "listChecks"
        case "manage_agent_routine", "agent_routines": "clock"
        case "manage_agent_note", "agent_notes": "memory"
        case "manage_agent_computer", "agent_computer": "monitor"
        case "computer_screen", "computer_scroll": "monitor"
        case "computer_click": "crosshair"
        case "computer_type", "computer_key": "keyboard"
        case "computer_wait": "clock"
        case "computer_exec": "terminal"
        case "computer_read_file", "computer_read_page": "file"
        case "computer_write_file": "filePlus"
        case "computer_open_url": "web"
        case "mcp": "connectors"
        default: "tools"
        }
    }

    /// A tool's name in the Details view's "Tools available" list.
    public static func toolName(_ id: String) -> String {
        switch id {
        case "web_search", "provider_web_search": "Web search"
        case "provider_x_search": "X search"
        case "web_fetch": "Reading web pages"
        case "read_document": "Reading documents"
        case "inspect_image": "Looking closer at images"
        case "run_code": "Running code"
        case "search_chats": "Searching your chats"
        case "current_time": "Checking the time"
        case "calculate": "Calculating"
        case "start_task": "Starting a task"
        case "suggest_research": "Suggesting research"
        case "update_agent", "agent_profile": "Updating agent profile"
        case "manage_agent_goal", "agent_goals": "Managing agent goals"
        case "manage_agent_routine", "agent_routines": "Managing agent routines"
        case "manage_agent_note", "agent_notes": "Saving agent notes"
        case "manage_agent_computer", "agent_computer": "Managing agent computer"
        case "computer_screen": "Inspecting screen"
        case "computer_click": "Clicking on screen"
        case "computer_type": "Typing on computer"
        case "computer_key": "Pressing keys"
        case "computer_scroll": "Scrolling screen"
        case "computer_wait": "Waiting on computer"
        case "computer_exec": "Running shell command"
        case "computer_read_file", "computer_read_page": "Reading computer file"
        case "computer_write_file": "Writing computer file"
        case "computer_open_url": "Opening web page"
        case "mcp": "Connector tools"
        default: "Another tool"
        }
    }

    // MARK: Notices

    /// A typed notice's line, by code (SPEC §7.6 table); a legacy warning
    /// keeps its own words.
    public static func noticeLine(_ notice: NativeRunNotice?, title: String, detail: String?) -> NativeRunPhraseLine {
        guard let notice else {
            var phrases = [NativeRunPhrase([.label(title)])]
            if let detail, !detail.isEmpty { phrases.append(NativeRunPhrase([.label(detail)])) }
            return NativeRunPhraseLine(phrases)
        }
        let params = notice.params
        switch notice.code {
        case "model_changed":
            return line(["Switched model to"], .label(params["model"] ?? params["label"] ?? "another model"))
        case "skill_not_applied":
            var phrases = [NativeRunPhrase("A skill couldn't be applied")]
            if let skill = params["skill"] { phrases.append(NativeRunPhrase([.label(skill)])) }
            return NativeRunPhraseLine(phrases)
        case "connector_unavailable":
            var phrases = [NativeRunPhrase([.label(params["connector"] ?? "A connector"), .phrase("couldn't connect")])]
            if let reason = params["reason"] { phrases.append(connectorFailure(reason)) }
            return NativeRunPhraseLine(phrases)
        case "usage_limit": return single("You've reached your usage limit")
        case "stall": return single("The model stopped responding")
        case "finish_length": return single("The answer hit its length limit")
        case "finish_sensitive": return single("The provider stopped this answer")
        case "tool_budget":
            if params["reason"] == "searches" { return single("Reached this turn's search limit") }
            if let steps = params["steps"].flatMap(Int.init) {
                return NativeRunPhraseLine([NativeRunPhrase([.phrase("Stopped using tools after"), .count(steps, one: "step", other: "steps", approx: false)])])
            }
            return single("Stopped using tools")
        case "web_off_lockdown": return single("Web access is off in Lockdown")
        case "provenance_refused": return single("Didn't open a link that wasn't in this conversation")
        case "hostile_content":
            var phrases = [NativeRunPhrase("A page tried to give the assistant instructions")]
            if let host = params["host"] ?? params["domain"] { phrases.append(NativeRunPhrase([.domain(host)])) }
            return NativeRunPhraseLine(phrases)
        case "search_degraded":
            var phrases = [NativeRunPhrase("Search was limited")]
            if let engine = params["engine"] { phrases.append(NativeRunPhrase([.label(engine)])) }
            return NativeRunPhraseLine(phrases)
        case "research_skipped":
            var phrases = [NativeRunPhrase("Research was skipped")]
            if let reason = params["reason"] { phrases.append(researchRefusal(reason)) }
            if let resets = params["resetsOn"] { phrases.append(NativeRunPhrase([.phrase("Resets on"), .date(resets)])) }
            return NativeRunPhraseLine(phrases)
        case "private_tools_limited": return single("Connectors aren't available in private chats")
        case "tools_capped":
            if let dropped = params["dropped"].flatMap(Int.init) {
                return NativeRunPhraseLine([
                    NativeRunPhrase("Some tools weren't offered"),
                    NativeRunPhrase([.count(dropped, one: "tool", other: "tools", approx: false)]),
                ])
            }
            return single("Some tools weren't offered")
        default:
            // A code this build does not know: the legacy words, never nothing.
            return noticeLine(nil, title: title, detail: detail)
        }
    }

    /// `ConnectorFailure` in words.
    public static func connectorFailure(_ reason: String) -> NativeRunPhrase {
        switch reason {
        case "auth_expired": NativeRunPhrase("Sign in again in Settings")
        case "unreachable": NativeRunPhrase("Couldn't be reached")
        case "misconfigured": NativeRunPhrase("Isn't set up correctly")
        case "timeout": NativeRunPhrase("Took too long to connect")
        case "not_linked": NativeRunPhrase("Isn't linked")
        default: NativeRunPhrase("Couldn't connect")
        }
    }

    /// Why Research was refused (SPEC §9.9).
    public static func researchRefusal(_ reason: String) -> NativeRunPhrase {
        switch reason {
        case "plan": NativeRunPhrase("Research is available on paid plans.")
        case "workspace": NativeRunPhrase("This project doesn't allow Research.")
        case "private": NativeRunPhrase("Research isn't available in private chats.")
        case "lockdown": NativeRunPhrase("Research is off (Lockdown).")
        case "live_runs": NativeRunPhrase("Too many research runs are going. Wait for one to finish.")
        case "daily_starts": NativeRunPhrase("You've reached today's research limit.")
        case "budget": NativeRunPhrase("Research needs more of your usage window or monthly allowance than is left.")
        case "not_configured": NativeRunPhrase("Research isn't set up on this server.")
        default: NativeRunPhrase("Research isn't available right now.")
        }
    }

    // MARK: Summary

    /// The settled line's lead (SPEC §7.6.2): "Thought for 12s" when the run
    /// reasoned or ran any call, "Answered in 12s" when neither. Without a
    /// measured duration it invents none: a run that reasoned says "Thought
    /// process", and anything else has no lead — its facts are the line.
    public static func summaryLead(_ view: NativeRunView, workedMs: Int?) -> NativeRunPhrase? {
        if let research = view.facts.research {
            return NativeRunPhrase([.phrase("Researched for"), .duration(ms: research.workedMs)])
        }
        let thought = view.hasReasoning || !view.calls.isEmpty
        guard let workedMs else { return thought ? NativeRunPhrase("Thought process") : nil }
        return NativeRunPhrase([.phrase(thought ? "Thought for" : "Answered in"), .duration(ms: workedMs)])
    }

    /// At most two facts, non-zero only, in the SPEC's order.
    public static func summaryFacts(_ view: NativeRunView, sourceCount: Int) -> [NativeRunPhrase] {
        var facts: [NativeRunPhrase] = []
        let counts = view.counts
        let sources = max(sourceCount, counts.sources)
        if let research = view.facts.research {
            return [NativeRunPhrase([.count(research.cited, one: "source", other: "sources", approx: false)])]
        }
        if sources > 0 { facts.append(NativeRunPhrase([.count(sources, one: "source", other: "sources", approx: false)])) }
        if counts.codeRuns == 1 { facts.append(NativeRunPhrase("ran code")) }
        if counts.codeRuns > 1 {
            facts.append(NativeRunPhrase([.count(counts.codeRuns, one: "code run", other: "code runs", approx: false)]))
        }
        if sources == 0, counts.searches > 0 {
            facts.append(NativeRunPhrase([.count(counts.searches, one: "search", other: "searches", approx: false)]))
        }
        if counts.connectorsUsed.count == 1, let only = counts.connectorsUsed.first {
            facts.append(NativeRunPhrase([.phrase("used"), .label(only)]))
        } else if counts.connectorsUsed.count > 1 {
            facts.append(NativeRunPhrase([
                .count(counts.connectorsUsed.count, one: "connector used", other: "connectors used", approx: false),
            ]))
        }
        if let file = counts.filesRead.first { facts.append(NativeRunPhrase([.phrase("read"), .file(file)])) }
        if counts.filesCreated > 0 {
            facts.append(NativeRunPhrase([.count(counts.filesCreated, one: "file created", other: "files created", approx: false)]))
        }
        return Array(facts.prefix(2))
    }

    /// The whole settled line's words, lead first.
    public static func summaryLine(_ view: NativeRunView, workedMs: Int?, sourceCount: Int) -> NativeRunPhraseLine {
        var phrases: [NativeRunPhrase] = []
        if let lead = summaryLead(view, workedMs: workedMs) { phrases.append(lead) }
        phrases += summaryFacts(view, sourceCount: sourceCount)
        return NativeRunPhraseLine(phrases)
    }

    /// "Stopped after 12s".
    public static func stoppedLine(workedMs: Int?) -> NativeRunPhraseLine {
        guard let workedMs else { return single("Stopped") }
        return NativeRunPhraseLine([NativeRunPhrase([.phrase("Stopped after"), .duration(ms: workedMs)])])
    }

    /// "Couldn't finish · 12s".
    public static func failedRunLine(workedMs: Int?) -> NativeRunPhraseLine {
        var phrases = [NativeRunPhrase("Couldn't finish")]
        if let workedMs { phrases.append(NativeRunPhrase([.duration(ms: workedMs)])) }
        return NativeRunPhraseLine(phrases)
    }

    // MARK: Live copy

    /// The live line's words for a working phase (SPEC §7.3): the running
    /// call's phrase, several reads or searches coalesced into one count,
    /// "Waiting for your approval", or — thinking — the provider's own
    /// headline when it wrote one, else "Thinking".
    public static func liveLine(
        phase: NativeRunPhase,
        view: NativeRunView,
        recovering: Bool
    ) -> NativeRunPhraseLine {
        if recovering { return single("Reconnecting…") }
        switch phase {
        case .waiting:
            return single("Waiting for your approval")
        case .searching, .reading, .tool:
            let active = view.calls.filter(\.status.isActive)
            let coalesced = coalescedActive(active)
            if phase == .reading, coalesced.count > 1 {
                return NativeRunPhraseLine([NativeRunPhrase([.phrase("Reading"), .count(coalesced.count, one: "source", other: "sources", approx: false)])])
            }
            if phase == .searching, coalesced.count > 1 {
                return NativeRunPhraseLine([NativeRunPhrase([.phrase("Searching"), .count(coalesced.count, one: "query", other: "queries", approx: false)])])
            }
            if let call = active.last { return runningLine(call) }
            return single("Thinking")
        case .queued, .thinking:
            if let headline = latestHeadline(view) { return NativeRunPhraseLine([NativeRunPhrase([.label(headline)])]) }
            return single("Thinking")
        case .answering, .done:
            return summaryLine(view, workedMs: view.timing.workedMs, sourceCount: view.counts.sources)
        case .stopped:
            return stoppedLine(workedMs: view.timing.workedMs)
        case .failed:
            return failedRunLine(workedMs: view.timing.workedMs)
        }
    }

    /// The live line as a string (tests and accessibility).
    public static func liveLabel(
        phase: NativeRunPhase,
        view: NativeRunView,
        elapsed: TimeInterval,
        recovering: Bool
    ) -> String {
        liveLine(phase: phase, view: view, recovering: recovering).text
    }

    /// The label's animation identity: the phase and the thing it describes,
    /// never the rendered string, so a clock tick or a token never restarts it.
    public static func subjectKey(phase: NativeRunPhase, view: NativeRunView) -> String {
        switch phase {
        case .searching, .reading, .tool:
            let active = view.calls.filter(\.status.isActive)
            if coalescedActive(active).count > 1 { return "coalesced-\(active.count)" }
            return active.last?.callID ?? ""
        case .queued, .thinking:
            return latestHeadline(view) ?? ""
        default:
            return ""
        }
    }

    /// Calls of the latest kind started within a second of each other.
    private static func coalescedActive(_ active: [NativeToolCall]) -> [NativeToolCall] {
        guard let last = active.last else { return [] }
        let kind = NativeRunPhase.phase(of: last)
        return active.filter { call in
            guard NativeRunPhase.phase(of: call) == kind else { return false }
            guard let a = call.startedAt, let b = last.startedAt else { return true }
            return abs(a.timeIntervalSince(b)) <= 1
        }
    }

    /// The secondary caption inside the live line: the stall caption, else
    /// the escalation rung (SPEC §7.10).
    public static func caption(stalledFor: TimeInterval?, escalation: Int) -> NativeRunPhrase? {
        if let stalledFor {
            return NativeRunPhrase([.phrase("No response for"), .duration(ms: Int(stalledFor * 1_000))])
        }
        switch escalation {
        case 1: return NativeRunPhrase("Still thinking. This can take a few minutes.")
        case 2: return NativeRunPhrase("Still working. You can leave; the answer will be here.")
        default: return nil
        }
    }

    /// A provider's summary heading — `**Weighing the options**` on a line of
    /// its own — at the head of the latest reasoning item.
    public static func latestHeadline(_ view: NativeRunView) -> String? {
        let reasoning = view.items.reversed().first(where: \.isReasoning)
        guard case .reasoning(_, let text)? = reasoning else { return nil }
        return headline(of: text, latest: true)
    }

    /// The first (or last) `**…**` line of a reasoning text, 3–80 characters.
    public static func headline(of text: String, latest: Bool = false) -> String? {
        let lines = text.components(separatedBy: "\n")
        for line in latest ? lines.reversed() : lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("**"), trimmed.hasSuffix("**"), trimmed.count >= 7 else { continue }
            let inner = String(trimmed.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
            if (3...80).contains(inner.count), !inner.contains("**") { return inner }
        }
        return nil
    }

    /// The line's accessible name: a stable noun phrase (SPEC §7.12).
    public static func accessibilityName(
        phase: NativeRunPhase,
        view: NativeRunView,
        live: NativeRunPhraseLine,
        settled: NativeRunPhraseLine,
        warnings: Int
    ) -> String {
        if phase.isSettled {
            var name = "Steps: " + settled.text.replacingOccurrences(of: " · ", with: ", ")
            if warnings > 0 { name += warnings == 1 ? ", 1 warning" : ", \(warnings) warnings" }
            return name
        }
        return "Steps: " + live.text
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
        if seconds >= 3_600 {
            return String(format: "%d:%02d:%02d", seconds / 3_600, (seconds % 3_600) / 60, seconds % 60)
        }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    public static func plural(_ n: Int, _ noun: String) -> String {
        n == 1 ? "1 \(noun)" : "\(number(Double(n))) \(noun)s"
    }

    /// A number in the reader's locale, the way every other count in the app
    /// is formatted.
    static func number(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 1e15 { return Int(value).formatted() }
        return value.formatted(.number.precision(.significantDigits(1...12)))
    }

    static func shortDate(_ iso: String) -> String {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = precise.date(from: iso) ?? plain.date(from: iso) else {
            // A calendar day ("2026-10-01") stays the day it names.
            return iso
        }
        return date.formatted(date: .abbreviated, time: .shortened)
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
        let value = call.args["file"] ?? call.args["fileName"] ?? call.args["name"]
        return value.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The host of the page a read opened: the `present` domain, else the URL
    /// the server reported, without `www.`.
    static func domain(_ call: NativeToolCall) -> String? {
        if let domain = call.args["domain"], !domain.isEmpty { return domain }
        let raw = call.web?.finalURL ?? call.web?.requestedURL ?? call.args["url"]
        guard let raw else { return nil }
        guard let host = URL(string: raw)?.host() else { return raw }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    private static func line(_ phrase: [String], _ argument: NativeRunPhrase.Part) -> NativeRunPhraseLine {
        NativeRunPhraseLine([NativeRunPhrase(phrase.map(NativeRunPhrase.Part.phrase) + [argument])])
    }

    private static func single(_ phrase: String) -> NativeRunPhraseLine {
        NativeRunPhraseLine([NativeRunPhrase(phrase)])
    }
}
