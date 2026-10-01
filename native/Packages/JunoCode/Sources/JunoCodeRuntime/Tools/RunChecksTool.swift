import Foundation
import JunoCodeCore

/// `run_checks`: runs this project's recorded checks and records the results
/// (CODE_AGENT_SPEC §1.8).
///
/// The call itself changes nothing and asks nothing; each command it runs is
/// authorized on its own, through the coordinator, as `run_command` would be,
/// so the reader sees every exact command once (or none, where their rules
/// already allow it). The results are evidence the runtime mints from what
/// each command did, never from what the model says about it.
public struct RunChecksTool: CodeTool {
    private let recipes: any VerifyRecipeProviding
    private let executor: any CommandExecuting
    private let permissions: PermissionCoordinator
    private let ledger: VerificationLedger
    private let changes: (any WorkspaceChangeDetecting)?
    private let workspaceRoot: URL

    public init(
        recipes: any VerifyRecipeProviding,
        executor: any CommandExecuting,
        permissions: PermissionCoordinator,
        ledger: VerificationLedger,
        changes: (any WorkspaceChangeDetecting)?,
        workspaceRoot: URL
    ) {
        self.recipes = recipes
        self.executor = executor
        self.permissions = permissions
        self.ledger = ledger
        self.changes = changes
        self.workspaceRoot = workspaceRoot
    }

    public let name = "run_checks"
    public let description = """
        Run this project's recorded checks and record the results. Targeted \
        runs only the checks whose paths match the files you changed, with \
        each check's narrower command for those files when it has one; full \
        runs every check of the given kinds. The <verify> section of the \
        session state lists the checks. Each command is approved like \
        run_command; the result lists each check with its exit code, duration \
        and the end of a failing output. A check you ran before your last \
        edit does not count.
        """

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "scope": [
                    "type": "string",
                    "enum": ["targeted", "full"],
                    "default": "targeted",
                ],
                "kinds": [
                    "type": "array",
                    "items": ["type": "string", "enum": ["build", "test", "lint", "typecheck"]],
                ],
                "ids": [
                    "type": "array",
                    "items": ["type": "string"],
                    "description": "Specific check ids from <verify>.",
                ],
            ],
        ]
    }

    /// The call reads the recipe; every command it runs is authorized on its
    /// own (see the type's comment), so the call adds no prompt of its own.
    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        if let ids = input["ids"]?.arrayValue?.compactMap(\.stringValue), !ids.isEmpty {
            return "Run checks: " + ids.joined(separator: ", ")
        }
        let scope = input["scope"]?.stringValue == "full" ? "all checks" : "checks for the changed files"
        if let kinds = input["kinds"]?.arrayValue?.compactMap(\.stringValue), !kinds.isEmpty {
            return "Run \(scope): " + kinds.joined(separator: ", ")
        }
        return "Run \(scope)"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let status = await recipes.status()
        guard let recipe = status.usableRecipe, !recipe.isEmpty else {
            return ToolResult(content: Self.noRecipeMessage(status), isError: true)
        }
        let scope = CheckRunner.Scope(rawValue: input["scope"]?.stringValue ?? "targeted") ?? .targeted
        let kinds = input["kinds"]?.arrayValue.map { values in
            Set(values.compactMap { $0.stringValue.flatMap(CheckKind.init(rawValue:)) })
        }
        let ids = input["ids"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let changed = ledger.filesChangedThisRun
        let root = workspaceRoot
        let planned: [PlannedCheck]
        do {
            planned = try CheckRunner.plan(
                recipe: recipe,
                scope: scope,
                kinds: kinds.flatMap { $0.isEmpty ? nil : $0 },
                ids: ids,
                changedFiles: changed,
                fileExists: { FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path) }
            )
        } catch {
            throw ToolError.invalidInput(message: String(describing: error))
        }
        guard !planned.isEmpty else {
            return ToolResult(
                content: "No check matches. This project's checks: "
                    + recipe.checks.map { "\($0.id) (\($0.kind.rawValue))" }.joined(separator: ", ") + "."
            )
        }
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger, changes: changes)
        let (outcomes, payloads) = await runner.run(planned, context: context)
        try Task.checkCancellation()
        let changeCount = payloads.filter {
            if case .fileChanged = $0 { return true } else { return false }
        }.count
        var content = Self.report(outcomes, revision: ledger.revision(afterPendingChanges: changeCount))
        if case .discovered = status {
            content += "\n\nThese checks were found in the project and are not saved yet; the reader can keep them as this project's checks."
        }
        if scope == .targeted, changed.isEmpty, ids.isEmpty {
            content += "\n\nNo files have changed this run, so every check ran."
        }
        let failed = outcomes.contains { !$0.passed }
        return ToolResult(content: content, isError: failed, sideEffects: payloads)
    }

    /// One line per check, then each failure's excerpt.
    static func report(_ outcomes: [CheckOutcome], revision: Int) -> String {
        let passed = outcomes.filter(\.passed).count
        var lines = [
            "\(passed) of \(outcomes.count) check\(outcomes.count == 1 ? "" : "s") passed (workspace revision \(revision)).",
        ]
        for outcome in outcomes {
            let check = outcome.planned.check
            let head = "- \(check.id) (\(check.kind.rawValue)): \(outcome.planned.commandLine)"
            if let record = outcome.record {
                let seconds = String(format: "%.1fs", Double(record.durationMs) / 1_000)
                let verdict = record.passed ? "passed" : "failed (exit \(record.exitCode))"
                lines.append("\(head) — \(verdict) in \(seconds) — \(CheckEvidence.headline(of: record))")
                if !record.passed {
                    let body = record.excerpt
                        .split(separator: "\n", omittingEmptySubsequences: false)
                        .dropFirst()
                    if !body.isEmpty {
                        lines.append(body.map { "    " + $0 }.joined(separator: "\n"))
                    }
                    if let path = outcome.fullOutputPath {
                        lines.append("    The whole output is saved: read it with read_file, path \"\(path)\".")
                    }
                }
            } else {
                lines.append("\(head) — did not run: \(outcome.refusal ?? "unknown reason")")
            }
        }
        return lines.joined(separator: "\n")
    }

    static func noRecipeMessage(_ status: VerifyRecipeStatus) -> String {
        let fallback = "Run the checks you need with run_command meanwhile; Juno records a recognised build, test, lint or typecheck command as evidence."
        switch status {
        case .awaitingAcceptance:
            return "This project's .juno/verify.json changed since the reader accepted it, so its checks are not run until they accept the new version. " + fallback
        case let .invalid(message):
            return message + " " + fallback
        case .accepted, .discovered:
            return "Juno found no checks for this project. Run its build or tests with run_command; Juno records a recognised build, test, lint or typecheck command as evidence."
        }
    }
}

