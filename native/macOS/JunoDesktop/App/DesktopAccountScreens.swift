import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

struct DesktopDestinationView: View {
    @Binding var destination: DesktopDestination
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    @Binding var requestedProjectID: String?
    /// The agent open on the Agents destination, owned by the window so its
    /// sidebar row can open it and show it open. Nil is the roster.
    @Binding var selectedAgentID: String?
    /// ⌘U and drops, on their way to the chat route's composer.
    @Binding var composerRequest: ChatComposerRequest?
    /// ⌘F, ⌘G and ⇧⌘G, on their way to the chat route's find bar.
    @Binding var findCommand: DesktopFindCommand?
    /// The draft is private: nothing is saved, synced or remembered. The chat
    /// route then sends to the in-memory private chat instead of the store.
    var isPrivateChat = false
    /// Whether a call is live on the chat route, for the toolbar's Private
    /// toggle.
    var callActiveChanged: (Bool) -> Void = { _ in }
    /// The window's Share, for a reply's action row. Nil without a share
    /// service.
    var shareConversation: (() -> Void)? = nil
    /// Fork Privately, which the window answers by starting a private chat.
    var forkPrivately: (([NativePrivateChatModel.Turn]) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// What the Agents destination's stack holds, as it last said: how the
    /// window's open agent (its sidebar row) follows a back button, and how a
    /// sidebar row knows whether its agent is already showing.
    @State private var agentsPath: [DesktopPageRoute] = []
    /// Bumped to give the Agents stack a fresh identity — back to the roster —
    /// when the Agents row is chosen while an agent's page is up (the web's
    /// `/agents`, never the last agent visited).
    @State private var agentsStackGeneration = 0
    /// The agent just hired, whose page opens with a word of welcome, once.
    @State private var welcomedAgentID: String?
    /// The Artifacts page's Share… (seam 7), one per window like the chat's.
    @State private var artifactShare = DesktopShareState()

    var body: some View {
        // One identity per destination, so a change of page is a real
        // view-hierarchy transition — the web's cross-fade + 6pt rise — rather
        // than the old page's subviews being reused under the new one. It also
        // gives every page a fresh stack: leaving a page forgets what was
        // pushed on it.
        routed
            .id(destination)
            .transition(.junoPage)
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: destination)
            // The window's open agent — a sidebar row, a notification, an
            // agent's thread header — is `.agent(id)` pushed on the Agents
            // stack (Phase 4 §2.5), once, unless it is already showing.
            .onChange(of: selectedAgentID, initial: true) { _, agentID in
                if let agentID {
                    guard agentsPath.last != .agent(agentID) else { return }
                    DesktopPageRouter.shared.open(.agents, route: .agent(agentID))
                } else if destination == .agents, agentsPath.contains(where: Self.isAgentPage) {
                    agentsPath = []
                    agentsStackGeneration &+= 1
                }
            }
            // A destination's stack starts empty; so does what it last said.
            .onChange(of: destination) { _, _ in agentsPath = [] }
    }

    /// The chat route as it is; every page inside a `NavigationStack` of its
    /// own (spec §9): a detail page — an agent, and in track B a project, an
    /// automation, a skill, a host — is pushed with
    /// `.navigationDestination` and comes back with the system's back button,
    /// instead of each page swapping itself out and drawing its own.
    ///
    /// The stack sits *inside* ``ChatDetail``, below the one toolbar and
    /// title it declares, so a push never changes who owns them; the page's
    /// name is restated as the stack root's title so the window keeps it
    /// whichever of the two the system reads.
    @ViewBuilder
    private var routed: some View {
        if destination == .chat {
            page
        } else if destination == .agents {
            DesktopPageStack(
                destination: destination,
                router: .shared,
                root: { page },
                page: { route in routePage(route) },
                pathChanged: agentsPathChanged
            )
            .id(agentsStackGeneration)
        } else {
            DesktopPageStack(destination: destination, router: .shared) {
                page
            } page: { route in
                routePage(route)
            }
        }
    }

