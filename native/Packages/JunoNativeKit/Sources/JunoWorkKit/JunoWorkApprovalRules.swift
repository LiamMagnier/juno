import JunoCore

/// Consent rules shared by every native Work approval surface.
///
/// A standing approval is broader than the request currently on screen, so it
/// is available only when both independent safety checks agree:
///
/// - the risk is one of the explicitly coverable low-risk levels; and
/// - the action is not one of the identities that must always ask, even if an
///   older or faulty executor reports that action with a lower risk.
///
/// Keeping this in `JunoWorkKit` gives the iPhone and Mac the same fail-closed
/// answer without either app maintaining its own copy of the policy.
public enum JunoWorkApprovalRules {
    public static func allowsStandingGrant(action: String, risk: String) -> Bool {
        guard let level = JunoWorkRiskLevel(rawValue: risk) else { return false }
        guard !level.alwaysRequiresApproval else { return false }
        guard JunoWorkAlwaysConfirmAction(rawValue: action) == nil else { return false }
        return true
    }
}
