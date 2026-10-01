import Foundation
import JunoCodeCore

// Self-review before the run reports (CODE_AGENT_SPEC §1.9).
//
// Two tiers, both deterministic in *when* they run:
//
// 1. Diff read. Files changed and the diff was not read since the last edit:
//    the stop check sends one continuation asking the model to read its diff
//    with git_diff (`ReviewPass.diffReadContinuation`). Small changes stop
//    there.
// 2. Reviewer sub-agent. Over the threshold (more than 40 changed lines, or
//    three or more files), or always when the reader asked for it, or when a
//    goal claims completion: the runtime runs the built-in `reviewer` agent
//    through `delegate_task`, read-only, in a fresh context, on the parent's
//    model. It answers in JSON, validated here. P0 and P1 findings and unmet
//    criteria at confidence 0.6 or more send the run back
//    (`reviewFindingsContinuation`); P2 and P3 become notes in the report. At
//    most two review rounds per run.
//
// The reviewer reads; it never approves anything, and its findings are
// recorded as evidence of a review, not as permission to finish.

/// What runs the reviewer: `delegate_task`, or a stand-in in tests.
public protocol SubagentDelegating: Sendable {
    func delegate(_ input: JSONValue, context: ToolContext) async throws -> ToolResult
}

extension DelegateTaskTool: SubagentDelegating {
    public func delegate(_ input: JSONValue, context: ToolContext) async throws -> ToolResult {
        try await execute(input: input, context: context)
    }
}

public struct ReviewPass: Sendable {
    /// When the reviewer runs. The raw values are `autonomy.reviewBeforeFinish`
    /// in settings (Lane A's `AutonomySettings` maps onto these).
    public enum Trigger: String, Codable, CaseIterable, Sendable {
        /// Never.
        case off
        /// Only the diff read.
        case diff
        /// The reviewer over the threshold, the diff read below it.
        case auto
        /// The reviewer every time files changed.
        case always
    }

    public static let defaultThresholdLines = 40
    public static let thresholdFiles = 3
    public static let maximumRounds = 2

    /// Whether the reviewer sub-agent should run, rather than only the diff
    /// read: over `thresholdLines` changed lines or on three or more files
    /// for `auto`, every time for `always`, and whenever a goal claims
    /// completion unless reviews are off.
    public static func needsReviewer(
        trigger: Trigger,
        changedLines: Int,
        changedFiles: Int,
        thresholdLines: Int = defaultThresholdLines,
        goalClaimsCompletion: Bool = false
    ) -> Bool {
        guard changedFiles > 0 else { return false }
        switch trigger {
        case .off:
            return false
        case .diff:
            return goalClaimsCompletion
        case .always:
            return true
        case .auto:
            return goalClaimsCompletion || changedLines > thresholdLines || changedFiles >= thresholdFiles
        }
    }

    /// What the reviewer is given.
    public struct Request: Sendable {
        /// The diff against the run's base (`git diff` of the run's changes).
        public var diff: String
        /// The reader's request, in their words.
        public var request: String
        /// A goal's criteria, by id, when a goal is active.
        public var criteria: [(id: String, text: String)]
        /// The todo list, as lines.
        public var todos: [String]
        /// The checks recorded this run.
        public var checks: [VerificationRecord]

        public init(
            diff: String,
            request: String,
            criteria: [(id: String, text: String)] = [],
            todos: [String] = [],
            checks: [VerificationRecord] = []
        ) {
            self.diff = diff
            self.request = request
            self.criteria = criteria
            self.todos = todos
            self.checks = checks
        }
    }

    public enum Outcome: Sendable {
        /// P0/P1 findings or unmet criteria: the run goes back to work.
        case findings(ReviewRecord)
        /// No blocking findings; P2/P3 notes, if any, go in the report.
        case clean(ReviewRecord)
        /// The reviewer's answer could not be read. Nothing was recorded as a
        /// review; the note says so in the report.
        case unreadable(note: String)
        /// Two rounds already ran this run.
        case roundLimit
        /// The reviewer could not run.
        case failed(String)

        public var record: ReviewRecord? {
            switch self {
            case let .findings(record), let .clean(record): record
            default: nil
            }
        }
    }

    private let delegate: any SubagentDelegating
    private let ledger: VerificationLedger

    public init(delegate: any SubagentDelegating, ledger: VerificationLedger) {
        self.delegate = delegate
        self.ledger = ledger
    }

