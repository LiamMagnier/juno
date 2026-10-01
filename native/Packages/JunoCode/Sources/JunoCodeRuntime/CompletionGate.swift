import Foundation
import JunoCodeCore

// The stop check (CODE_AGENT_SPEC §1.4): a pure, deterministic function of
// the run ledger, the project's checks and the goal, asked every time the
// model tries to finish. The model's end of turn is a proposal; this decides
// whether the run ends. It never changes a permission: a check it wants run
// still goes through `PermissionCoordinator`, and a continuation can only keep
// the agent working inside what is already allowed.

// MARK: - What the gate knows about the project's checks

/// One of the project's checks, as the gate needs it. Lane B's verify recipe
/// (`.juno/verify.json`) maps onto this; until it lands, the checks come from
/// the test command the workspace's toolchain suggests.
public struct GateRecipeCheck: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var kind: CheckKind
    /// The command line, as the model would run it.
    public var command: String
    /// Workspace-relative globs whose changes this check covers. Empty covers
    /// every file.
    public var paths: [String]
    /// Whether the reader's rules or task grants already let every command
    /// of this check run without a prompt. Only then does the runtime run it
    /// itself; otherwise the model is asked to, and any approval shows
    /// normally.
    public var runsWithoutPrompt: Bool

    public init(id: String, kind: CheckKind, command: String, paths: [String] = [], runsWithoutPrompt: Bool = false) {
        self.id = id
        self.kind = kind
        self.command = command
        self.paths = paths
        self.runsWithoutPrompt = runsWithoutPrompt
    }

    /// Whether a change to `path` is one this check covers.
    public func covers(_ path: String) -> Bool {
        guard !paths.isEmpty else { return true }
        return paths.contains { pattern in
            (try? GlobPattern(pattern))?.matches(path) ?? false
        }
    }
}

/// A place the running result can be looked at after a UI change.
public struct GateUITarget: Hashable, Codable, Sendable {
    public var surface: UIVerificationSurface
    /// The route (`/settings`), the app or the screen.
    public var target: String
    /// The workspace-relative folder the configuration serves; empty for the
    /// root.
    public var root: String

    public init(surface: UIVerificationSurface, target: String, root: String = "") {
        self.surface = surface
        self.target = target
        self.root = root
    }
}

/// The project's checks and UI targets.
public struct GateRecipe: Hashable, Codable, Sendable {
    public var checks: [GateRecipeCheck]
    public var ui: [GateUITarget]
    /// Where the checks came from, for the `<verify>` section:
    /// ".juno/verify.json", "the Swift Package's test command".
    public var source: String

    public init(checks: [GateRecipeCheck], ui: [GateUITarget] = [], source: String = ".juno/verify.json") {
        self.checks = checks
        self.ui = ui
        self.source = source
    }

    /// The checks the workspace's toolchain suggests, as a stand-in recipe
    /// until the project records its own: each covers every file, and none
    /// runs without the model asking for it.
    public static func suggested(_ suggestions: [TestSuggestion]) -> GateRecipe? {
        guard !suggestions.isEmpty else { return nil }
        var seen = Set<String>()
        let checks = suggestions.compactMap { suggestion -> GateRecipeCheck? in
            guard seen.insert(suggestion.command).inserted else { return nil }
            let kind: CheckKind = suggestion.command.contains("typecheck") ? .typecheck : .test
            let id = suggestion.command
                .lowercased()
                .map { $0.isLetter || $0.isNumber ? $0 : "-" }
                .reduce(into: "") { result, character in
                    if character == "-", result.last == "-" { return }
                    result.append(character)
                }
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            return GateRecipeCheck(id: id.isEmpty ? "check" : id, kind: kind, command: suggestion.command)
        }
        let toolchains = Array(Set(suggestions.map(\.toolchain))).sorted()
        return GateRecipe(checks: checks, source: "the test commands the \(toolchains.joined(separator: " and ")) setup suggests")
    }

    public func check(id: String) -> GateRecipeCheck? {
        checks.first { $0.id == id }
    }

    /// The checks that cover any of `files`, in recipe order.
    public func checks(covering files: Set<String>) -> [GateRecipeCheck] {
        checks.filter { check in files.contains { check.covers($0) } }
    }

