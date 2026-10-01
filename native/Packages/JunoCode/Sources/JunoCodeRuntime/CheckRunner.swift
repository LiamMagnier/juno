import Foundation
import JunoCodeCore

// Running the project's checks and minting their evidence
// (CODE_AGENT_SPEC §1.8).
//
// Two callers share this: the `run_checks` tool, which the model calls, and
// the stop check's `runCheck` decision, where the runtime runs a recipe check
// itself (Lane A). Either way every command is authorized on its own, through
// `PermissionCoordinator`, exactly as `run_command` would be: the reader's
// rules and the approval ladder decide, and a check the reader has not
// allowed asks like any command. Nothing here can widen what a run may do.
//
// The evidence is a `VerificationRecord` the runtime builds from what it saw
// the command do (its exit code, its output, its duration), stamped with the
// workspace revision it describes. The model's own account of a check never
// becomes one.

/// One check, resolved to the command line that will run.
public struct PlannedCheck: Hashable, Sendable {
    public var check: VerifyCheck
    public var commandLine: String
    /// Whether this is the check's targeted command for the changed files.
    public var isTargeted: Bool

    public init(check: VerifyCheck, commandLine: String, isTargeted: Bool) {
        self.check = check
        self.commandLine = commandLine
        self.isTargeted = isTargeted
    }

    /// What `run_command` would be called with for the same command: what
    /// the approval binds to, and what rules see.
    var commandInput: JSONValue {
        var object: [String: JSONValue] = ["command": .string(commandLine)]
        if let cwd = check.normalizedCwd { object["cwd"] = .string(cwd) }
        return .object(object)
    }

    var actionDigest: String {
        Digests.sha256Hex(JSONValue.object(["tool": "run_command", "input": commandInput]).canonicalJSONString())
    }
}

/// What happened to one planned check.
public struct CheckOutcome: Sendable {
    public var planned: PlannedCheck
    /// The evidence, when the command ran.
    public var record: VerificationRecord?
    /// Why it did not run: refused, declined, or failed to start.
    public var refusal: String?
    /// The test counts, when the output had them.
    public var testsRun: Int?
    public var failures: Int?
    /// Where the whole output was saved, when it was too long to keep in
    /// memory: a `juno://command-output/` path `read_file` pages.
    public var fullOutputPath: String?

    public var passed: Bool { record?.passed ?? false }
}

public struct CheckRunner: Sendable {
    public enum Scope: String, Sendable {
        case targeted
        case full
    }

    private let executor: any CommandExecuting
    private let permissions: PermissionCoordinator
    private let ledger: VerificationLedger
    private let changes: (any WorkspaceChangeDetecting)?
    private let classifier = CommandClassifier()
    private let redactor = SecretRedactor()

    public init(
        executor: any CommandExecuting,
        permissions: PermissionCoordinator,
        ledger: VerificationLedger,
        changes: (any WorkspaceChangeDetecting)? = nil
    ) {
        self.executor = executor
        self.permissions = permissions
        self.ledger = ledger
        self.changes = changes
    }

    // MARK: - Planning

    public enum PlanError: Error, Equatable, Sendable, CustomStringConvertible {
        case unknownChecks([String], known: [String])

        public var description: String {
            switch self {
            case let .unknownChecks(ids, known):
                "No check is named \(ids.joined(separator: ", ")). This project's checks: "
                    + (known.isEmpty ? "none" : known.joined(separator: ", ")) + "."
            }
        }
    }

    /// The checks a call asks for, resolved to command lines.
    ///
    /// - `ids` picks those checks exactly (and still narrows them to their
    ///   targeted command in the targeted scope).
    /// - `targeted` picks, for each changed file, the checks covering it most
    ///   specifically, each with its targeted command when it has one. With
    ///   no changed files it runs the full set, as there is nothing to target.
    /// - `full` runs every check of the given kinds with its full command.
    public static func plan(
        recipe: VerifyRecipe,
        scope: Scope,
        kinds: Set<CheckKind>? = nil,
        ids: [String] = [],
        changedFiles: [String],
        fileExists: (String) -> Bool
    ) throws -> [PlannedCheck] {
        var checks: [VerifyCheck]
        if !ids.isEmpty {
            let unknown = ids.filter { recipe.check(id: $0) == nil }
            guard unknown.isEmpty else {
                throw PlanError.unknownChecks(unknown, known: recipe.checks.map(\.id))
            }
            checks = recipe.checks.filter { ids.contains($0.id) }
        } else if scope == .targeted, !changedFiles.isEmpty {
            checks = recipe.targetedChecks(for: changedFiles, kinds: kinds)
        } else {
            checks = recipe.checks
        }
        if let kinds { checks = checks.filter { kinds.contains($0.kind) } }
        return checks.map { check in
            if scope == .targeted,
               let line = check.targetedCommandLine(changedFiles: changedFiles, fileExists: fileExists)
            {
                return PlannedCheck(check: check, commandLine: line, isTargeted: true)
            }
            return PlannedCheck(check: check, commandLine: check.commandLine, isTargeted: false)
        }
    }

