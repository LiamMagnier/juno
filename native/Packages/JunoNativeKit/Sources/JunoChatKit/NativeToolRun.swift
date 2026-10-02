import Foundation

// MARK: - A real run

/// What a `run_code` / `check_run` call left behind — the client projection
/// of the run record (`call.run`, TOOL_RUNTIME_DESIGN.md §6.4). Decoded
/// tolerantly by ``NativeActivityWire``: every field is optional and a field
/// this build does not know costs that field, never the row.
///
/// The web twin is `ToolRunView` (`src/lib/chat/tool-run.ts`). One run, one
/// set of facts, on every surface.
public struct NativeToolRun: Equatable, Sendable {
    public enum Language: String, Equatable, Sendable {
        case python, javascript, bash
    }

    /// Where it ran (§6.1). A hosted run never implies access to the Mac.
    public enum Context: String, Equatable, Sendable {
        case hostedSandbox = "hosted_sandbox"
        case agentComputer = "agent_computer"
        case taskContainer = "task_container"
        case localHost = "local_host"
    }

    public let runID: String?
    /// The run record's own status (`timed_out`, `outcome_unknown`, …), when sent.
    public let status: String?
    public let context: Context?
    public let language: Language?
    public let exitCode: Int?
    public let durationMs: Int?
    public let stdout: NativeToolRunStream?
    public let stderr: NativeToolRunStream?
    public let code: String?
    public let codeTruncated: Bool
    public let files: [NativeToolRunFile]
    /// Files a stopped run made that the conversation did not keep.
    public let filesDiscarded: Int
    public let skillName: String?
    public let agentName: String?
    /// "Show full output": a same-origin path, readable by the owner only.
    public let logPath: String?
    public let finishedLater: Bool

    public init(
        runID: String? = nil,
        status: String? = nil,
        context: Context? = nil,
        language: Language? = nil,
        exitCode: Int? = nil,
        durationMs: Int? = nil,
        stdout: NativeToolRunStream? = nil,
        stderr: NativeToolRunStream? = nil,
        code: String? = nil,
        codeTruncated: Bool = false,
        files: [NativeToolRunFile] = [],
        filesDiscarded: Int = 0,
        skillName: String? = nil,
        agentName: String? = nil,
        logPath: String? = nil,
        finishedLater: Bool = false
    ) {
        self.runID = runID
        self.status = status
        self.context = context
        self.language = language
        self.exitCode = exitCode
        self.durationMs = durationMs
        self.stdout = stdout
        self.stderr = stderr
        self.code = code
        self.codeTruncated = codeTruncated
        self.files = files
        self.filesDiscarded = filesDiscarded
        self.skillName = skillName
        self.agentName = agentName
        self.logPath = logPath
        self.finishedLater = finishedLater
    }
}

/// One output stream, as the server cut it: head, tail and what was left out.
public struct NativeToolRunStream: Equatable, Sendable {
    public let head: String
    public let tail: String?
    public let omittedBytes: Int
    public let totalBytes: Int?

    public init(head: String, tail: String? = nil, omittedBytes: Int = 0, totalBytes: Int? = nil) {
        self.head = head
        self.tail = tail
        self.omittedBytes = omittedBytes
        self.totalBytes = totalBytes
    }
}

/// One file a run produced: a conversation attachment (`origin: "tool_output"`).
public struct NativeToolRunFile: Equatable, Sendable, Identifiable {
    public let attachmentID: String?
    public let name: String
    public let mime: String
    public let bytes: Int?
    /// A same-origin path (`/api/files/…`); absent means "attached, no link on this row".
    public let path: String?
    public let width: Int?
    public let height: Int?

    public var id: String { attachmentID ?? name }
    public var isImage: Bool { mime.lowercased().hasPrefix("image/") }

    public init(attachmentID: String? = nil, name: String, mime: String, bytes: Int? = nil, path: String? = nil, width: Int? = nil, height: Int? = nil) {
        self.attachmentID = attachmentID
        self.name = name
        self.mime = mime
        self.bytes = bytes
        self.path = path
        self.width = width
        self.height = height
    }
}

/// The last lines of a run that is still going (`call.progress`). Live only.
public struct NativeToolRunProgress: Equatable, Sendable {
    /// Increments per frame: the live mark's event key.
    public let seq: Int
    public let lines: [String]
    public let stdoutBytes: Int?
    public let stderrBytes: Int?

    public init(seq: Int = 0, lines: [String] = [], stdoutBytes: Int? = nil, stderrBytes: Int? = nil) {
        self.seq = seq
        self.lines = lines
        self.stdoutBytes = stdoutBytes
        self.stderrBytes = stderrBytes
    }
}

// MARK: - Words

/// How a run is said: the twin of `src/lib/chat/tool-run.ts`. Keep the two in
/// step; the web's `tests/tool-run-presentation.test.ts` and
/// `NativeToolRunTests` assert the same sentences. Never an em-dash.
public enum NativeToolRunPresentation {
    struct Words {
        let running: String
        let queued: String
        let done: String
        let failed: String
        let noun: String
        let cannot: String
    }

