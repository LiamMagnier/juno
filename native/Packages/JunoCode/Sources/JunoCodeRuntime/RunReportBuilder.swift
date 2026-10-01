import Foundation
import JunoCodeCore

// The run report (CODE_AGENT_SPEC §1.10).
//
// The model writes the prose: the outcome, what changed, what it could not
// check, what is left. The runtime adds what only it can vouch for, built
// here from the ledger: the "Checked" rows, the words the divider and the
// notification use about checks, "Not checked since the last edit" when the
// evidence is stale, and the review's optional notes.
//
// The "Checked" rows are unforgeable. Only ledger records render there, and
// only tools mint records, so a check the model says it ran but the runtime
// never saw cannot appear.

public enum RunReportBuilder {
    public struct Input: Sendable {
        public var endReason: RunEndReason
        /// The model's last reply, which it means as its report.
        public var modelReport: String
        /// The evidence minted this run (`VerificationLedger.snapshotThisRun`).
        public var evidence: VerificationSnapshot
        public var filesChanged: Int
        public var durationSeconds: Double
        /// Whether the project has any known check: decides between "no test
        /// command for this project" and "not checked since the last edit".
        public var checksKnown: Bool
        /// A note from the review pass that recorded no review (an unreadable
        /// answer, a reviewer that could not run).
        public var reviewNote: String?

        public init(
            endReason: RunEndReason,
            modelReport: String,
            evidence: VerificationSnapshot,
            filesChanged: Int,
            durationSeconds: Double,
            checksKnown: Bool,
            reviewNote: String? = nil
        ) {
            self.endReason = endReason
            self.modelReport = modelReport
            self.evidence = evidence
            self.filesChanged = filesChanged
            self.durationSeconds = durationSeconds
            self.checksKnown = checksKnown
            self.reviewNote = reviewNote
        }
    }

    /// The `runOutcome` event the divider, the notification, the runs list,
    /// the phone and the web all render.
    public static func build(_ input: Input) -> RunOutcomeEvent {
        let evidence = input.evidence
        var notChecked: [String] = []
        let freshPass = evidence.freshVerifications.contains(where: \.passed)
        if input.filesChanged > 0, !freshPass {
            notChecked.append(notCheckedSinceLastEdit)
        }
        if let note = input.reviewNote, !note.isEmpty {
            notChecked.append(note)
        }
        return RunOutcomeEvent(
            endReason: input.endReason,
            summary: outcomeSentence(from: input.modelReport),
            verification: verificationWords(input),
            checks: checkRows(evidence) + uiRows(evidence) + reviewRows(evidence),
            notChecked: notChecked,
            left: ReviewPass.notes(from: evidence.review),
            filesChanged: input.filesChanged,
            durationSeconds: input.durationSeconds
        )
    }

    public static let notCheckedSinceLastEdit = "Not checked since the last edit"

    // MARK: - The outcome

