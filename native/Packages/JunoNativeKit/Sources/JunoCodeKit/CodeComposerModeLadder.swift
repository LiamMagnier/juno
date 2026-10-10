import Foundation

/// The Code composer's mode on the phone: the same five rungs as the web and
/// the Mac (`src/lib/code-v2/composer-mode.ts`, `CodeComposerMode`), Ask,
/// Accept edits, Auto, Plan and Full access, each with its one line, and what
/// each becomes on the two roads a phone has into a run.
public enum CodeComposerModeLadder: String, CaseIterable, Identifiable, Sendable {
    case ask
    case acceptEdits = "accept-edits"
    case auto
    case plan
    case full

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .ask: "Ask"
        case .acceptEdits: "Accept edits"
        case .auto: "Auto"
        case .plan: "Plan"
        case .full: "Full access"
        }
    }

    /// The web's words exactly.
    public var detail: String {
        switch self {
        case .ask: "Asks before every edit and command."
        case .acceptEdits: "Edits files without asking. Asks before commands."
        case .auto: "A reviewer model approves routine steps. Asks for the rest."
        case .plan: "Reads and writes a plan. Changes nothing until you approve."
        case .full: "Never asks inside the project. Still asks for sudo, other machines and anything outside the folder."
        }
    }

    // MARK: A cloud run

    /// What a cloud run's sandbox enforces (`CodeTask.permissionMode`).
    public static let cloud: [CodeComposerModeLadder] = [.acceptEdits, .plan, .full]

    /// The cloud task's `permissionMode`, or nil when a cloud run cannot honour it.
    public var cloudPermissionMode: String? {
        switch self {
        case .plan: "plan"
        case .acceptEdits: "auto-edit"
        case .full: "full"
        case .ask, .auto: nil
        }
    }

    // MARK: A session on a Mac

    /// What the Mac's session bridge takes (`PermissionMode(remoteName:)`):
    /// Auto has no rung of its own there, so it is not offered.
    public static let remote: [CodeComposerModeLadder] = [.ask, .acceptEdits, .plan, .full]

    public var remoteName: String {
        switch self {
        case .ask: "approvalRequired"
        case .acceptEdits, .auto: "autoEdit"
        case .plan: "plan"
        case .full: "full"
        }
    }

    /// The rung a Mac session reports (`PermissionMode.relayName` and the
    /// names the phone has always sent).
    public init(remoteName: String) {
        switch remoteName {
        case "readOnly", "read_only", "plan": self = .plan
        case "auto", "autoEdit", "workspaceWrite": self = .acceptEdits
        case "fullAccess", "full": self = .full
        default: self = .ask
        }
    }

    // MARK: Memory

    static func projectKey(_ project: String) -> String { "alevr.code.mode.project.\(project)" }

    /// The project's last choice on this phone, if one of `offered`.
    public static func remembered(project: String?, offered: [CodeComposerModeLadder], defaults: UserDefaults = .standard) -> CodeComposerModeLadder? {
        guard let project, let raw = defaults.string(forKey: projectKey(project)),
              let mode = CodeComposerModeLadder(rawValue: raw), offered.contains(mode)
        else { return nil }
        return mode
    }

    public func remember(project: String?, defaults: UserDefaults = .standard) {
        guard let project else { return }
        defaults.set(rawValue, forKey: Self.projectKey(project))
    }
}