    /// The recipe check a recorded result belongs to: by id, else by the
    /// exact command.
    public func check(for record: VerificationRecord) -> GateRecipeCheck? {
        if let id = record.checkID, let match = check(id: id) { return match }
        return checks.first { $0.command == record.command }
    }
}

/// Which changed files count as a UI change for a target (§4.6 trigger rules).
public enum UIChangeTrigger {
    static let webExtensions: Set<String> = [
        "tsx", "jsx", "ts", "js", "vue", "svelte", "astro", "css", "scss", "html", "mdx",
    ]
    static let webFolders: Set<String> = ["public", "app", "pages", "components", "styles"]
    static let nativeExtensions: Set<String> = ["swift", "xib", "storyboard", "strings", "xcassets"]

    /// Whether changing `path` is a UI change for `target`.
    public static func isUIChange(_ path: String, for target: GateUITarget) -> Bool {
        let root = target.root.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard root.isEmpty || path == root || path.hasPrefix(root + "/") else { return false }
        let relative = root.isEmpty ? path : String(path.dropFirst(root.count + 1))
        let components = relative.split(separator: "/").map(String.init)
        let fileExtension = (relative as NSString).pathExtension.lowercased()
        switch target.surface {
        case .web:
            return webExtensions.contains(fileExtension)
                || components.dropLast().contains { webFolders.contains($0) }
        case .mac, .ios:
            return nativeExtensions.contains(fileExtension)
                || components.contains { $0.hasSuffix(".xcassets") }
        }
    }
}

// MARK: - What the gate knows about the moment

/// The state around the end of a turn that bears on whether the agent may be
/// sent back: anything waiting on the reader, the mode, what is still
/// running and which runners exist.
public struct GateSituation: Hashable, Sendable {
    public var behavior: AgentBehavior
    public var pendingApproval: Bool
    public var pendingQuestion: Bool
    public var pendingSteer: Bool
    public var stoppedByReader: Bool
    public var planLimitReached: Bool
    /// Background shells or sub-agents the run is waiting on, in words.
    public var backgroundWork: [String]
    /// Whether the runtime can run the reviewer sub-agent itself.
    public var reviewerAvailable: Bool
    /// Whether the runtime can run recipe checks itself.
    public var checkRunnerAvailable: Bool
    /// Whether the agent can read its diff: a Git repository with `git_diff`.
    /// Without one the stop check never asks for a diff read it cannot do.
    public var diffReadable: Bool

    public init(
        behavior: AgentBehavior = .code,
        pendingApproval: Bool = false,
        pendingQuestion: Bool = false,
        pendingSteer: Bool = false,
        stoppedByReader: Bool = false,
        planLimitReached: Bool = false,
        backgroundWork: [String] = [],
        reviewerAvailable: Bool = false,
        checkRunnerAvailable: Bool = false,
        diffReadable: Bool = true
    ) {
        self.behavior = behavior
        self.pendingApproval = pendingApproval
        self.pendingQuestion = pendingQuestion
        self.pendingSteer = pendingSteer
        self.stoppedByReader = stoppedByReader
        self.planLimitReached = planLimitReached
        self.backgroundWork = backgroundWork
        self.reviewerAvailable = reviewerAvailable
        self.checkRunnerAvailable = checkRunnerAvailable
        self.diffReadable = diffReadable
    }
}

/// What the stop check concluded, before any judge is asked.
public enum GateStep: Equatable, Sendable {
    /// The rules decided.
    case decided(GateDecision)
    /// The goal's deterministic part found misses: the agent goes back with
    /// them, and a `gate_blocked` verdict records why. The judge is not
    /// asked.
    case goalBlocked(GateDecision, unmetCriteria: [String], reason: String)
    /// Every rule passed and a goal is active: the judge decides.
    case judge
}

// MARK: - The gate

/// The stop check's rules, in order; the first match wins.
public struct CompletionGate: Sendable {
    public var settings: AutonomySettings

    public init(settings: AutonomySettings = .standard) {
        self.settings = settings
    }