    /// The first line of the model's report that says something, without its
    /// list number or Markdown, at most 240 characters.
    public static func outcomeSentence(from report: String) -> String {
        for raw in report.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            while line.hasPrefix("#") { line.removeFirst() }
            line = line.trimmingCharacters(in: .whitespaces)
            if let marker = line.range(of: #"^(\d+[.)]|[-*•])\s+"#, options: .regularExpression) {
                line.removeSubrange(marker)
            }
            line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
            line = line.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, line.rangeOfCharacter(from: .alphanumerics) != nil else { continue }
            // A heading such as "Outcome:" with the sentence on the next line.
            if line.hasSuffix(":"), line.count < 30 { continue }
            return line.count > 240 ? String(line.prefix(239)) + "…" : line
        }
        return "Run completed."
    }

    // MARK: - Words about checks

    /// What the divider says about checks, after "Worked for 4m 12s ·".
    public static func verificationWords(_ input: Input) -> String? {
        let evidence = input.evidence
        switch input.endReason {
        case .doneChecked:
            let passing = distinct(evidence.freshVerifications.filter(\.passed))
            guard let first = passing.first else { return nil }
            switch passing.count {
            case 1: return "Checked with `\(first.command)`"
            case 2: return "Checked with `\(first.command)` and `\(passing[1].command)`"
            default: return "Checked with `\(first.command)` and \(passing.count - 1) more"
            }
        case .doneUnchecked:
            guard input.filesChanged > 0 else { return nil }
            return input.checksKnown
                ? "Not checked since the last edit"
                : "Not checked: no test command for this project"
        case .checksFailing:
            guard let failing = evidence.freshVerifications.last(where: { !$0.passed })
                ?? evidence.verifications.last(where: { !$0.passed })
            else { return nil }
            var words = "`\(failing.command)` still fails"
            if let count = failedCount(failing) {
                words += " (\(count) test\(count == 1 ? "" : "s"))"
            }
            return words
        default:
            return nil
        }
    }

    // MARK: - Rows

    /// One row per check, the newest result of each, in the order first run.
    static func checkRows(_ evidence: VerificationSnapshot) -> [RunOutcomeCheck] {
        distinct(evidence.verifications).map { record in
            var parts = [record.passed ? "passed" : "failed"]
            let headline = CheckEvidence.headline(of: record)
            if record.kind == .test, headline != "passed", !headline.hasPrefix("failed with exit") {
                parts.append(headline.replacingOccurrences(of: " passed", with: ""))
            } else if !record.passed {
                parts.append("exit \(record.exitCode)")
            }
            parts.append(seconds(record.durationMs))
            parts.append(evidence.isFresh(record) ? "after the last edit" : "before the last edit")
            return RunOutcomeCheck(
                label: record.command,
                passed: record.passed,
                detail: parts.joined(separator: " · "),
                recordID: record.id
            )
        }
    }

    /// One row per place looked at, its viewports together.
    static func uiRows(_ evidence: VerificationSnapshot) -> [RunOutcomeCheck] {
        var order: [String] = []
        var groups: [String: [UIVerificationRecord]] = [:]
        for record in evidence.uiVerifications {
            let key = record.surface.rawValue + "\u{1f}" + record.target
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(record)
        }
        return order.compactMap { key in
            guard let records = groups[key], let latest = records.last else { return nil }
            let surface: String
            switch latest.surface {
            case .web: surface = "Preview"
            case .ios: surface = "Simulator"
            case .mac: surface = "App"
            }
            var viewports: [String] = []
            for viewport in records.compactMap(\.viewport) where !viewports.contains(viewport) {
                viewports.append(viewport)
            }
            var label = "\(surface) \(latest.target)"
            if !viewports.isEmpty { label += ", " + viewports.joined(separator: " and ") }
            let passed = records.allSatisfy(\.passed)
            var parts: [String]
            if passed {
                parts = latest.checks.filter(\.passed).map(\.name)
            } else {
                let failing = records.flatMap(\.checks).first { !$0.passed }
                if let failing {
                    parts = [failing.detail.map { "\(failing.name): \($0)" } ?? failing.name]
                } else {
                    parts = ["failed"]
                }
            }
            let screenshots = records.compactMap(\.screenshotHash).count
            if screenshots > 0 { parts.append("\(screenshots) screenshot\(screenshots == 1 ? "" : "s")") }
            if !records.contains(where: evidence.isFresh) { parts.append("before the last edit") }
            return RunOutcomeCheck(
                label: label,
                passed: passed,
                detail: parts.isEmpty ? (passed ? "looked right" : "failed") : parts.joined(separator: " · "),
                recordID: latest.id
            )
        }
    }

    static func reviewRows(_ evidence: VerificationSnapshot) -> [RunOutcomeCheck] {
        guard let review = evidence.review else { return [] }
        let blocking = review.blockingFindings.count
        let notes = review.findings.count - blocking
        let detail: String
        switch (blocking, notes) {
        case (0, 0): detail = "no correctness findings"
        case (0, _): detail = "no correctness findings · \(notes) note\(notes == 1 ? "" : "s")"
        default: detail = "\(blocking) finding\(blocking == 1 ? "" : "s") to fix"
        }
        return [RunOutcomeCheck(label: "Review", passed: blocking == 0, detail: detail, recordID: review.id)]
    }

    // MARK: - Helpers

    /// The newest record of each check (by recipe id, else command), in the
    /// order each check first ran.
    static func distinct(_ records: [VerificationRecord]) -> [VerificationRecord] {
        var order: [String] = []
        var latest: [String: VerificationRecord] = [:]
        for record in records {
            let key = record.checkID ?? record.command
            if latest[key] == nil { order.append(key) }
            latest[key] = record
        }
        return order.compactMap { latest[$0] }
    }

    static func failedCount(_ record: VerificationRecord) -> Int? {
        let headline = CheckEvidence.headline(of: record)
        guard headline.contains("failed"), let first = headline.split(separator: " ").first else { return nil }
        return Int(first)
    }

    static func seconds(_ milliseconds: Int) -> String {
        let total = Double(milliseconds) / 1_000
        if total < 1 { return "under 1 s" }
        if total < 60 { return "\(Int(total.rounded())) s" }
        let minutes = Int(total) / 60
        let rest = Int(total) % 60
        return rest == 0 ? "\(minutes) min" : "\(minutes) min \(rest) s"
    }
}