    private static func isAgentPage(_ route: DesktopPageRoute) -> Bool {
        if case .agent = route { return true }
        return false
    }

    /// The Agents stack moved: the open agent is the last one pushed, or none.
    private func agentsPathChanged(_ path: [DesktopPageRoute]) {
        agentsPath = path
        let open = path.reversed().lazy.compactMap { route -> String? in
            if case .agent(let id) = route { return id }
            return nil
        }.first
        if selectedAgentID != open { selectedAgentID = open }
    }

    /// The page a route pushes. One `navigationDestination` for all of them,
    /// at the stack root (Phase 4 brief §2.5).
    @ViewBuilder
    private func routePage(_ route: DesktopPageRoute) -> some View {
        switch route {
        case .project(let id):
            projectPage(id)
        case .artifact(let id, let version):
            artifactPage(id, version: version)
        case .skill(let id):
            if let model = configuration.skillLibraryModel {
                DesktopSkillPage(
                    model: DesktopSkillPageModel(id: id, library: model),
                    projects: projectOptions
                )
            } else {
                unavailable("Skills", "The skills service is unavailable.")
            }
        case .newSkill:
            if let model = configuration.skillLibraryModel {
                DesktopNewSkillPage(model: model, startDraft: startDraft)
            } else {
                unavailable("Skills", "The skills service is unavailable.")
            }
        case .automation, .newAutomation:
            if let context = automationContext {
                DesktopAutomationRoutePage(route: route, context: context)
            } else {
                unavailable("Automations", "Automations are unavailable.")
            }
        case .host(let id):
            if let model = configuration.workHostsModel {
                DesktopHostPage(
                    hostID: id,
                    model: model,
                    accountID: session.profile.id,
                    thisMac: configuration.workHostModel?.pairedHostID,
                    localHost: configuration.workHostModel
                )
            } else {
                unavailable("Permissions", "Juno Work is unavailable.")
            }
        case .agent(let id):
            if let model = configuration.agentsModel {
                DesktopAgentRoute(
                    model: model,
                    agentID: id,
                    apps: agentApps,
                    localApprovals: localApprovals,
                    decideLocally: decideLocally,
                    openConversation: openAgentThread,
                    welcomedAgentID: $welcomedAgentID
                )
            } else {
                unavailable("Agents", "The agents service is unavailable.")
            }
        case .newAgent(let template):
            if let model = configuration.agentsModel {
                DesktopAgentHireRoute(
                    model: model,
                    apps: agentApps,
                    templateID: template,
                    personName: session.profile.name,
                    openConversation: openAgentThread,
                    welcomedAgentID: $welcomedAgentID
                )
            } else {
                unavailable("Agents", "The agents service is unavailable.")
            }
        case .document:
            // The document inspector (Phase 4 A7) waits on the server; nothing
            // pushes this yet.
            unavailable("Not available", "This page is not on the Mac yet.")
        }
    }

    /// What the automation pages need, when this window has Work.
    private var automationContext: DesktopAutomationContext? {
        guard let model = configuration.workAutomationModel else { return nil }
        return DesktopAutomationContext(
            model: model,
            hostsModel: configuration.workHostsModel,
            fallbackHosts: configuration.workModel?.hosts,
            modelOptions: (conversationModel.selectableModels).filter { $0.isChatCapable && $0.supportsTools },
            conversationForSession: { sessionID in
                configuration.workModel?.sessions.first { $0.id == sessionID }?.conversationID
            },
            openConversation: openAgentThread
        )
    }