    /// The most review rounds one run may have.
    public static let maximumReviewRounds = 2

    public func evaluate(
        _ ledger: RunLedger,
        recipe: GateRecipe?,
        goal: GoalRun?,
        situation: GateSituation = GateSituation()
    ) -> GateStep {
        let verdict = ledger.verdict

        // Never continue while the reader holds the next move, in a mode that
        // promises nothing runs, after Stop, or at the account's limit.
        if situation.pendingApproval || situation.pendingQuestion {
            return .decided(.finish(.needsYou))
        }
        if situation.stoppedByReader {
            return .decided(.finish(.stopped))
        }
        if situation.pendingSteer || situation.behavior != .code || situation.planLimitReached {
            return .decided(.finish(verdict))
        }

        // 1. Off: report only.
        guard settings.enforces else { return .decided(.finish(verdict)) }

        // 2. Background work still runs: wait for it.
        if !situation.backgroundWork.isEmpty {
            return .decided(.wait)
        }

        let goalActive = goal?.isActive == true

        // 3. Two continuation turns in a row without a tool call: stalled.
        if ledger.turnsSinceToolCall >= 2, !ledger.continuations.isEmpty {
            return .decided(.finish(.stalled))
        }

        // 4. Out of continuations. With a goal, its budget governs instead.
        if !goalActive, ledger.continuations.count >= settings.maxAutoContinues {
            return .decided(.finish(verdict))
        }

        // 5. Open todos.
        if !ledger.openTodos.isEmpty, !ledger.hasFired(.todosOpen) {
            return .decided(.continueWith(.todosOpen, detail: Self.todosDetail(ledger.openTodos)))
        }

        let changed = !ledger.filesChanged.isEmpty

        // 6. Changed files and no check since the last edit.
        if changed, ledger.latestFreshVerification == nil, let recipe {
            let covering = recipe.checks(covering: ledger.filesChanged)
            if !covering.isEmpty {
                let autoRun = settings.runChecksAutomatically
                    && situation.checkRunnerAvailable
                    && covering.allSatisfy(\.runsWithoutPrompt)
                    && !ledger.autoCheckRevisions.contains(ledger.workspaceRevision)
                if autoRun {
                    return .decided(.runCheck(checkIDs: covering.map(\.id)))
                }
                if !ledger.hasFired(.unverified) {
                    return .decided(.continueWith(.unverified, detail: Self.unverifiedDetail(covering, ledger: ledger)))
                }
            }
        }

        // 7. The newest check since the last edit failed: once per revision,
        //    and never twice in a row for the same failure.
        if let failing = ledger.latestFreshPerCheck.last(where: { !$0.passed }),
           !ledger.hasFired(.checksFailing),
           ledger.lastContinuation(for: .checksFailing)?.signature != Self.signature(of: failing)
        {
            return .decided(.continueWith(.checksFailing, detail: Self.failingDetail(failing)))
        }

        // 8. UI files changed and nobody looked at the result.
        if changed, let recipe, !ledger.hasFired(.uiUnchecked) {
            for target in recipe.ui where settings.autoVerify.isOn(for: target.surface) {
                let touched = ledger.filesChanged.contains { UIChangeTrigger.isUIChange($0, for: target) }
                guard touched else { continue }
                if ledger.freshUIVerifications(surface: target.surface, target: target.target).isEmpty {
                    return .decided(.continueWith(.uiUnchecked, detail: Self.uiDetail(target)))
                }
            }
        }

        // 9. The diff has not been read since the last edit.
        if settings.reviewBeforeFinish != .off, changed, !ledger.diffReadIsFresh {
            let large = ledger.linesChanged > settings.reviewThresholdLines || ledger.filesChanged.count >= 3
            let wantsReviewer = settings.reviewBeforeFinish == .always
                || (settings.reviewBeforeFinish == .auto && large)
            if wantsReviewer, situation.reviewerAvailable, ledger.reviewRounds < Self.maximumReviewRounds {
                return .decided(.runReview)
            }
            if situation.diffReadable, !ledger.hasFired(.diffUnreviewed) {
                return .decided(.continueWith(.diffUnreviewed, detail: Self.diffDetail(ledger)))
            }
        }

        // 10. The latest review found real problems the agent has not answered.
        if let review = ledger.review,
           review.workspaceRevision == ledger.workspaceRevision,
           !review.blockingFindings.isEmpty,
           !ledger.hasFired(.reviewFindings),
           ledger.reviewRounds <= Self.maximumReviewRounds
        {
            return .decided(.continueWith(.reviewFindings, detail: Self.findingsDetail(review.blockingFindings)))
        }

        // 11. An active goal: its deterministic part, then the judge.
        if let goal, goalActive {
            let result = GoalRuntime.evaluateDeterministic(
                goal: goal,
                ledger: ledger,
                recipe: recipe,
                situation: situation,
                runChecksAutomatically: settings.runChecksAutomatically
            )
            if !result.checksToRun.isEmpty {
                return .decided(.runCheck(checkIDs: result.checksToRun))
            }
            if !result.misses.isEmpty {
                let reason = result.misses.joined(separator: "; ")
                return .goalBlocked(
                    .continueWith(.goalNotMet, detail: reason),
                    unmetCriteria: result.unmetCriteria,
                    reason: reason
                )
            }
            if result.needsReview {
                return .decided(.runReview)
            }
            return .judge
        }

        // 12. Done, with the verdict the evidence supports.
        return .decided(.finish(verdict))
    }

