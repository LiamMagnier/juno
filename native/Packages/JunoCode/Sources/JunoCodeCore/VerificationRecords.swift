import Foundation

// Evidence the runtime mints from tool side effects, never from model text:
// checks it ran, UI it looked at, reviews of the diff. The gate (Lane A) reads
// it through `VerificationLedgerReading`; the recorders (Lane B's commands and
// run_checks, Lane C's screen and Simulator, Lane D's Preview) write it through
// `VerificationLedgerWriting`. Lane B owns this file after the seams commit.
// See docs/rework/CODE_AGENT_SPEC.md §1.2, §1.8–§1.10 and §4.6.

/// What a check is for. The raw values are the protocol's `CheckKind`.
public enum CheckKind: String, Codable, CaseIterable, Sendable {
    case build
    case test
    case lint
    case typecheck
    case custom
}

/// One check the runtime ran or recognised, pass or fail.
public struct VerificationRecord: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    /// The recipe check this matched, when it matched one.
    public var checkID: String?
    public var command: String
    public var kind: CheckKind
    public var exitCode: Int32
    public var passed: Bool
    /// The workspace revision the check ran at. A check counts only while the
    /// workspace is still at this revision.
    public var workspaceRevision: Int
    public var durationMs: Int
    /// The failing tail or a pass summary, at most `maximumExcerptBytes`,
    /// already redacted.
    public var excerpt: String
    public var at: Date

    public static let maximumExcerptBytes = 4 * 1_024

    public init(
        id: String = UUID().uuidString.lowercased(),
        checkID: String? = nil,
        command: String,
        kind: CheckKind,
        exitCode: Int32,
        passed: Bool,
        workspaceRevision: Int,
        durationMs: Int,
        excerpt: String = "",
        at: Date = Date()
    ) {
        self.id = id
        self.checkID = checkID
        self.command = command
        self.kind = kind
        self.exitCode = exitCode
        self.passed = passed
        self.workspaceRevision = workspaceRevision
        self.durationMs = durationMs
        self.excerpt = Self.bounded(excerpt)
        self.at = at
    }

    /// `text` cut to the excerpt limit, keeping its end: a failing check says
    /// what went wrong last.
    static func bounded(_ text: String) -> String {
        guard text.utf8.count > maximumExcerptBytes else { return text }
        // "…" is three bytes; whole characters only, walked from the end.
        let budget = maximumExcerptBytes - 3
        var bytes = 0
        var start = text.endIndex
        for index in text.indices.reversed() {
            let size = text[index].utf8.count
            guard bytes + size <= budget else { break }
            bytes += size
            start = index
        }
        return "…" + text[start...]
    }
}

/// Where a UI check looked. The raw values are the protocol's `VerifySurface`.
public enum UIVerificationSurface: String, Codable, CaseIterable, Sendable {
    /// A web page in the Preview.
    case web
    /// An app in the iOS Simulator.
    case ios
    /// A Mac app, through app-scoped screen control.
    case mac
}

/// One condition a UI check tested, in words.
public struct UICheckResult: Hashable, Codable, Sendable {
    /// "HTTP 200", "no new console errors", "menu opened".
    public var name: String
    public var passed: Bool
    /// Why it failed, or a detail worth keeping ("TypeError: menu is undefined").
    public var detail: String?

    public init(name: String, passed: Bool, detail: String? = nil) {
        self.name = name
        self.passed = passed
        self.detail = detail
    }
}

/// Evidence that the running result was looked at: a Preview route, a
/// Simulator screen or a Mac app window. Minted by the runtime when the
/// conditions held (or failed), never claimed by the model.
public struct UIVerificationRecord: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var surface: UIVerificationSurface
    /// The route (`/settings`), the bundle id or the app name.
    public var target: String
    /// "desktop", "phone", "iPhone 17 Pro", or nil when there is only one.
    public var viewport: String?
    public var checks: [UICheckResult]
    public var passed: Bool
    /// SHA-256 of the screenshot kept as evidence, when one was kept.
    public var screenshotHash: String?
    public var workspaceRevision: Int
    public var at: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        surface: UIVerificationSurface,
        target: String,
        viewport: String? = nil,
        checks: [UICheckResult],
        passed: Bool,
        screenshotHash: String? = nil,
        workspaceRevision: Int,
        at: Date = Date()
    ) {
        self.id = id
        self.surface = surface
        self.target = target
        self.viewport = viewport
        self.checks = checks
        self.passed = passed
        self.screenshotHash = screenshotHash
        self.workspaceRevision = workspaceRevision
        self.at = at
    }
}

/// How serious a review finding is. The raw values are the protocol's
/// `ReviewPriority`.
public enum ReviewPriority: String, Codable, CaseIterable, Comparable, Sendable {
    case p0
    case p1
    case p2
    case p3

    /// P0 and P1: real problems that send the run back to work.
    public var isBlocking: Bool { self == .p0 || self == .p1 }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        let order: [Self] = [.p0, .p1, .p2, .p3]
        return order.firstIndex(of: lhs)! < order.firstIndex(of: rhs)!
    }
}

/// One thing the reviewer found in the diff.
public struct ReviewFinding: Hashable, Codable, Sendable {
    public var priority: ReviewPriority
    /// 0…1, as the reviewer reported it.
    public var confidence: Double
    public var path: String?
    public var line: Int?
    public var title: String
    public var body: String
    /// The goal criterion it concerns (`c2`), for a requirement gap.
    public var criterion: String?

