import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// **Agents**: the team, shared by the Mac and the iPhone. The web's
/// `/agents` (`agents-home.tsx`).
///
/// The page is a person's team. With no agents it is the Chat landing's twin;
/// with agents, the same composer above a grid of live cards (see
/// ``NativeAgentsHome``). A card opens the agent's thread, which is where an
/// agent is talked to, watched and changed; its profile is a sheet from the
/// thread's presence bar.
///
/// **Which agent's page is open** can be owned outside: a notification that
/// names an agent opens its page (its profile, as a page). Given no binding,
/// the screen keeps the choice itself.
public struct NativeAgentsScreen: View {
    private let model: NativeAgentsModel
    private let apps: [NativeAgentAppChoice]
    private let externalSelection: Binding<String?>?
    private let openConversation: (String) -> Void
    private let personName: String?
    private let focusComposer: Bool

    @State private var ownSelection: String?

    /// - Parameters:
    ///   - apps: the apps this account has connected, by name.
    ///   - selectedAgentID: the agent whose page is open, owned by the caller.
    ///     Nil keeps it inside the screen.
    ///   - localApprovals, decideLocally: kept for source compatibility. An
    ///     agent's approvals are answered in its thread, where they are raised.
    ///   - openConversation: opens a conversation by id in the app's chat.
    ///   - openAgent, openHire: kept for source compatibility. A card opens
    ///     the agent's thread, and a new agent starts from the field on this
    ///     page.
    ///   - personName: the person's name, for the empty page's question.
    ///   - focusComposer: focus the field on arrival (the web's `/agents/new`).
    public init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice] = [],
        selectedAgentID: Binding<String?>? = nil,
        localApprovals: (@MainActor (String) -> [WorkApprovalRequest])? = nil,
        decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)? = nil,
        openConversation: @escaping (String) -> Void,
        openAgent: ((String) -> Void)? = nil,
        openHire: ((String?) -> Void)? = nil,
        personName: String? = nil,
        focusComposer: Bool = false
    ) {
        self.model = model
        self.apps = apps
        self.externalSelection = selectedAgentID
        self.openConversation = openConversation
        self.personName = personName
        self.focusComposer = focusComposer
    }

    /// The caller's binding when there is one, the screen's own otherwise.
    private var selection: Binding<String?> {
        externalSelection ?? $ownSelection
    }

    public var body: some View {
        NativeAgentsHome(
            model: model,
            personName: personName,
            focusComposer: focusComposer,
            openAgent: openThread
        )
        #if os(iOS)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        #else
        // A failure while the team is showing is a standing condition in the
        // window's toast host rather than a box in the page.
        .junoToastStatus(
            id: "agents.roster.error",
            model.agents.isEmpty ? nil : model.lastErrorDescription
        ) { .error($0) }
        #endif
        .navigationDestination(item: selection) { agentID in
            NativeAgentPage(
                model: model,
                agentID: agentID,
                apps: apps,
                openConversation: openConversation
            )
            .id(agentID)
            #if os(macOS)
            .navigationTitle(model.agent(id: agentID)?.name ?? "Agent")
            #endif
        }
        .accessibilityIdentifier("juno.agents.roster")
    }

    /// A card opens the agent's thread: the one it carries, or the one the
    /// server makes for it on first use.
    private func openThread(_ agent: NativeAgent) {
        if let conversationID = agent.conversationID {
            openConversation(conversationID)
            return
        }
        Task {
            guard let conversationID = await model.threadConversationID(for: agent.id) else { return }
            openConversation(conversationID)
        }
    }
}

// MARK: - Routed pages (the Mac)

#if os(macOS)
/// An agent's page, as the Mac's page stack pushes it (`.agent(id)`): its
/// profile, as a page.
public struct NativeAgentRoutePage: View {
    private let model: NativeAgentsModel
    private let agentID: String
    private let apps: [NativeAgentAppChoice]
    private let openConversation: (String) -> Void
    private let welcome: Bool
    private let dismissWelcome: () -> Void
    private let allAgents: () -> Void

    /// - Parameters:
    ///   - localApprovals, decideLocally: kept for source compatibility; an
    ///     agent's approvals are answered in its thread.
    ///   - allAgents: the missing-agent state's way back to the team.
    public init(
        model: NativeAgentsModel,
        agentID: String,
        apps: [NativeAgentAppChoice] = [],
        localApprovals: (@MainActor (String) -> [WorkApprovalRequest])? = nil,
        decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)? = nil,
        openConversation: @escaping (String) -> Void,
        welcome: Bool = false,
        dismissWelcome: @escaping () -> Void = {},
        allAgents: @escaping () -> Void = {}
    ) {
        self.model = model
        self.agentID = agentID
        self.apps = apps
        self.openConversation = openConversation
        self.welcome = welcome
        self.dismissWelcome = dismissWelcome
        self.allAgents = allAgents
    }

    public var body: some View {
        NativeAgentPage(
            model: model,
            agentID: agentID,
            apps: apps,
            openConversation: openConversation,
            back: nil,
            welcome: welcome,
            dismissWelcome: dismissWelcome,
            allAgents: allAgents
        )
        .navigationTitle(model.agent(id: agentID)?.name ?? "Agent")
    }
}

/// "New agent", as the Mac's page stack pushes it (`.newAgent(template:)`):
/// the web's `/agents/new`, which is the team page with its field focused. A
/// new agent starts from a job described in words and sets itself up in its
/// own thread.
public struct NativeAgentHirePage: View {
    private let model: NativeAgentsModel
    private let personName: String?
    private let onHired: (NativeAgent) -> Void

    /// - Parameters:
    ///   - apps, templateID, onCancel: kept for source compatibility.
    ///   - onHired: the new agent, once it exists, to open its thread.
    public init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice] = [],
        templateID: String?,
        personName: String? = nil,
        onCancel: @escaping () -> Void,
        onHired: @escaping (NativeAgent) -> Void
    ) {
        self.model = model
        self.personName = personName
        self.onHired = onHired
    }

    public var body: some View {
        NativeAgentsHome(model: model, personName: personName, focusComposer: true, openAgent: onHired)
            .navigationTitle("New agent")
            .junoToastStatus(
                id: "agents.roster.error",
                model.agents.isEmpty ? nil : model.lastErrorDescription
            ) { .error($0) }
    }
}
#endif

/// A screen with nothing to show but a reason: `JunoEmptyState` on the Mac,
/// the system's unavailable view on the phone, as each app's own pages do.
struct NativeAgentsNotice: View {
    let title: String
    let message: String
    let icon: JunoIcon
    var actionLabel: String?
    var action: (() -> Void)?

    var body: some View {
        #if os(macOS)
        JunoEmptyState(
            title: title,
            message: message,
            icon: icon,
            actionLabel: actionLabel,
            action: action
        )
        #else
        ContentUnavailableView {
            JunoIconLabel(verbatim: title, icon: icon, size: 28)
        } description: {
            Text(message)
        } actions: {
            if let actionLabel, let action {
                Button(actionLabel, action: action)
                    .buttonStyle(.bordered)
                    .nativeAgentNeutralTint()
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
        }
        #endif
    }
}