    // MARK: - The facts each continuation names

    static func todosDetail(_ todos: [TodoItemRef]) -> String {
        let names = todos.prefix(3).map { "\"\(RunEndWords.firstLine($0.content, limit: 60))\"" }
        let more = todos.count > 3 ? " and \(todos.count - 3) more" : ""
        return "\(todos.count) todo\(todos.count == 1 ? " was" : "s were") still open: "
            + names.joined(separator: ", ") + more
    }

    static func unverifiedDetail(_ checks: [GateRecipeCheck], ledger: RunLedger) -> String {
        let commands = checks.prefix(2).map { "`\($0.command)`" }.joined(separator: " and ")
        let files = ledger.filesChanged.count
        return "\(commands) had not run since your last edit (\(files) file\(files == 1 ? "" : "s") changed)"
    }

    static func failingDetail(_ record: VerificationRecord) -> String {
        let first = firstFailingLine(record.excerpt)
        return "`\(record.command)` failed after your last edit" + (first.map { " (first: \($0))" } ?? "")
    }

    static func uiDetail(_ target: GateUITarget) -> String {
        switch target.surface {
        case .web: "nobody had looked at \(target.target) in the Preview since your UI change"
        case .ios: "nobody had looked at \(target.target) in the Simulator since your UI change"
        case .mac: "nobody had looked at \(target.target) running since your UI change"
        }
    }

    static func diffDetail(_ ledger: RunLedger) -> String {
        let files = ledger.filesChanged.count
        return "your diff (\(files) file\(files == 1 ? "" : "s"), \(ledger.linesChanged) lines) had not been read since your last edit"
    }

    static func findingsDetail(_ findings: [ReviewFinding]) -> String {
        let items = findings.prefix(3).map { finding -> String in
            let place = finding.path.map { path in finding.line.map { "\(path):\($0)" } ?? path }
            return finding.title + (place.map { " (\($0))" } ?? "")
        }
        return "the review found \(findings.count) problem\(findings.count == 1 ? "" : "s"): " + items.joined(separator: "; ")
    }

    /// The check and its first failing line: the same failure, said twice in
    /// a row, is not worth a third try.
    static func signature(of record: VerificationRecord) -> String {
        (record.checkID ?? record.command) + "|" + (firstFailingLine(record.excerpt) ?? "")
    }

    /// The first line of an excerpt that reads like a failure, else its first
    /// non-empty line.
    static func firstFailingLine(_ excerpt: String) -> String? {
        let lines = excerpt
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0 != "…" }
        let markers = ["error", "fail", "✗", "expected", "assert"]
        let line = lines.first { line in
            let lowered = line.lowercased()
            return markers.contains { lowered.contains($0) }
        } ?? lines.first
        return line.map { $0.count > 160 ? String($0.prefix(160)) + "…" : $0 }
    }
}