    static func words(_ language: NativeToolRun.Language?) -> Words {
        switch language {
        case .python: Words(running: "Running Python", queued: "Starting Python", done: "Ran Python", failed: "Python failed", noun: "Python", cannot: "Couldn't run Python")
        case .javascript: Words(running: "Running JavaScript", queued: "Starting JavaScript", done: "Ran JavaScript", failed: "JavaScript failed", noun: "JavaScript", cannot: "Couldn't run JavaScript")
        case .bash: Words(running: "Running a shell script", queued: "Starting a shell script", done: "Ran a shell script", failed: "Shell script failed", noun: "Shell script", cannot: "Couldn't run the shell script")
        case nil: Words(running: "Running code", queued: "Starting the run", done: "Ran code", failed: "Code failed", noun: "Code", cannot: "Couldn't run the code")
        }
    }

    /// The program's language: the record's, else the call's safe args.
    public static func language(_ call: NativeToolCall) -> NativeToolRun.Language? {
        call.run?.language ?? call.args["language"].flatMap { value -> NativeToolRun.Language? in
            switch value.lowercased() {
            case "python", "python3", "py": .python
            case "javascript", "js", "node", "nodejs": .javascript
            case "bash", "sh", "shell": .bash
            default: nil
            }
        }
    }

    static func skillName(_ call: NativeToolCall) -> String? {
        call.run?.skillName ?? call.args["name"] ?? call.args["skill"]
    }

    static func skillLine(_ call: NativeToolCall, running: Bool) -> String {
        let name = skillName(call)
        if call.tool == "read_skill_file" {
            let path = call.args["path"]
            switch (path, name) {
            case let (path?, name?): return running ? "Reading \(path) from the \(name) skill" : "Read \(path) from the \(name) skill"
            case let (path?, nil): return running ? "Reading \(path)" : "Read \(path)"
            default: return running ? "Reading a skill file" : "Read a skill file"
            }
        }
        if let name { return running ? "Reading the \(name) skill" : "Read the \(name) skill" }
        return running ? "Reading a skill" : "Read a skill"
    }

    static func isSkill(_ call: NativeToolCall) -> Bool {
        call.tool == "use_skill" || call.tool == "read_skill_file"
    }

    /// The row's words for the call's current status.
    public static func label(_ call: NativeToolCall) -> String {
        let w = words(language(call))
        switch call.status {
        case .queued:
            return isSkill(call) ? skillLine(call, running: true) : (call.tool == "check_run" ? "Checking on a run" : w.queued)
        case .running:
            return isSkill(call) ? skillLine(call, running: true) : (call.tool == "check_run" ? "Checking on a run" : w.running)
        case .awaitingApproval:
            return "Waiting for your answer"
        case .succeeded:
            if isSkill(call) { return skillLine(call, running: false) }
            return call.tool == "check_run" && language(call) == nil ? "Checked on a run" : w.done
        case .failed:
            if call.errorCode == "timeout" { return timedOutLabel(call) }
            if ["unavailable", "blocked", "not_permitted"].contains(call.errorCode ?? "") { return isSkill(call) ? "Couldn't use the skill" : w.cannot }
            if isSkill(call) { return skillName(call).map { "Couldn't read the \($0) skill" } ?? "Couldn't read the skill" }
            if let exit = call.run?.exitCode, exit != 0 { return w.failed }
            return call.errorCode == "invalid_args" ? w.cannot : w.failed
        case .cancelled:
            return "Stopped"
        case .outcomeUnknown:
            return "Outcome unknown"
        case .denied:
            return "You declined this run"
        case .expired:
            return "Approval expired"
        }
    }

    static func timedOutLabel(_ call: NativeToolCall) -> String {
        guard let ms = call.timeoutMs ?? call.run?.durationMs ?? call.durationMs else { return "Timed out" }
        return "Timed out after \(limit(ms: ms))"
    }

    /// A time limit as people say it: "90s", "2 min".
    public static func limit(ms: Int) -> String {
        let seconds = Int((Double(ms) / 1_000).rounded())
        if seconds < 120 { return "\(seconds)s" }
        let minutes = Double(seconds) / 60
        return minutes.rounded() == minutes ? "\(Int(minutes)) min" : String(format: "%.1f min", minutes)
    }

    /// "2 files", "1 file", or nil.
    public static func filesFigure(_ count: Int) -> String? {
        count <= 0 ? nil : (count == 1 ? "1 file" : "\(count) files")
    }

    /// "exit 1" on a failure with an exit code, "2 files" on a success.
    public static func figure(_ call: NativeToolCall) -> String? {
        switch call.status {
        case .succeeded: return filesFigure(call.run?.files.count ?? 0)
        case .failed:
            if let exit = call.run?.exitCode, exit != 0, call.errorCode != "timeout" { return "exit \(exit)" }
            return nil
        default: return nil
        }
    }

