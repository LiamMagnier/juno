import JunoCore
import JunoWorkKit
import SwiftUI

/// The Agents destination on the page stack: the team page, an agent's page
/// (`.agent(id)`, its profile as a page) and New agent (`.newAgent`, the team
/// page with its field focused) are the app's routes, pushed on the
/// destination's one `NavigationStack`. A card, and a new agent once it
/// exists, open the agent's thread in Chat.

/// The team page.
struct DesktopAgentsRoster: View {
    let model: NativeAgentsModel
    let apps: [NativeAgentAppChoice]
    var personName: String? = nil
    let openConversation: (String) -> Void

    var body: some View {
        NativeAgentsScreen(
            model: model,
            apps: apps,
            openConversation: openConversation,
            personName: personName
        )
    }
}

/// An agent's page. "All agents", from a page whose agent is gone, pops back
/// to the team.
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

/// New agent: the team page with its field focused. Once the agent exists,
/// its thread opens, where it sets itself up in conversation.
struct DesktopAgentHireRoute: View {
    let model: NativeAgentsModel
    let apps: [NativeAgentAppChoice]
    let templateID: String?
    var personName: String? = nil
    let openConversation: (String) -> Void
    @Binding var welcomedAgentID: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NativeAgentHirePage(
            model: model,
            apps: apps,
            templateID: templateID,
            personName: personName,
            onCancel: { dismiss() },
            onHired: { agent in
                if let conversationID = agent.conversationID {
                    openConversation(conversationID)
                    return
                }
                Task {
                    if let conversationID = await model.threadConversationID(for: agent.id) {
                        openConversation(conversationID)
                    }
                }
            }
        )
    }
}
