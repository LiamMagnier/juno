import Foundation
import JunoCodeCore
import JunoDesignSystem

/// The one choice a reader makes about how much Juno may do on its own.
///
/// The runtime keeps two settings — a behaviour (answer, survey, plan, code)
/// and a permission level — and the old composer drew both, as a mode menu and
/// a permission menu that disabled half of each other. Every tool in the
/// category settled on a single ladder instead: plan, ask, edit, full. This
/// is that ladder, mapped onto the runtime's pair.
public enum StudioMode: String, CaseIterable, Identifiable, Sendable {
    /// Reads and writes a plan; changes nothing.
    case plan
    /// Asks before every edit and command.
    case askBeforeEdits
    /// Edits files freely; asks before commands.
    case autoEdit
    /// Edits and runs commands; asks only to leave the project.
    case fullAccess
    /// Reads to answer a question — the runtime's Ask and Survey behaviours.
    /// Reachable from `/ask` and existing sessions, not offered in the picker.
    case answer

    public var id: String { rawValue }

    /// The four the picker offers.
    public static let ladder: [StudioMode] = [.plan, .askBeforeEdits, .autoEdit, .fullAccess]

    public init(behavior: AgentBehavior, permission: PermissionMode) {
        switch behavior {
        case .plan:
            self = .plan
        case .ask, .survey:
            self = .answer
        case .code:
            switch permission {
            case .readOnly: self = .plan
            case .askBeforeChanges: self = .askBeforeEdits
            case .workspaceWrite: self = .autoEdit
            case .fullAccess: self = .fullAccess
            }
        }
    }

    public var behavior: AgentBehavior {
        switch self {
        case .plan: .plan
        case .answer: .ask
        case .askBeforeEdits, .autoEdit, .fullAccess: .code
        }
    }

    public var permission: PermissionMode {
        switch self {
        case .plan, .answer: .readOnly
        case .askBeforeEdits: .askBeforeChanges
        case .autoEdit: .workspaceWrite
        case .fullAccess: .fullAccess
        }
    }

    public var title: String {
        switch self {
        case .plan: "Plan"
        case .askBeforeEdits: "Ask before edits"
        case .autoEdit: "Edit automatically"
        case .fullAccess: "Full access"
        case .answer: "Answer only"
        }
    }

    /// The composer chip's label.
    public var shortTitle: String {
        switch self {
        case .plan: "Plan"
        case .askBeforeEdits: "Ask"
        case .autoEdit: "Auto-edit"
        case .fullAccess: "Full access"
        case .answer: "Answer"
        }
    }

    public var detail: String {
        switch self {
        case .plan: "Reads the project and writes a plan. Changes nothing."
        case .askBeforeEdits: "Asks before every edit and every command."
        case .autoEdit: "Edits files freely. Asks before running commands."
        case .fullAccess: "Edits and runs commands. Asks only to leave the project."
        case .answer: "Reads the project to answer. Changes nothing."
        }
    }

    public var icon: JunoIcon {
        switch self {
        case .plan: .listChecks
        case .askBeforeEdits: .hand
        case .autoEdit: .pencil
        case .fullAccess: .lockOpen
        case .answer: .message
        }
    }

    /// ⌥⌘1…4, in ladder order.
    public var shortcutDigit: Character? {
        switch self {
        case .plan: "1"
        case .askBeforeEdits: "2"
        case .autoEdit: "3"
        case .fullAccess: "4"
        case .answer: nil
        }
    }
}