    public init(
        priority: ReviewPriority,
        confidence: Double,
        path: String? = nil,
        line: Int? = nil,
        title: String,
        body: String = "",
        criterion: String? = nil
    ) {
        self.priority = priority
        self.confidence = min(max(confidence, 0), 1)
        self.path = path
        self.line = line
        self.title = title
        self.body = body
        self.criterion = criterion
    }
}

/// The reviewer's overall judgement. The raw values are the protocol's
/// `ReviewOverall`.
public enum ReviewOverall: String, Codable, CaseIterable, Sendable {
    case correct
    case incorrect
}

/// One self-review of the diff: the reviewer sub-agent's findings, or a diff
/// read with nothing to report.
public struct ReviewRecord: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    /// 1 for the first review of a run; at most 2 per run.
    public var round: Int
    public var findings: [ReviewFinding]
    public var overall: ReviewOverall
    public var summary: String
    public var workspaceRevision: Int
    public var at: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        round: Int,
        findings: [ReviewFinding],
        overall: ReviewOverall,
        summary: String = "",
        workspaceRevision: Int,
        at: Date = Date()
    ) {
        self.id = id
        self.round = round
        self.findings = findings
        self.overall = overall
        self.summary = summary
        self.workspaceRevision = workspaceRevision
        self.at = at
    }

    /// The confidence a P0 or P1 finding needs to send the run back to work.
    public static let blockingConfidence = 0.6

    /// Findings that send the run back: P0 and P1, and requirement gaps, at
    /// `blockingConfidence` or above. The rest go in the report as notes.
    public var blockingFindings: [ReviewFinding] {
        findings.filter {
            ($0.priority.isBlocking || $0.criterion != nil) && $0.confidence >= Self.blockingConfidence
        }
    }
}

// MARK: - The ledger seam

/// What the stop check reads: the evidence recorded this run and where the
/// workspace stands.
///
/// A record is **fresh** when it was made at the current workspace revision.
/// A pass from before the last edit does not count.
public protocol VerificationLedgerReading: Sendable {
    /// Bumped on every file change, including changes a command made.
    var workspaceRevision: Int { get }
    var verifications: [VerificationRecord] { get }
    var uiVerifications: [UIVerificationRecord] { get }
    /// The latest self-review, if any.
    var review: ReviewRecord? { get }
    /// The revision at the last `git_diff` or review pass.
    var lastDiffReadRevision: Int? { get }
}

public extension VerificationLedgerReading {
    func isFresh(_ record: VerificationRecord) -> Bool {
        record.workspaceRevision == workspaceRevision
    }

    func isFresh(_ record: UIVerificationRecord) -> Bool {
        record.workspaceRevision == workspaceRevision
    }

    /// Checks made at the current revision, oldest first.
    var freshVerifications: [VerificationRecord] {
        verifications.filter(isFresh)
    }

    /// The newest check at the current revision.
    var latestFreshVerification: VerificationRecord? {
        freshVerifications.last
    }

    /// The newest fresh result for `checkID`, or for `command` when the check
    /// has no recipe id.
    func latestFreshVerification(checkID: String? = nil, command: String? = nil) -> VerificationRecord? {
        freshVerifications.last {
            if let checkID { return $0.checkID == checkID }
            if let command { return $0.command == command }
            return true
        }
    }

    /// UI checks at the current revision on `surface`, optionally for one
    /// target.
    func freshUIVerifications(surface: UIVerificationSurface? = nil, target: String? = nil) -> [UIVerificationRecord] {
        uiVerifications.filter {
            isFresh($0)
                && (surface == nil || $0.surface == surface)
                && (target == nil || $0.target == target)
        }
    }

    /// Whether the diff was read or reviewed since the last edit.
    var diffReadIsFresh: Bool {
        guard let lastDiffReadRevision else { return false }
        return lastDiffReadRevision >= workspaceRevision
    }
}

/// How recorders add evidence. Every method is idempotent on the record's id.
public protocol VerificationLedgerWriting: Sendable {
    func recordVerification(_ record: VerificationRecord) async
    func recordUIVerification(_ record: UIVerificationRecord) async
    func recordReview(_ record: ReviewRecord) async
    /// The model read the diff (`git_diff`) at `revision`.
    func recordDiffRead(atRevision revision: Int) async
}

/// A plain value snapshot of the ledger: what tests, projections and the gate
/// read when they hold evidence rather than a live ledger.
public struct VerificationSnapshot: VerificationLedgerReading, Hashable, Codable {
    public var workspaceRevision: Int
    public var verifications: [VerificationRecord]
    public var uiVerifications: [UIVerificationRecord]
    public var review: ReviewRecord?
    public var lastDiffReadRevision: Int?

    public init(
        workspaceRevision: Int = 0,
        verifications: [VerificationRecord] = [],
        uiVerifications: [UIVerificationRecord] = [],
        review: ReviewRecord? = nil,
        lastDiffReadRevision: Int? = nil
    ) {
        self.workspaceRevision = workspaceRevision
        self.verifications = verifications
        self.uiVerifications = uiVerifications
        self.review = review
        self.lastDiffReadRevision = lastDiffReadRevision
    }
}