    // MARK: - Permission

    /// Whether every planned command would run without a prompt, by the
    /// reader's rules or the mode: when the stop check may run them itself
    /// rather than sending the model to (§1.4 rule 6). A command that would
    /// ask, or is refused, makes the answer no.
    ///
    /// Also no for a check that could not run here at all (a server, or a
    /// folder this executor cannot start in): the stop check must send the
    /// model rather than run, record nothing, and ask to run it again.
    public func allowedWithoutPrompt(_ planned: [PlannedCheck]) async -> Bool {
        guard !planned.isEmpty else { return false }
        let mode = await permissions.permissionMode
        let rules = await permissions.permissionRules
        for check in planned {
            guard Self.canRun(check, on: executor) else { return false }
            guard case let .permitted(risk, _) = classifier.classify(check.commandLine) else { return false }
            let ruling = PermissionCoordinator.ruling(
                mode: mode,
                risk: risk,
                approvalPolicy: approvalPolicy(for: check.commandLine),
                rule: rules.evaluate(toolName: "run_command", subject: .command(check.commandLine)),
                toolName: "run_command"
            )
            guard ruling == .allow else { return false }
        }
        return true
    }

    /// How a check's command is approved: like `run_command` when it reads
    /// as a build, test, lint or typecheck, and pinned to asking otherwise,
    /// as `run_tests` pins it. A recipe can name anything; a `git push` or an
    /// `npm publish` someone put in it is shown to the reader every time,
    /// Full Access included, unless they saved a rule for that exact command.
    func approvalPolicy(for commandLine: String) -> ApprovalPolicy {
        classifier.checkKind(of: commandLine) != nil ? .byRisk : .alwaysRequiresApproval
    }

    /// Whether `check` can run on `executor` at all.
    static func canRun(_ check: PlannedCheck, on executor: any CommandExecuting) -> Bool {
        let line = check.commandLine
        if ShellBackgrounding.runsInBackground(line) || RunCommandTool.startsLongRunningServer(line) { return false }
        guard let cwd = check.check.normalizedCwd else { return true }
        return (try? WorkspacePath(cwd)) != nil && executor is any DirectoryScopedCommandExecuting
    }

    // MARK: - Running

    /// Runs each check in turn and answers what happened, with the events to
    /// append in order: each check's file changes, then its record. A tool
    /// returns them as side effects; `runAndRecord` appends them itself.
    ///
    /// - Parameter context: the calling tool's, so output streams under its
    ///   row; nil for the stop check's own runs.
    public func run(
        _ planned: [PlannedCheck],
        context: ToolContext?
    ) async -> (outcomes: [CheckOutcome], payloads: [SessionEventPayload]) {
        var outcomes: [CheckOutcome] = []
        var payloads: [SessionEventPayload] = []
        var pendingChanges = 0
        for check in planned {
            if Task.isCancelled { break }
            let (outcome, events) = await runOne(check, context: context, pendingChanges: pendingChanges)
            pendingChanges += events.filter(\.isFileChange).count
            outcomes.append(outcome)
            payloads += events
        }
        return (outcomes, payloads)
    }

    /// Runs the checks and appends their events to the session at once: what
    /// the stop check uses when it runs recipe checks itself.
    @discardableResult
    public func runAndRecord(_ planned: [PlannedCheck]) async -> [CheckOutcome] {
        var outcomes: [CheckOutcome] = []
        for check in planned {
            if Task.isCancelled { break }
            let (outcome, events) = await runOne(check, context: nil, pendingChanges: 0)
            await ledger.append(events)
            outcomes.append(outcome)
        }
        return outcomes
    }

