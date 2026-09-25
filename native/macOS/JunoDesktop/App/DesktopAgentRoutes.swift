import JunoCore
import JunoWorkKit
import SwiftUI

/// The Agents destination on the page stack (Phase 4 C3): the roster, an
/// agent's page (`.agent(id)`) and hiring (`.newAgent(template:)`) are the
/// app's routes, pushed on the destination's one `NavigationStack` — the
/// shared JunoWorkKit views draw them, restyled onto the page template on
/// the Mac. These wrappers read the stack's push and replace, which exist
/// only inside it.

/// The roster, with its pushes routed.
struct DesktopAgentsRoster: View {
    let model: NativeAgentsModel
    let apps: [NativeAgentAppChoice]
    let openConversation: (String) -> Void

    @Environment(\.desktopPush) private var push

    var body: some View {
        NativeAgentsScreen(
            model: model,
            apps: apps,
            openConversation: openConversation,
            openAgent: { push(.agent($0)) },
            openHire: { push(.newAgent(template: $0)) }
        )
    }
}

/// An agent's page. "All agents", from a page whose agent is gone, pops back
/// to the roster.
struct DesktopAgentRoute: View {
    let model: NativeAgentsModel
    let agentID: String
    let apps: [NativeAgentAppChoice]
    let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    let openConversation: (String) -> Void
    @Binding var welcomedAgentID: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NativeAgentRoutePage(
            model: model,
            agentID: agentID,
            apps: apps,
            localApprovals: localApprovals,
            decideLocally: decideLocally,
            openConversation: openConversation,
            welcome: welcomedAgentID == agentID,
            dismissWelcome: {
                if welcomedAgentID == agentID { welcomedAgentID = nil }
            },
            allAgents: { dismiss() }
        )
        .id(agentID)
    }
}

/// Hiring. On hire the page becomes the new agent's, with its welcome, so
/// back returns to the roster rather than to a spent form.
struct DesktopAgentHireRoute: View {
    let model: NativeAgentsModel
    let apps: [NativeAgentAppChoice]
    let templateID: String?
    @Binding var welcomedAgentID: String?

    @Environment(\.desktopReplace) private var replace
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NativeAgentHirePage(
            model: model,
            apps: apps,
            templateID: templateID,
            onCancel: { dismiss() },
            onHired: { agent in
                welcomedAgentID = agent.id
                replace(.agent(agent.id))
            }
        )
    }
}