    /// The diff is this long at most, so the reviewer's context holds the
    /// change and room to read around it.
    public static let maximumDiffBytes = 96 * 1_024

    /// Runs one review round and records it.
    public func run(_ request: Request, sessionID: CodeSessionID) async -> Outcome {
        // Attempts count, not only recorded reviews: a reviewer that fails or
        // answers nothing readable records no review, and a stop check that
        // asked for one again would otherwise start it without end.
        guard let round = ledger.beginReviewAttempt(maximum: Self.maximumRounds) else {
            return .roundLimit
        }
        let revision = ledger.workspaceRevision
        let input: JSONValue = [
            "tasks": [
                [
                    "agent": "reviewer",
                    "title": .string(round == 1 ? "Review the diff" : "Review the diff again"),
                    "prompt": .string(Self.prompt(for: request)),
                ],
            ],
        ]
        let context = ToolContext(
            sessionID: sessionID,
            toolCallID: "review-\(revision)-\(round)",
            emitOutput: { _, _ in }
        )
        let result: ToolResult
        do {
            result = try await delegate.delegate(input, context: context)
        } catch {
            return .failed("The reviewer could not run: \(error)")
        }
        guard !result.isError else {
            return .failed("The reviewer did not finish: " + (result.content.split(separator: "\n").first.map(String.init) ?? ""))
        }
        guard let parsed = Self.parse(result.content) else {
            // Read, but not understood: the diff counts as read, and nothing
            // is recorded as a review.
            await ledger.recordDiffRead(atRevision: revision)
            return .unreadable(note: "The reviewer's answer could not be read, so no review findings were recorded.")
        }
        let record = ReviewRecord(
            round: round,
            findings: parsed.findings,
            overall: parsed.overall,
            summary: parsed.summary,
            workspaceRevision: revision
        )
        await ledger.recordReview(record)
        return record.blockingFindings.isEmpty ? .clean(record) : .findings(record)
    }

    // MARK: - The prompt

    static func prompt(for request: Request) -> String {
        var parts: [String] = []
        parts.append("Review this change. The reader asked for:\n\(request.request.trimmingCharacters(in: .whitespacesAndNewlines))")
        if !request.criteria.isEmpty {
            parts.append("The goal's criteria:\n" + request.criteria.map { "- \($0.id): \($0.text)" }.joined(separator: "\n"))
        }
        if !request.todos.isEmpty {
            parts.append("The todo list:\n" + request.todos.map { "- \($0)" }.joined(separator: "\n"))
        }
        if !request.checks.isEmpty {
            parts.append("Checks Juno recorded this run:\n" + request.checks.map {
                "- \($0.command): \($0.passed ? "passed" : "failed") at revision \($0.workspaceRevision)"
            }.joined(separator: "\n"))
        }
        var diff = request.diff
        if diff.utf8.count > maximumDiffBytes {
            var bytes = 0
            var end = diff.startIndex
            for index in diff.indices {
                let size = diff[index].utf8.count
                guard bytes + size <= maximumDiffBytes else { break }
                bytes += size
                end = diff.index(after: index)
            }
            diff = String(diff[..<end]) + "\n… the diff continues; read the files with read_file for the rest."
        }
        parts.append("The diff:\n```diff\n\(diff)\n```")
        parts.append("Answer with the JSON object only.")
        return parts.joined(separator: "\n\n")
    }

    // MARK: - Reading the answer

    /// The shape the reviewer must answer in.
    static let outputSchema: JSONValue = [
        "type": "object",
        "required": ["findings", "overall"],
        "properties": [
            "findings": ["type": "array", "items": findingSchema],
            "overall": ["type": "string", "enum": ["correct", "incorrect"]],
            "summary": ["type": "string"],
        ],
    ]

    /// One finding's shape.
    static let findingSchema: JSONValue = [
        "type": "object",
        "required": ["priority", "title"],
        "properties": [
            "priority": ["type": "string", "enum": ["P0", "P1", "P2", "P3", "p0", "p1", "p2", "p3"]],
            "confidence": ["type": "number"],
            "path": ["type": "string"],
            "line": ["type": "integer"],
            "title": ["type": "string"],
            "body": ["type": "string"],
            "criterion": ["type": "string"],
        ],
    ]