    @ViewBuilder
    private var page: some View {
        switch destination {
        // The Search page is gone: ⌘K / Search is the panel (Phase 3). A stored
        // `.search` reads as Chat.
        case .chat, .search:
            // One view for an ordinary chat and a private one (§5.8): private
            // mode is the same column and the same composer with the in-memory
            // model behind them, so turning it on or off keeps the composer —
            // its words, its focus — where it is.
            DesktopConversationView(
                model: conversationModel,
                attachmentModel: configuration.attachmentModel,
                profileName: session.profile.name,
                configuration: configuration,
                session: session,
                draftProjectID: $draftProjectID,
                draftPrompt: $draftPrompt,
                composerRequest: $composerRequest,
                findCommand: $findCommand,
                openDestination: { destination = $0 },
                privateChat: isPrivateChat ? configuration.privateChatModel : nil,
                callActiveChanged: callActiveChanged,
                shareConversation: shareConversation,
                forkPrivately: forkPrivately,
                openAgent: openAgent,
                openAgentThread: openAgentThread
            )
        case .projects:
            if let model = configuration.projectModel {
                DesktopProjectsScreen(
                    model: model,
                    fileAccess: fileAccess,
                    createUnnamed: createUnnamedProject
                )
            } else {
                unavailable("Projects", "The synchronized project store is unavailable.")
            }
        case .library:
            if let model = configuration.libraryPageModel {
                DesktopLibraryScreen(
                    model: model,
                    documentIndex: configuration.documentIndexModel,
                    accountID: session.profile.id,
                    attachmentClient: configuration.requestSender.map {
                        NativeAttachmentAPIClient(sender: $0)
                    },
                    generateClient: configuration.generateClient,
                    modelCatalog: conversationModel.modelCatalog,
                    fileAccess: fileAccess,
                    openConversation: openLibraryConversation
                )
            } else {
                unavailable("Library", "The authenticated file library is unavailable.")
            }
        case .artifacts:
            artifactsPage
        case .agents:
            if !DesktopPlanGate.shared.allows(.agents) {
                DesktopPlanLockedPage(feature: .agents, title: "Orbit", icon: JunoShellDestination.agents.icon)
            } else if let model = configuration.agentsModel {
                DesktopAgentsRoster(
                    model: model,
                    apps: agentApps,
                    personName: session.profile.name,
                    openConversation: openAgentThread
                )
            } else {
                unavailable("Agents", "The agents service is unavailable.")
            }
        case .automations:
            if let context = automationContext {
                DesktopAutomationsScreen(
                    model: context.model,
                    conversationForSession: context.conversationForSession,
                    openConversation: context.openConversation
                )
            } else {
                unavailable("Automations", "Automations are unavailable.")
            }
        case .permissions:
            if let model = configuration.workHostsModel {
                DesktopPermissionsScreen(
                    model: model,
                    accountID: session.profile.id,
                    thisMac: configuration.workHostModel?.pairedHostID
                )
            } else {
                unavailable("Permissions", "Juno Work is unavailable.")
            }
        case .connections:
            if let model = configuration.connectorModel {
                DesktopConnectionsScreen(model: model)
            } else {
                unavailable("Connections", "The connector service is unavailable.")
            }
        case .design:
            // Never reached: `.design` is normalized to Artifacts with the
            // Designs filter before it is stored (Phase 4 A2). Drawn as
            // Artifacts all the same, should an old caller get here.
            artifactsPage
        case .memory:
            if let model = configuration.memorySettingsModel {
                // No back control: the column is the way away from this page.
                // The one Settings draws is labelled "Back to Settings" —
                // Settings' own route in — and would send the reader to Chat.
                DesktopMemoryScreen(
                    model: model,
                    back: nil,
                    context: DesktopMemoryContext(configuration: configuration),
                    openConversation: openConversation
                )
            } else {
                unavailable("Memory", "The synchronized settings store is unavailable.")
            }
        case .skills:
            if let model = configuration.skillLibraryModel {
                DesktopSkillsScreen(model: model, startDraft: startDraft)
            } else {
                unavailable("Skills", "The skills service is unavailable.")
            }
        case .assistants:
            if let model = configuration.assistantsModel {
                DesktopAssistantsScreen(model: model, models: assistantModels)
            } else {
                unavailable("Assistants", "The assistants service is unavailable.")
            }
        }
    }

