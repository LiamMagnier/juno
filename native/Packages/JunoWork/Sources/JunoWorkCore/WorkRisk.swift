import Foundation

/// How far the effect of an action reaches.
///
/// Raw values match `WORK_RISK_LEVELS` in `src/lib/work/domain.ts`; the same
/// strings are written to the approval row and rendered on the phone.
public enum WorkRiskLevel: String, Codable, CaseIterable, Sendable, Comparable {
    /// Looking, searching, summarising. Nothing changes.
    case safe
    /// Creating or changing something inside a granted folder, reversibly.
    case edit
    /// Running something whose effects are bounded to the grant.
    case command
    /// Reaches beyond the folder, or removes something from where the person
    /// left it. Reversible, but not invisibly so.
    case sensitive
    /// Cannot be undone by Juno: permanent delete, emptying the Trash, sending,
    /// publishing, buying, changing an account or a security setting. **Always
    /// asks, under every policy.**
    case irreversible

    private var rank: Int {
        switch self {
        case .safe: 0
        case .edit: 1
        case .command: 2
        case .sensitive: 3
        case .irreversible: 4
        }
    }

    public static func < (lhs: WorkRiskLevel, rhs: WorkRiskLevel) -> Bool {
        lhs.rank < rhs.rank
    }
}

/// The person's standing answer to "how much should Juno do without asking".
///
/// Raw values match `WORK_PERMISSION_POLICIES` in `src/lib/work/domain.ts`.
/// Every layer — host, project, session, schedule, skill — may only narrow, so
/// ``narrowest(_:)`` is the whole of the combination rule.
public enum WorkPermissionPolicy: String, Codable, CaseIterable, Sendable, Comparable {
    case conservative
    case balanced
    case permissive

    private var rank: Int {
        switch self {
        case .conservative: 0
        case .balanced: 1
        case .permissive: 2
        }
    }

    public static func < (lhs: WorkPermissionPolicy, rhs: WorkPermissionPolicy) -> Bool {
        lhs.rank < rhs.rank
    }

    /// The strictest of several policies. Written as a fold over `min` rather
    /// than a chain of conditions, because an intersection spelled out as `if`s
    /// eventually grows a branch that widens.
    public static func narrowest(_ policies: [WorkPermissionPolicy?]) -> WorkPermissionPolicy {
        policies.compactMap { $0 }.min() ?? .permissive
    }
}

/// Actions Juno cannot undo, named by the identifiers the whole system uses.
///
/// Raw values match `ALWAYS_CONFIRM_ACTIONS` in `src/lib/work/domain.ts`.
///
/// Enumerated rather than pattern-matched. A rule that looks for "delete" in a
/// tool name decides that `delete_draft` is a permanent delete and that
/// `send_to_trash` is a send, and both mistakes are discovered by a person after
/// the fact.
///
/// **Permanent delete lives here and not in ``WorkFileOperation``.** That is the
/// structural half of the guarantee: a batch cannot contain one, a grant mode is
/// never asked about one, and the only route to it is an approval bound to that
/// exact item.
public enum WorkIrreversibleAction: String, Codable, CaseIterable, Sendable {
    case permanentDelete = "work.file.permanent_delete"
    case emptyTrash = "work.file.empty_trash"
    case appPurchase = "work.app.purchase"
    case browserPurchase = "work.browser.purchase"
    case connectorSendMessage = "work.connector.send_message"
    case connectorPublish = "work.connector.publish"
    case connectorDelete = "work.connector.delete"
    case connectorPayment = "work.connector.payment"
    case changeSecuritySetting = "work.system.change_security_setting"
    case changeAccountSetting = "work.system.change_account_setting"
}

/// A standing "always allow this" answer.
///
/// The initializer **fails** for `sensitive` and `irreversible`. That is the
/// point of the type: "always allow" is a real convenience for reorganising a
/// folder and a catastrophe for anything that cannot be taken back, and a
/// runtime check somewhere in a policy function is one refactor away from being
/// skipped. Here there is no value to check, because there is no value.
public struct WorkAlwaysAllowance: Hashable, Codable, Sendable {
    public let highestRiskCovered: WorkRiskLevel

    public init?(upTo risk: WorkRiskLevel) {
        guard WorkRisk.mayBeCoveredByStandingAllowance(risk) else { return nil }
        self.highestRiskCovered = risk
    }

    public func covers(_ risk: WorkRiskLevel) -> Bool { risk <= highestRiskCovered }

    /// Decoding re-applies the rule.
    ///
    /// An allowance arrives from the relay as stored state, and a row edited or
    /// replayed to say `irreversible` must not decode into a value that grants
    /// it. Failing closed here keeps the guarantee true for state that was
    /// written before the rule existed.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let risk = try container.decode(WorkRiskLevel.self, forKey: .highestRiskCovered)
        guard let allowance = WorkAlwaysAllowance(upTo: risk) else {
            throw DecodingError.dataCorruptedError(
                forKey: .highestRiskCovered,
                in: container,
                debugDescription: "No standing allowance can cover \(risk.rawValue)"
            )
        }
        self = allowance
    }
}

public enum WorkApprovalRuling: Hashable, Sendable {
    /// Proceed without asking.
    case allow
    /// Ask the person, bound to this exact action.
    case requireApproval
    /// Refuse outright. The reason is shown, not logged.
    case deny(reason: String)
}