    /// `value` with only the keys `schema` names: a model that adds a field
    /// of its own has still answered the question.
    private static func known(_ value: JSONValue, in schema: JSONValue) -> JSONValue? {
        guard let object = value.objectValue, let properties = schema["properties"]?.objectValue else { return nil }
        return .object(object.filter { properties[$0.key] != nil })
    }

    public struct Parsed: Equatable, Sendable {
        public var findings: [ReviewFinding]
        public var overall: ReviewOverall
        public var summary: String
    }

    /// The reviewer's JSON, validated against `outputSchema`, from wherever it
    /// sits in the answer (bare, or in a ```json fence after a line of
    /// prose). Nil when there is none or it does not validate.
    public static func parse(_ answer: String) -> Parsed? {
        for candidate in jsonCandidates(in: answer) {
            guard let data = candidate.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
                  let value = known(decoded, in: outputSchema),
                  SchemaValidator.validate(input: value, against: outputSchema) == nil,
                  let overall = value["overall"]?.stringValue.flatMap(ReviewOverall.init(rawValue:))
            else { continue }
            let findings = (value["findings"]?.arrayValue ?? []).compactMap { raw -> ReviewFinding? in
                guard let item = known(raw, in: findingSchema),
                      SchemaValidator.validate(input: item, against: findingSchema) == nil,
                      let priority = item["priority"]?.stringValue.flatMap({ ReviewPriority(rawValue: $0.lowercased()) }),
                      let title = item["title"]?.stringValue, !title.isEmpty
                else { return nil }
                return ReviewFinding(
                    priority: priority,
                    confidence: item["confidence"]?.numberValue ?? 0.5,
                    path: item["path"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
                    line: item["line"]?.numberValue.map { Int($0) },
                    title: title,
                    body: item["body"]?.stringValue ?? "",
                    criterion: item["criterion"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
                )
            }
            return Parsed(findings: findings, overall: overall, summary: value["summary"]?.stringValue ?? "")
        }
        return nil
    }

    /// Fenced blocks first, then the widest `{…}` span.
    static func jsonCandidates(in text: String) -> [String] {
        var candidates: [String] = []
        var rest = Substring(text)
        while let open = rest.range(of: "```") {
            let afterOpen = rest[open.upperBound...]
            let bodyStart = afterOpen.firstIndex(of: "\n").map { afterOpen.index(after: $0) } ?? afterOpen.startIndex
            guard let close = afterOpen[bodyStart...].range(of: "```") else { break }
            candidates.append(String(afterOpen[bodyStart..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines))
            rest = afterOpen[close.upperBound...]
        }
        if let first = text.firstIndex(of: "{"), let last = text.lastIndex(of: "}"), first < last {
            candidates.append(String(text[first...last]))
        }
        return candidates
    }

    // MARK: - What the model is told

    /// The diff-read continuation: tier one.
    public static let diffReadContinuation =
        "Before finishing: you changed files and have not read your diff since the last edit. Read it with git_diff as a reviewer would, checking correctness, the request's requirements and leftovers such as debug output or commented-out code, and fix what you would flag."

    /// The continuation for blocking findings, naming each (under 600
    /// characters, as every runtime note is).
    public static func reviewFindingsContinuation(for record: ReviewRecord) -> String {
        let blocking = record.blockingFindings
        var text = "Before finishing: a review of your diff found "
            + (blocking.count == 1 ? "a problem" : "\(blocking.count) problems") + " to fix:"
        for finding in blocking {
            var line = "\n- \(finding.priority.rawValue.uppercased())"
            if let path = finding.path { line += " \(path)" + (finding.line.map { ":\($0)" } ?? "") }
            line += ": \(finding.title)"
            guard text.count + line.count < 480 else {
                text += "\n- and more."
                break
            }
            text += line
        }
        text += "\nFix them, or say why one is not a real problem."
        return String(text.prefix(600))
    }

    /// P2 and P3 findings, as the report's "Left" lines.
    public static func notes(from record: ReviewRecord?) -> [String] {
        guard let record else { return [] }
        let blocking = Set(record.blockingFindings.map(\.title))
        return record.findings
            .filter { !blocking.contains($0.title) }
            .map { finding in
                var place = ""
                if let path = finding.path { place = " (\(path)" + (finding.line.map { ":\($0)" } ?? "") + ")" }
                return "\(finding.title)\(place) (review, \(finding.priority.rawValue.uppercased()))"
            }
    }
}