/// The `<verify>` section of the session state (§1.7): the project's checks,
/// what the UI check would look at, and whether the last check still counts.
/// Lane A adds it to the block; it is built here, from the recipe and the
/// ledger.
public enum VerifyStateSection {
    public static let name = "verify"

    public static func make(status: VerifyRecipeStatus, evidence: VerificationSnapshot) -> SessionStateSection {
        SessionStateSection(name: name, body: body(status: status, evidence: evidence))
    }

    public static func body(status: VerifyRecipeStatus, evidence: VerificationSnapshot) -> String {
        var lines: [String] = []
        switch status {
        case let .accepted(recipe):
            lines.append("Checks for this project (from .juno/verify.json):")
            lines += checkLines(recipe)
            lines += uiLines(recipe)
        case let .discovered(recipe) where !recipe.isEmpty:
            lines.append("Checks Juno found in this project (not saved yet; run_checks runs them, each command approved as usual):")
            lines += checkLines(recipe)
            lines += uiLines(recipe)
        case .discovered:
            lines.append("No checks are known for this project. Run its build or tests with run_command; Juno records a recognised build, test, lint or typecheck command.")
        case .awaitingAcceptance:
            lines.append(".juno/verify.json changed since the reader accepted it, so its checks are not offered until they accept the new version. Use run_command meanwhile.")
        case let .invalid(message):
            lines.append(message)
        }
        if let last = evidence.verifications.last {
            let name = last.checkID ?? "`\(last.command)`"
            let verdict = last.passed ? "passed" : "failed"
            lines.append(
                evidence.isFresh(last)
                    ? "Last check: \(name) \(verdict), and nothing has changed since."
                    : "Last check: \(name) \(verdict), but files changed since, so it no longer counts."
            )
        }
        return lines.joined(separator: "\n")
    }

    static func checkLines(_ recipe: VerifyRecipe) -> [String] {
        recipe.checks.map { check in
            var line = "- \(check.id) (\(check.kind.rawValue)): "
            line += check.targeted ?? check.commandLine
            if let cwd = check.normalizedCwd { line += " in \(cwd)" }
            if !check.paths.isEmpty { line += " — paths " + check.paths.joined(separator: ", ") }
            if check.targeted != nil { line += "; full: \(check.commandLine)" }
            return line
        }
    }

    static func uiLines(_ recipe: VerifyRecipe) -> [String] {
        recipe.ui.map { target in
            switch target.kind {
            case .web:
                var line = "UI: web preview"
                if let launch = target.launch { line += " \"\(launch)\"" }
                if let routes = target.routes, !routes.isEmpty {
                    line += ", routes " + routes.joined(separator: " and ")
                }
                return line
            case .mac:
                return "UI: Mac app" + (target.build.map { " built by \($0)" } ?? "")
            case .ios:
                return "UI: iOS app in the Simulator" + (target.build.map { " built by \($0)" } ?? "")
            }
        }
    }
}