    /// A stored file's bytes, through the sync `attachment` entity's fresh
    /// signed URL (``NativeProjectAPIClient/accessFile(id:for:)``).
    private var fileAccess: ((String) async -> NativeProjectFileAccess?)? {
        guard let sender = configuration.requestSender else { return nil }
        let client = NativeProjectAPIClient(sender: sender)
        let accountID = session.profile.id
        return { id in try? await client.accessFile(id: id, for: accountID) }
    }

    /// The Library's "Open source chat", and its empty state's "Go to chat"
    /// (an empty id), which starts a new chat.
    private func openLibraryConversation(_ id: String) {
        guard !id.isEmpty else {
            conversationModel.selectedConversationID = nil
            conversationModel.isDraftingNewConversation = true
            destination = .chat
            return
        }
        openConversation(id)
    }

    /// The projects a memory or a skill can be filed in.
    private var projectOptions: [DesktopMemoryProject] {
        (configuration.projectModel?.projects ?? []).map { DesktopMemoryProject(id: $0.id, name: $0.name) }
    }

    /// The chat models an assistant may prefer (the web's `MODEL_LIST`
    /// filtered to chat and available), Auto aside: the editor offers it first.
    private var assistantModels: [DesktopAssistantModelOption] {
        conversationModel.modelCatalog
            .filter { $0.modality == "chat" && $0.id != "juno:auto" && !$0.lifecycle.lowercased().contains("soon") }
            .map {
                // "Anthropic · Claude" is the vendor and the line; the web's
                // row names the vendor only.
                DesktopAssistantModelOption(
                    id: $0.id,
                    name: $0.displayName,
                    provider: $0.providerName.components(separatedBy: " · ").first ?? $0.providerName
                )
            }
    }

    /// A new chat with `prompt` in its composer, not sent: Skills' "Create
    /// with Juno".
    private func startDraft(_ prompt: String) {
        draftProjectID = nil
        draftPrompt = prompt
        conversationModel.isDraftingNewConversation = true
        conversationModel.selectedConversationID = nil
        destination = .chat
    }

    @ViewBuilder
    private var artifactsPage: some View {
        if let model = configuration.artifactModel {
            DesktopArtifactsScreen(
                model: model,
                accountID: session.profile.id,
                requestSender: configuration.requestSender,
                syncModel: configuration.syncModel,
                // Share… on a row (Phase 3 seam 7): the Share popover's
                // content, as the web's dialog, in a sheet over the page.
                shareArtifact: configuration.shareClient.map { client in
                    let accountID = session.profile.id
                    return { artifact in
                        artifactShare.start(
                            .artifact(artifact.id),
                            service: DesktopNativeShareService(client: client, accountID: accountID)
                        )
                    }
                },
                newChat: { startNewChat() }
            )
            .sheet(isPresented: $artifactShare.isPresented) {
                DesktopShareSheet(state: artifactShare)
            }
        } else {
            unavailable("Artifacts", "The synchronized artifact store is unavailable.")
        }
    }

    @ViewBuilder
    private func projectPage(_ id: String) -> some View {
        if let model = configuration.projectModel {
            DesktopProjectPage(
                projectID: id,
                model: model,
                conversationModel: conversationModel,
                workspaceModel: configuration.projectWorkspaceModel,
                workModel: configuration.workModel,
                artifactModel: configuration.artifactModel,
                modelCatalog: conversationModel.modelCatalog,
                fileAccess: fileAccess,
                openConversation: openConversation,
                startConversation: { prompt in startConversation(in: id, prompt: prompt) },
                openMemory: configuration.memorySettingsModel == nil ? nil : { destination = .memory }
            )
            // A pinned project's sidebar row reads as selected while its page
            // is up, and hands the highlight back when it is left.
            .onDisappear {
                if requestedProjectID == id { requestedProjectID = nil }
            }
        } else {
            unavailable("Project", "The synchronized project store is unavailable.")
        }
    }

    @ViewBuilder
    private func artifactPage(_ id: String, version: Int?) -> some View {
        if let model = configuration.artifactModel {
            ArtifactPage(artifactID: id, model: model, requestedVersion: version)
        } else {
            unavailable("Artifact", "The synchronized artifact store is unavailable.")
        }
    }

