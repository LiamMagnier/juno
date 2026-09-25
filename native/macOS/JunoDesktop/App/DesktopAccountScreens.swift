import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
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
        } else {
            DesktopPageStack(destination: destination, router: .shared) {
                page
            } page: { route in
                routePage(route)
            }
        }
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
        case .document, .automation, .newAutomation, .host, .agent, .newAgent:
            // Built by the other stages (A and C); nothing pushes these here.
            unavailable("Not available", "This page is not on the Mac yet.")
        }
    }

    @ViewBuilder
    private var page: some View {
        switch destination {
        case .chat:
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
                openAgent: openAgent
            )
        case .search:
            if let model = configuration.searchModel {
                DesktopSearchScreen(
                    model: model,
                    openConversation: openConversation,
                    // The run in flight in Chat, so the screen a reader uses to
                    // find things can say "Juno is reading twelve pages about
                    // this right now" instead of "No results".
                    researchActivity: conversationModel.researchActivity,
                    // Only offered when there is a conversation to return to.
                    // A run always belongs to one, but a reader can reach Search
                    // from a draft that has not been created yet, and a link to
                    // nowhere is worse than no link.
                    openResearchRun: conversationModel.selectedConversationID.map { id in
                        { openConversation(id) }
                    }
                )
            } else {
                unavailable("Search", "The encrypted search index is unavailable.")
            }
        case .projects:
            if let model = configuration.projectModel {
                DesktopProjectsScreen(
                    model: model,
                    conversationModel: conversationModel,
                    configuration: configuration,
                    session: session,
                    openConversation: openConversation,
                    startConversation: startConversation,
                    requestedProjectID: $requestedProjectID
                )
            } else {
                unavailable("Projects", "The synchronized project store is unavailable.")
            }
        case .library:
            if let model = configuration.libraryModel {
                DesktopLibraryScreen(
                    model: model,
                    documentIndex: configuration.documentIndexModel,
                    accountID: session.profile.id,
                    attachmentClient: configuration.requestSender.map {
                        NativeAttachmentAPIClient(sender: $0)
                    },
                    generateClient: configuration.generateClient,
                    modelCatalog: conversationModel.modelCatalog,
                    openConversation: openConversation
                )
            } else {
                unavailable("Library", "The authenticated file library is unavailable.")
            }
        case .artifacts:
            artifactsPage
        case .agents:
            if let model = configuration.agentsModel {
                NativeAgentsScreen(
                    model: model,
                    apps: agentApps,
                    selectedAgentID: $selectedAgentID,
                    localApprovals: localApprovals,
                    decideLocally: decideLocally,
                    openConversation: openAgentThread
                )
            } else {
                unavailable("Agents", "The agents service is unavailable.")
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
            DesktopArtifactsScreen(model: model)
        } else {
            unavailable("Artifacts", "The synchronized artifact store is unavailable.")
        }
    }

    @ViewBuilder
    private func projectPage(_ id: String) -> some View {
        unavailable("Project", "This project page is not on the Mac yet.")
    }

    @ViewBuilder
    private func artifactPage(_ id: String, version: Int?) -> some View {
        unavailable("Artifact", "This artifact page is not on the Mac yet.")
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