    private func runOne(
        _ planned: PlannedCheck,
        context: ToolContext?,
        pendingChanges: Int
    ) async -> (CheckOutcome, [SessionEventPayload]) {
        let line = planned.commandLine
        var outcome = CheckOutcome(planned: planned)
        // As `run_command` refuses them: a check has to finish, and a server
        // or a background job would hold the run until the timeout.
        if ShellBackgrounding.runsInBackground(line) || RunCommandTool.startsLongRunningServer(line) {
            outcome.refusal = "A check has to finish, and this command starts a server or a background job. Start it with shell_start instead."
            return (outcome, [])
        }
        let risk: ActionRisk
        switch classifier.classify(line) {
        case let .forbidden(reason):
            outcome.refusal = reason
            return (outcome, [])
        case let .permitted(permitted, _):
            risk = permitted
        }
        let place = planned.check.normalizedCwd.map { " in \($0)" } ?? ""
        let authorization = await permissions.authorize(
            toolName: "run_command",
            actionDigest: planned.actionDigest,
            risk: risk,
            summary: "Run check \(planned.check.id)\(place): \(line)",
            approvalPolicy: approvalPolicy(for: line),
            subject: .command(line)
        )
        switch authorization {
        case .allowed:
            break
        case let .approved(request):
            guard request.authorizes(digest: planned.actionDigest, at: Date()) else {
                outcome.refusal = "The approval no longer matches the check."
                return (outcome, [])
            }
        case let .denied(reason):
            outcome.refusal = reason
            return (outcome, [])
        }

        let before = await changes?.snapshot()
        var summaryWindow = HeadTailBuffer(headBytes: 32 * 1_024, tailBytes: 128 * 1_024)
        var capture = context.map {
            CommandOutputCapture(context: $0, headBytes: 4 * 1_024, tailBytes: 16 * 1_024)
        }
        defer { capture?.finish() }
        let timeout = Double(planned.check.effectiveTimeoutSeconds)
        let stream: AsyncThrowingStream<CommandEvent, Error>
        if let cwd = planned.check.normalizedCwd {
            guard let folder = try? WorkspacePath(cwd),
                  let scoped = executor as? any DirectoryScopedCommandExecuting
            else {
                outcome.refusal = "This workspace runs commands only at its root, and the check runs in \(cwd)."
                return (outcome, [])
            }
            stream = scoped.stream(line, timeoutSeconds: timeout, outputLimit: CommandOutputCapture.outputLimit, workingDirectory: folder)
        } else {
            stream = executor.stream(line, timeoutSeconds: timeout, outputLimit: CommandOutputCapture.outputLimit)
        }
        var result: CommandResult?
        do {
            for try await event in stream {
                switch event {
                case let .stdout(text):
                    summaryWindow.append(text)
                    if let context { await capture?.take(.stdout, text, context: context) }
                case let .stderr(text):
                    summaryWindow.append(text)
                    if let context { await capture?.take(.stderr, text, context: context) }
                case let .completed(final):
                    result = final
                }
            }
        } catch {
            outcome.refusal = "The check could not run: \(error)"
            return (outcome, [])
        }
        guard let result, !result.wasCancelled else {
            outcome.refusal = "The check was stopped before it finished."
            return (outcome, [])
        }
        var events: [SessionEventPayload] = []
        if let before, let detector = changes {
            let report = WorkspaceChangeReport.comparing(before: before, after: await detector.snapshot())
            events += RunCommandTool.changeEvents(report)
        }
        let output = summaryWindow.joined { _ in "\n…\n" }
        var testsRun: Int?
        var failures: Int?
        var passed = result.succeeded
        if planned.check.kind == .test {
            let parsed = TestOutputParser.parse(
                command: line, output: output, exitCode: result.exitCode, durationSeconds: result.durationSeconds
            )
            testsRun = parsed.testsRun
            failures = parsed.failures
            passed = parsed.passed
        }
        let record = CheckEvidence.record(
            checkID: planned.check.id,
            command: CheckEvidence.label(command: line, folder: planned.check.normalizedCwd),
            kind: planned.check.kind,
            exitCode: result.exitCode,
            passed: passed && !result.wasTimeout,
            timedOut: result.wasTimeout,
            durationSeconds: result.durationSeconds,
            output: output,
            testsRun: testsRun,
            failures: failures,
            revision: ledger.revision(afterPendingChanges: pendingChanges + events.count),
            redactor: redactor
        )
        events.append(.verificationRecorded(record))
        if let capture, !capture.ends.isWhole, let spill = capture.spill {
            outcome.fullOutputPath = spill.modelPath
        }
        outcome.record = record
        outcome.testsRun = testsRun
        outcome.failures = failures
        return (outcome, events)
    }
}

private extension SessionEventPayload {
    var isFileChange: Bool {
        if case .fileChanged = self { return true }
        return false
    }
}

// MARK: - Evidence

/// Builds a `VerificationRecord` from what a finished command did.
public enum CheckEvidence {
    /// The record for one finished check. The excerpt is the failing tail, or
    /// a one-line pass summary, at most 4 KB, redacted.
    public static func record(
        checkID: String?,
        command: String,
        kind: CheckKind,
        exitCode: Int32,
        passed: Bool,
        timedOut: Bool = false,
        durationSeconds: Double,
        output: String,
        testsRun: Int? = nil,
        failures: Int? = nil,
        revision: Int,
        redactor: SecretRedactor = SecretRedactor()
    ) -> VerificationRecord {
        VerificationRecord(
            checkID: checkID,
            command: command,
            kind: kind,
            exitCode: exitCode,
            passed: passed,
            workspaceRevision: revision,
            durationMs: Int((durationSeconds * 1_000).rounded()),
            excerpt: excerpt(
                output: output, passed: passed, timedOut: timedOut, exitCode: exitCode,
                testsRun: testsRun, failures: failures, redactor: redactor
            )
        )
    }

