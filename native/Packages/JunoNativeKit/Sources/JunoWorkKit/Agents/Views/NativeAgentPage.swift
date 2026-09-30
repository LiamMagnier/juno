import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// A cost the server wants a yes to before it starts something, and what to
/// send again once the person says yes.
struct NativeAgentCostQuestion: Identifiable {
    enum Retry {
        case idea(String)
        case task(title: String, goal: String)
    }

    let id = UUID()
    let message: String
    let retry: Retry
}

/// An agent's page, where a route or a notification lands on the agent
/// rather than on its thread: its profile, as a page (the web's
/// `/agents/[id]` opens the thread with the profile beside it; the profile is
/// the same view in both places). Message opens the thread, where the work,
/// its questions and its approvals are answered.
struct NativeAgentPage: View {
    let model: NativeAgentsModel
    let agentID: String
    let apps: [NativeAgentAppChoice]
    let openConversation: (String) -> Void
    /// The page's own way back, where it is not in a navigation stack.
    var back: (() -> Void)?
    /// Just hired: the face arrives, once. Kept for callers that still say
    /// so; the thread is where a new agent now opens.
    var welcome = false
    var dismissWelcome: (() -> Void)?
    /// The missing-agent state's way back to the team ("All agents").
    var allAgents: (() -> Void)?

    @State private var showingComputer = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if model.agent(id: agentID) == nil, model.loadingDetailID != agentID, model.phase != .loading {
                NativeAgentsNotice(
                    title: "This agent is no longer here",
                    message: "It may have been retired. Its thread and tasks are still in your chats.",
                    icon: .agents,
                    actionLabel: "All agents",
                    action: { leave() }
                )
            } else {
                NativeAgentProfileView(
                    model: model,
                    agentID: agentID,
                    apps: apps,
                    message: message,
                    openComputer: { showingComputer = true },
                    retired: leave
                )
            }
        }
        #if os(iOS)
        .navigationTitle(model.agent(id: agentID)?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.loadDetail(id: agentID) }
        #endif
        .sheet(isPresented: $showingComputer) {
            NativeAgentComputerSheet(model: model, agentID: agentID, done: { showingComputer = false })
        }
        .onDisappear { dismissWelcome?() }
        #if os(macOS)
        // A standing condition in the window's toast host rather than a box
        // in the page: posted when it changes, taken down when a later
        // request succeeds.
        .junoToastStatus(id: "agents.page.error", model.lastErrorDescription) { .error($0) }
        #endif
        .accessibilityIdentifier("juno.agents.page")
    }

    /// Message opens the agent's thread, created on first use, in the app's
    /// own chat.
    private func message() {
        Task {
            guard let conversationID = await model.threadConversationID(for: agentID) else { return }
            openConversation(conversationID)
        }
    }

    private func leave() {
        if let allAgents {
            allAgents()
        } else if let back {
            back()
        } else {
            dismiss()
        }
    }
}