/// The verification tools: `run_checks` (§1.8) and the background sub-agent
/// controls (§5.2), registered for Code turns through `CodeToolProviders`.
///
/// Owned by Lane B (verification, self-review and report). The recipe source
/// and the change detector live in JunoCodeLocal, which this module does not
/// import, so the host hands their factories in.
public struct VerificationToolProvider: CodeToolProvider {
    public typealias RecipeSource = @Sendable (URL) -> any VerifyRecipeProviding
    public typealias ChangeSource = @Sendable (URL) -> (any WorkspaceChangeDetecting)?

    private let recipes: RecipeSource?
    private let changes: ChangeSource?
    private let ledgers: VerificationLedgers

    public init(
        recipes: RecipeSource? = nil,
        changes: ChangeSource? = nil,
        ledgers: VerificationLedgers = .shared
    ) {
        self.recipes = recipes
        self.changes = changes
        self.ledgers = ledgers
    }

    public func tools(for context: CodeToolProviderContext) async -> [any CodeTool] {
        // Opened for every Code turn, so the command tools find it and the
        // evidence they mint lands in the session's ledger.
        let ledger = await ledgers.ledger(for: context.sessionID, store: context.store)
        var tools: [any CodeTool] = []
        if let recipes {
            tools.append(
                RunChecksTool(
                    recipes: recipes(context.workspaceRoot),
                    executor: context.executor,
                    permissions: context.permissions,
                    ledger: ledger,
                    changes: changes?(context.workspaceRoot),
                    workspaceRoot: context.workspaceRoot
                )
            )
        }
        tools += SubagentControlTools.all(parentSessionID: context.sessionID)
        return tools
    }
}