    /// "38 tests passed" or "2 of 38 tests failed", then on failure the end
    /// of the output, where a build or a runner prints what went wrong.
    public static func excerpt(
        output: String,
        passed: Bool,
        timedOut: Bool = false,
        exitCode: Int32,
        testsRun: Int? = nil,
        failures: Int? = nil,
        redactor: SecretRedactor = SecretRedactor()
    ) -> String {
        var headline: String
        switch (passed, testsRun, failures) {
        case (true, let run?, _):
            headline = "\(run) test\(run == 1 ? "" : "s") passed"
        case (false, let run?, let failed?) where failed > 0:
            headline = "\(failed) of \(run) test\(run == 1 ? "" : "s") failed"
        case (false, nil, let failed?) where failed > 0:
            headline = "\(failed) test\(failed == 1 ? "" : "s") failed"
        case (true, _, _):
            headline = "passed"
        default:
            headline = "failed with exit code \(exitCode)"
        }
        if timedOut { headline = "timed out before it finished" }
        guard !passed else { return headline }
        let tail = output
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(60)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return redactor.redact(tail.isEmpty ? headline : headline + "\n" + tail)
    }

    /// The command as the report shows it: with the folder it ran in, so a
    /// pass in `docs` never reads as the project's `npm test`, and three
    /// packages' `npm test` stay three different rows.
    public static func label(command: String, folder: String?) -> String {
        var folder = folder?.trimmingCharacters(in: .whitespaces) ?? ""
        while folder.hasPrefix("./") { folder.removeFirst(2) }
        while folder.hasSuffix("/") { folder.removeLast() }
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !folder.isEmpty, folder != ".", !trimmed.hasPrefix("cd ") else { return command }
        return "cd \(ShellQuoting.quote(folder)) && \(trimmed)"
    }

    /// The first line of a record's excerpt: its headline.
    public static func headline(of record: VerificationRecord) -> String {
        record.excerpt
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init)?
            .trimmingCharacters(in: CharacterSet(charactersIn: "… ")) ?? (record.passed ? "passed" : "failed")
    }
}

/// Mints evidence for commands the model runs itself through `run_command`
/// and `run_tests`: a command that is exactly one of the project's accepted
/// checks, or one the classifier grades as a workspace build, test, lint or
/// typecheck. Any other command records nothing. The grade never changes the
/// command's risk; it only decides whether its result counts.
public struct CheckEvidenceRecorder: Sendable {
    private let recipes: (any VerifyRecipeProviding)?
    private let ledgers: VerificationLedgers
    private let classifier = CommandClassifier()

    public init(recipes: (any VerifyRecipeProviding)?, ledgers: VerificationLedgers = .shared) {
        self.recipes = recipes
        self.ledgers = ledgers
    }

    /// The accepted recipe, read now; nil without one.
    public var acceptedRecipe: VerifyRecipe? { recipes?.acceptedRecipe() }

    /// What `command` is as a check, or nil: the recipe check it matches
    /// exactly, else the classifier's grade.
    public func classify(command: String, workingDirectory: String?) -> (checkID: String?, kind: CheckKind)? {
        if let check = acceptedRecipe?.match(commandLine: command, workingDirectory: workingDirectory) {
            return (check.id, check.kind)
        }
        if let kind = classifier.checkKind(of: command) {
            return (nil, kind)
        }
        return nil
    }

    /// The record for a command that finished, or nil when it is not a check
    /// or the session has no open ledger (a sub-agent's, for instance).
    ///
    /// - Parameter pendingChanges: how many `fileChanged` events the same
    ///   result reports before this record.
    public func record(
        command: String,
        workingDirectory: String?,
        sessionID: CodeSessionID,
        result: CommandResult,
        output: String,
        testsRun: Int? = nil,
        failures: Int? = nil,
        passed: Bool? = nil,
        pendingChanges: Int
    ) async -> VerificationRecord? {
        guard !result.wasCancelled,
              let (checkID, kind) = classify(command: command, workingDirectory: workingDirectory),
              let ledger = await ledgers.existing(for: sessionID)
        else { return nil }
        let didPass = (passed ?? result.succeeded) && !result.wasTimeout
        return CheckEvidence.record(
            checkID: checkID,
            command: CheckEvidence.label(command: command, folder: workingDirectory),
            kind: kind,
            exitCode: result.exitCode,
            passed: didPass,
            timedOut: result.wasTimeout,
            durationSeconds: result.durationSeconds,
            output: output,
            testsRun: testsRun,
            failures: failures,
            revision: ledger.revision(afterPendingChanges: pendingChanges)
        )
    }
}