    /// A new, empty chat.
    private func startNewChat() {
        draftProjectID = nil
        draftPrompt = nil
        conversationModel.selectedConversationID = nil
        conversationModel.isDraftingNewConversation = true
        destination = .chat
    }

    /// New project with no name: `POST /api/projects`, which names it
    /// "Untitled project" until its first chat names it (the sync mutation
    /// needs a name, so the blank case takes the web's route). Nil without a
    /// transport, which keeps the name required.
    private var createUnnamedProject: (() async -> String?)? {
        guard let sender = configuration.requestSender, let projectModel = configuration.projectModel else { return nil }
        let accountID = session.profile.id
        let syncModel = configuration.syncModel
        return {
            guard let request = try? NativeBearerRequest(
                path: "/api/projects",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
                body: Data("{}".utf8)
            ),
                let response = try? await sender.send(request, for: accountID),
                (200...299).contains(response.statusCode),
                let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
                let id = object["id"] as? String
            else { return nil }
            await syncModel?.refresh()
            await projectModel.reload()
            return id
        }
    }

    private func openConversation(_ id: String) {
        draftProjectID = nil
        conversationModel.isDraftingNewConversation = false
        conversationModel.selectedConversationID = id
        destination = .chat
    }

    /// Opens an agent's thread from its page.
    ///
    /// The server creates the thread on first use, so it can be a conversation
    /// this Mac has never synced — and `NativeConversationModel.reload()` drops
    /// a selection its store does not contain. The store is brought up to date
    /// first, as a saved voice call is, and only then is the thread selected.
    private func openAgentThread(_ id: String) {
        Task {
            if !conversationModel.conversations.contains(where: { $0.id == id }) {
                await configuration.syncModel?.refresh()
                await conversationModel.reload()
            }
            openConversation(id)
            if let agents = configuration.agentsModel,
               let agent = agents.agents.first(where: { $0.conversationID == id }),
               let message = await agents.pendingStarter(for: agent.id),
               let conversation = conversationModel.conversations.first(where: { $0.id == id }),
               conversationModel.messages(for: id).isEmpty, !conversationModel.isGenerating {
                _ = conversationModel.sendMessage(conversationID: id, prompt: message, modelID: conversation.model,
                    reasoningEffort: nil, connectors: agent.connectorIDs)
            }
        }
    }

    /// Opens an agent's page, from the header of its thread.
    private func openAgent(_ id: String) {
        selectedAgentID = id
        destination = .agents
    }

    /// What a run executing on this Mac has stopped to ask, for an agent's
    /// page. Those approvals have no server row — the run is suspended in this
    /// process — so the page cannot read them from its task's run the way it
    /// reads a cloud run's. Nil where this Mac hosts no Work.
    private var localApprovals: (@MainActor (String) -> [WorkApprovalRequest])? {
        guard let hostModel = configuration.workHostModel else { return nil }
        return { runID in hostModel.localApprovals(forRun: runID) }
    }

    /// Answers one of those through the runtime holding the run, with the
    /// digest of the action the card showed — the same call the Work thread's
    /// card makes.
    private var decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)? {
        guard let hostModel = configuration.workHostModel else { return nil }
        return { approval, decision in
            hostModel.localApprovalDecider?(approval.id, decision, approval.actionDigest)
        }
    }

    /// The apps an agent may be given: only the connected ones, by name.
    private var agentApps: [NativeAgentAppChoice] {
        (configuration.connectorModel?.linked ?? [])
            .filter(\.connected)
            .map { NativeAgentAppChoice(id: $0.id, label: $0.label) }
    }

    private func startConversation(in projectID: String, prompt: String?) {
        draftProjectID = projectID
        draftPrompt = prompt
        conversationModel.isDraftingNewConversation = true
        conversationModel.selectedConversationID = nil
        destination = .chat
    }

    private func unavailable(_ title: String, _ description: String) -> some View {
        JunoEmptyState(title: title, message: description, icon: .triangleAlert)
    }
}