/// Pure classification and policy: what an action risks, and whether it may
/// proceed.
public enum WorkRisk {
    /// The risk of one file operation.
    ///
    /// **Trash is not delete.** Moving an item to the Trash is `sensitive`: it
    /// leaves where the person put it, which they should be told about, and it
    /// is entirely recoverable, which means treating it as `irreversible` would
    /// spend the strongest word Work has on something that can be fixed by
    /// dragging a file out of a folder. Keep `irreversible` for the things that
    /// truly are, or people learn to click through it.
    public static func level(of kind: WorkFileOperation.Kind) -> WorkRiskLevel {
        switch kind {
        case .createFolder, .copy, .move, .rename, .write, .tag, .archive, .unarchive:
            .edit
        case .trash:
            .sensitive
        }
    }

    public static func level(of operation: WorkFileOperation) -> WorkRiskLevel {
        level(of: operation.kind)
    }

    /// Every irreversible action is `irreversible`. Stated as a total function
    /// with no switch, so no future case can be quietly classified lower.
    public static func level(of action: WorkIrreversibleAction) -> WorkRiskLevel {
        _ = action
        return .irreversible
    }

    /// The highest risk in a batch, which is the risk the batch carries: a
    /// hundred safe operations and one Trash is a batch that removes something.
    public static func level(of plan: WorkBatchPlan) -> WorkRiskLevel {
        plan.operations.map { level(of: $0.kind) }.max() ?? .safe
    }

    /// Whether a standing "always allow" may ever cover this risk.
    ///
    /// The ceiling is `command`. Above it the person is being told something
    /// they would want to know each time, and an answer given once last Tuesday
    /// is not that.
    public static func mayBeCoveredByStandingAllowance(_ risk: WorkRiskLevel) -> Bool {
        risk <= .command
    }

    /// The ruling for a risk under a policy, with an optional standing
    /// allowance.
    ///
    /// The `irreversible` rule sits above the policy ladder, exactly as
    /// `ActionRisk.destructive` does in Juno Code's `PermissionPolicy`: there is
    /// no setting anywhere in the app that turns it off, because "Juno cannot
    /// take this back" is the one promise the whole permission system exists to
    /// keep.
    public static func ruling(
        policy: WorkPermissionPolicy,
        risk: WorkRiskLevel,
        allowance: WorkAlwaysAllowance? = nil
    ) -> WorkApprovalRuling {
        guard risk != .irreversible else { return .requireApproval }
        guard risk != .sensitive else { return .requireApproval }
        if let allowance, allowance.covers(risk) { return .allow }
        switch (policy, risk) {
        case (.conservative, .safe):
            return .allow
        case (.conservative, _):
            return .requireApproval
        case (.balanced, .safe), (.balanced, .edit):
            return .allow
        case (.balanced, _):
            return .requireApproval
        case (.permissive, _):
            return .allow
        }
    }

    /// The ruling for one file operation, taking the grant's mode into account.
    ///
    /// The mode is consulted first so that a refusal beats a prompt. Offering
    /// somebody an "Allow" button for a Trash move on a folder they shared
    /// without delete permission would let one tap undo the choice they made
    /// when they shared it — the same reason Juno Code puts its read-only cases
    /// above the always-ask rule.
    public static func ruling(
        policy: WorkPermissionPolicy,
        mode: WorkAccessMode,
        operation: WorkFileOperation,
        allowance: WorkAlwaysAllowance? = nil
    ) -> WorkApprovalRuling {
        guard mode.permits(operation.kind) else {
            return .deny(
                reason: operation.kind == .trash
                    ? "This folder was shared with Juno without permission to remove anything."
                    : "This folder was shared with Juno for reading only."
            )
        }
        return ruling(policy: policy, risk: level(of: operation.kind), allowance: allowance)
    }

    /// The ruling for an irreversible action.
    ///
    /// Never `.allow`, for any policy, any mode, any allowance. A read-only
    /// grant denies outright; everything else asks. There is no third branch,
    /// and the parameters are taken only so that no caller can believe it
    /// forgot to consider them.
    public static func ruling(
        policy: WorkPermissionPolicy,
        mode: WorkAccessMode,
        irreversible action: WorkIrreversibleAction,
        allowance: WorkAlwaysAllowance? = nil
    ) -> WorkApprovalRuling {
        _ = (policy, allowance, action)
        guard mode.allowsWrite else {
            return .deny(reason: "This folder was shared with Juno for reading only.")
        }
        return .requireApproval
    }

    /// What an unattended run may do when nobody is there to answer.
    ///
    /// Mirrors `WORK_UNATTENDED_POLICIES`. There is no "approve automatically":
    /// a scheduled task must not acquire permissions merely because no person is
    /// present, so all three options are ways of not acting.
    public enum UnattendedPolicy: String, Codable, CaseIterable, Sendable {
        case pauseForApproval = "pause_for_approval"
        case skipIrreversible = "skip_irreversible"
        case disallowIrreversible = "disallow_irreversible"
    }

    /// The ruling an unattended run gets for something that would otherwise ask.
    ///
    /// Turns a prompt into one of the three ways of not acting, and leaves a
    /// denial a denial.
    public static func unattendedRuling(
        _ ruling: WorkApprovalRuling,
        policy: UnattendedPolicy
    ) -> WorkApprovalRuling {
        switch ruling {
        case .allow, .deny:
            return ruling
        case .requireApproval:
            switch policy {
            case .pauseForApproval:
                return .requireApproval
            case .skipIrreversible:
                return .deny(reason: "Skipped: this needed your say-so and nobody was there to give it.")
            case .disallowIrreversible:
                return .deny(reason: "This scheduled task is not allowed to do anything that needs approval.")
            }
        }
    }
}
