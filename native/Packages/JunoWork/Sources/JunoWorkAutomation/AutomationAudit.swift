import Foundation

// MARK: - Vocabulary

/// The audit rows automation writes.
///
/// Raw values are a subset of `WORK_AUDIT_KINDS` in `src/lib/work/domain.ts`,
/// and the subset is the point: adding a value here that does not exist there
/// produces a row the web app cannot name, which is a row nobody reads. If
/// automation needs a kind that is not in this list, the list in `domain.ts` is
/// where it gets added first.
public enum AutomationAuditKind: String, Codable, CaseIterable, Sendable {
    /// An action automation took, or tried to.
    case commandClaimed = "command_claimed"
    case commandRefused = "command_refused"
    case approvalRequested = "approval_requested"
    case approvalDecided = "approval_decided"
    case policyNarrowed = "policy_narrowed"
    case screenshotCaptured = "screenshot_captured"
    /// A coarser tier refused because a finer one could serve the same intent.
    case tierDowngradeRefused = "tier_downgrade_refused"
    case injectionDetected = "injection_detected"
    case egressBlocked = "egress_blocked"
}

/// Matches `WORK_AUDIT_SEVERITIES`.
public enum AutomationAuditSeverity: String, Codable, CaseIterable, Sendable {
    case info
    case warning
    case refusal
    case violation
}

/// What happened to the action this row describes.
public enum AutomationVerdict: String, Codable, CaseIterable, Sendable {
    /// Written before the gate runs, so an action that crashed the process
    /// mid-flight still left a trace that it was attempted.
    case attempted
    case allowed
    case refused
}

// MARK: - The row

/// One line of the automation audit.
///
/// ## What is not here
///
/// There is no field for a page's text, for a window's contents, for the string
/// that was typed, or for an image. Not "we are careful not to put it there" —
/// **there is nowhere to put it.** An audit is the one record that is kept
/// longest, copied furthest and read by the most people, and an audit of screen
/// automation that recorded what was on the screen would be the largest
/// collection of somebody's private information the system produces.
///
/// What is here instead: which app or site, which tier, which intent, what the
/// verdict was, and — for text entry — how many characters. A length is enough
/// to tell a filled-in form from an emptied one and is not enough to reconstruct
/// either.
public struct AutomationAuditEntry: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let at: Date
    public let kind: AutomationAuditKind
    public let severity: AutomationAuditSeverity
    public let runID: String
    public let tier: AutomationTier
    public let intent: AutomationIntent
    public let subject: AutomationSubject
    public let verdict: AutomationVerdict
    public let refusalCode: AutomationRefusal.Code?
    public let restrictedCategory: AutomationRestrictedCategory?
    /// The length of text entered, never the text.
    public let characterCount: Int?
    /// The digest of the action an approval was bound to, when there was one.
    /// A digest identifies without describing, which is exactly what an audit
    /// needs to prove that the thing approved is the thing that ran.
    public let actionDigest: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        at: Date,
        kind: AutomationAuditKind,
        severity: AutomationAuditSeverity,
        runID: String,
        tier: AutomationTier,
        intent: AutomationIntent,
        subject: AutomationSubject,
        verdict: AutomationVerdict,
        refusalCode: AutomationRefusal.Code? = nil,
        restrictedCategory: AutomationRestrictedCategory? = nil,
        characterCount: Int? = nil,
        actionDigest: String? = nil
    ) {
        self.id = id
        self.at = at
        self.kind = kind
        self.severity = severity
        self.runID = runID
        self.tier = tier
        self.intent = intent
        self.subject = subject
        self.verdict = verdict
        self.refusalCode = refusalCode
        self.restrictedCategory = restrictedCategory
        self.characterCount = characterCount
        self.actionDigest = actionDigest
    }

    /// The line a person reads in the activity list. Built from the typed fields
    /// rather than stored, so there is no free-text field to smuggle content
    /// through.
    public var readableLine: String {
        let outcome: String
        switch verdict {
        case .attempted: outcome = "tried"
        case .allowed: outcome = "did"
        case .refused: outcome = "was refused"
        }
        var line = "\(tier.label): \(outcome) \(intent.rawValue) on \(subject.auditIdentifier)"
        if let refusalCode { line += " (\(refusalCode.rawValue))" }
        return line
    }
}

// MARK: - The sink

/// Where audit rows go.
///
/// A protocol rather than a concrete log so the same controls write to a real
/// store in the app, to an in-memory log in a test, and to nothing at all in a
/// preview — without any of those three being a code path that skips the write.
public protocol AutomationAuditing: Sendable {
    func record(_ entry: AutomationAuditEntry) async
}

/// An in-memory audit, capped.
///
/// The cap matters for the same reason Juno Code caps its computer-use journal:
/// a long-running host that drives a browser all day would otherwise grow this
/// without bound, and the failure mode of an audit that exhausts memory is that
/// the audit takes down the thing it was auditing.
public actor AutomationAuditLog: AutomationAuditing {
    public static let maximumEntries = 2_000

    private var entries: [AutomationAuditEntry] = []
    private var observers: [UUID: @Sendable (AutomationAuditEntry) -> Void] = [:]

    public init() {}

    public func record(_ entry: AutomationAuditEntry) {
        entries.append(entry)
        if entries.count > Self.maximumEntries {
            entries.removeFirst(entries.count - Self.maximumEntries)
        }
        for observer in observers.values { observer(entry) }
    }

    public var allEntries: [AutomationAuditEntry] { entries }

    public func entries(forRun runID: String) -> [AutomationAuditEntry] {
        entries.filter { $0.runID == runID }
    }

    public func entries(withVerdict verdict: AutomationVerdict) -> [AutomationAuditEntry] {
        entries.filter { $0.verdict == verdict }
    }

    @discardableResult
    public func addObserver(
        _ observer: @escaping @Sendable (AutomationAuditEntry) -> Void
    ) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }
}

/// An audit that keeps nothing.
///
/// For previews and for the scripted drivers. Deliberately not the default
/// anywhere: a control constructed without an audit should be a compile error,
/// not a silent one.
public struct DiscardingAutomationAudit: AutomationAuditing {
    public init() {}
    public func record(_ entry: AutomationAuditEntry) async {
        _ = entry
    }
}