    /// The whole run in one line: "Ran Python · 2.4s · 2 files".
    public static func summary(_ call: NativeToolCall) -> String {
        switch call.status {
        case .succeeded:
            return [label(call), (call.run?.durationMs ?? call.durationMs).map { NativeToolPresentation.duration(ms: $0) }, figure(call)]
                .compactMap { $0 }.joined(separator: " · ")
        case .failed:
            return [label(call), figure(call)].compactMap { $0 }.joined(separator: " · ")
        case .outcomeUnknown:
            return "Outcome unknown, the server restarted while this ran"
        default:
            return label(call)
        }
    }

    /// One sentence under the row for anything that did not simply finish.
    public static func reason(_ call: NativeToolCall) -> String? {
        switch call.status {
        case .succeeded: return call.run?.finishedLater == true ? "It finished after the reply was interrupted." : nil
        case .cancelled:
            return (call.run?.filesDiscarded ?? 0) > 0 ? "You stopped this run. Files it made were not kept." : "You stopped this run before it finished."
        case .outcomeUnknown:
            return "The server restarted while this ran, so Alevr can't tell whether it finished. It was not run again."
        case .expired: return "Nobody answered in time, so nothing ran."
        case .failed:
            if call.errorCode == "timeout" { return "It was stopped at its time limit." }
            if let detail = call.errorDetail, !detail.isEmpty { return detail }
            let stderr = (call.run?.stderr?.tail ?? call.run?.stderr?.head ?? "")
                .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last
            if let stderr { return String(stderr.prefix(200)) }
            switch call.errorCode {
            case "unavailable": return "The sandbox isn't available right now, so nothing ran."
            case "blocked": return "Blocked by your settings, so nothing ran."
            case "not_permitted": return "Running code isn't available for this chat, so nothing ran."
            case "invalid_args": return "The model sent a request this tool can't use, so nothing ran."
            default: break
            }
            if let exit = call.run?.exitCode, exit != 0 { return "It exited with code \(exit)." }
            return nil
        default: return nil
        }
    }

    /// The detail's context line (§6.1).
    public static func contextLine(_ call: NativeToolCall) -> String? {
        guard let context = call.run?.context else { return nil }
        switch context {
        case .hostedSandbox:
            return call.status.isTerminal
                ? "Ran in Alevr's sandbox: no internet, no access to your Mac"
                : "Running in Alevr's sandbox: no internet, no access to your Mac"
        case .agentComputer: return call.run?.agentName.map { "Ran on \($0)'s computer" } ?? "Ran on the agent's computer"
        case .taskContainer: return "Ran in the task's container"
        case .localHost: return "Ran on your Mac"
        }
    }

    /// "Exit code 0 · 2.4s".
    public static func exitLine(_ call: NativeToolCall) -> String? {
        let parts = [
            call.run?.exitCode.map { "Exit code \($0)" },
            (call.run?.durationMs ?? call.durationMs).map { NativeToolPresentation.duration(ms: $0) },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "12.4 KB not shown".
    public static func omittedNote(_ stream: NativeToolRunStream) -> String? {
        stream.omittedBytes > 0 ? "\(bytes(stream.omittedBytes)) not shown" : nil
    }

    public static func bytes(_ count: Int) -> String {
        if count < 1_024 { return "\(count) B" }
        if count < 1_024 * 1_024 {
            let kb = Double(count) / 1_024
            return count < 10 * 1_024 ? String(format: "%.1f KB", kb) : "\(Int(kb.rounded())) KB"
        }
        return String(format: "%.1f MB", Double(count) / (1_024 * 1_024))
    }

    /// The live region's sentence for a phase, once.
    public static func announcement(_ call: NativeToolCall) -> String {
        switch call.status {
        case .succeeded:
            return figure(call).map { "\(label(call)), \($0)." } ?? "\(label(call))."
        case .failed:
            if let exit = call.run?.exitCode, exit != 0, call.errorCode != "timeout" { return "\(label(call)), exit code \(exit)." }
            return "\(label(call))."
        case .outcomeUnknown:
            return "\(summary(call))."
        default:
            return "\(label(call))."
        }
    }

    /// Run again is a NEW call the person sends, never a replay (§6.6).
    public static func canRunAgain(_ call: NativeToolCall) -> Bool {
        guard call.tool == "run_code" else { return false }
        return call.status == .failed || call.status == .cancelled || call.status == .outcomeUnknown
    }

    /// The composer draft Run again seeds.
    public static func runAgainDraft(_ call: NativeToolCall) -> String {
        let noun: String = switch language(call) {
        case .python: "Python"
        case .javascript: "JavaScript"
        case .bash: "shell script"
        case nil: "code"
        }
        if call.status == .outcomeUnknown { return "The last \(noun) run's outcome is unknown. Run it again as a new run and tell me what it returns." }
        if call.errorCode == "timeout" { return "The last \(noun) run timed out. Try again with a faster approach and tell me what it returns." }
        return "Run the \(noun) again and tell me what it returns."
    }

    /// Whether this call is one of the run tools.
    public static func isRunTool(_ tool: String) -> Bool {
        ["run_code", "check_run", "use_skill", "read_skill_file"].contains(tool)
    }
}
