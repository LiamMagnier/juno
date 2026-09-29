import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// **Agents** — the roster, each agent's page, and hiring (docs/design/AGENTS.md
/// §3.1 and §5), shared by the Mac and the iPhone.
///
/// The roster is a tile per agent — face, name, role and one sentence of
/// state — and a New agent button. Nothing else. The agents that need the
/// person come first, so the first tile is always the one to look at, which is
/// the question this page is opened to answer.
///
/// **An agent is pushed, on both platforms.** On the Mac this screen is a
/// page inside the Chat window's detail column, which gives every page a
/// navigation stack of its own (MACOS_LIQUID_GLASS_REDESIGN.md §9), so opening
/// an agent pushes its page and the system's back button returns; on the
/// iPhone the screen sits in the app's stack. The page draws no back control
/// of its own on either.
///
/// "Message" hands the agent's thread to `openConversation`, which each app
/// wires to its own chat: the thread is an ordinary conversation.
///
/// **Which agent is open** can be owned outside: the Mac's sidebar opens an
/// agent by its row and highlights the row of the one open, and a
/// notification opens the agent it is about. Given no binding, the screen
/// keeps the choice itself.
public struct NativeAgentsScreen: View {
    private let model: NativeAgentsModel
    private let apps: [NativeAgentAppChoice]
    private let externalSelection: Binding<String?>?
    private let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    private let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    private let openConversation: (String) -> Void
    /// The Mac's page stack: an agent's page and hiring are pushed as the
    /// app's own routes (`.agent(id)`, `.newAgent(template:)`) rather than
    /// through this screen's navigation destination and sheet. Nil keeps
    /// the screen's own.
    private let openAgent: ((String) -> Void)?
    private let openHire: ((String?) -> Void)?

    @State private var ownSelection: String?
    @State private var hiringFrom: NativeAgentTemplate?
    /// The agent just hired, whose page opens with a word of welcome.
    @State private var welcomedAgentID: String?

    /// - Parameters:
    ///   - apps: the apps this account has connected, offered to an agent by
    ///     name. Empty hides the choice rather than offering nothing.
    ///   - selectedAgentID: the open agent's id, owned by the caller. Nil
    ///     keeps it inside the screen.
    ///   - localApprovals: the approvals a run executing on this Mac has
    ///     raised, by run id — they have no server row, so the Now tab cannot
    ///     read them any other way.
    ///   - decideLocally: answers one of those, through the coordinator
    ///     holding the run. Both nil anywhere but the Mac.
    ///   - openConversation: opens a conversation by id in the app's chat.
    public init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice] = [],
        selectedAgentID: Binding<String?>? = nil,
        localApprovals: (@MainActor (String) -> [WorkApprovalRequest])? = nil,
        decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)? = nil,
        openConversation: @escaping (String) -> Void,
        openAgent: ((String) -> Void)? = nil,
        openHire: ((String?) -> Void)? = nil
    ) {
        self.model = model
        self.apps = apps
        self.externalSelection = selectedAgentID
        self.localApprovals = localApprovals
        self.decideLocally = decideLocally
        self.openConversation = openConversation
        self.openAgent = openAgent
        self.openHire = openHire
    }

    /// The caller's binding when there is one, the screen's own otherwise.
    private var selection: Binding<String?> {
        externalSelection ?? $ownSelection
    }

    public var body: some View {
        content
            .sheet(item: $hiringFrom) { template in
                NativeAgentHireView(
                    model: model,
                    apps: apps,
                    template: template,
                    onCancel: { hiringFrom = nil },
                    onHired: { agent in
                        hiringFrom = nil
                        welcomedAgentID = agent.id
                        selection.wrappedValue = agent.id
                    }
                )
            }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        if openAgent != nil {
            // Routed by the app: the page and hiring are its routes, pushed
            // on the destination's one stack (Phase 4 §2.5).
            roster
        } else {
            // Pushed on the page's own stack (the foundations' `routed`
            // NavigationStack); the caller's selection drives the push, so the
            // sidebar's agent rows and a notification open the same page. One
            // page per agent: opening another starts on its Now tab.
            roster
                .navigationDestination(item: selection) { agentID in
                    page(agentID, back: nil)
                        .id(agentID)
                        .navigationTitle(model.agents.first { $0.id == agentID }?.name ?? "Agent")
                }
        }
        #else
        roster
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: selection) { agentID in
                page(agentID, back: nil)
            }
            .refreshable { await model.refresh() }
        #endif
    }

    private func page(_ agentID: String, back: (() -> Void)?) -> NativeAgentPage {
        NativeAgentPage(
            model: model,
            agentID: agentID,
            apps: apps,
            openConversation: openConversation,
            back: back,
            localApprovals: localApprovals,
            decideLocally: decideLocally,
            welcome: welcomedAgentID == agentID,
            dismissWelcome: { dismissWelcome(agentID) }
        )
    }

    private func dismissWelcome(_ agentID: String) {
        if welcomedAgentID == agentID {
            welcomedAgentID = nil
        }
    }

    @ViewBuilder
    private var roster: some View {
        #if os(macOS)
        // The page template draws every state under one header.
        NativeAgentRoster(model: model, open: open, hire: hire, hireFromScratch: hireFromScratch, newAgent: newAgent)
        #else
        switch model.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading agents")
        case .failed, .offline:
            if model.agents.isEmpty {
                NativeAgentsNotice(
                    title: "Couldn’t load your agents",
                    message: model.lastErrorDescription ?? "Juno could not reach your agents.",
                    icon: .agents,
                    actionLabel: "Try again",
                    action: { Task { await model.refresh() } }
                )
            } else {
                NativeAgentRoster(model: model, open: open, hire: hire)
            }
        case .ready:
            NativeAgentRoster(model: model, open: open, hire: hire)
        }
        #endif
    }

    private func open(_ agentID: String) {
        if let openAgent {
            openAgent(agentID)
        } else {
            selection.wrappedValue = agentID
        }
    }

    private func hire(_ template: NativeAgentTemplate) {
        if let openHire {
            openHire(template.id)
        } else {
            hiringFrom = template
        }
    }

    private func hireFromScratch() {
        if let custom = NativeAgentTemplate.named("custom") { hire(custom) }
    }

    /// The header's New agent: the web's `/agents/new`, on the first
    /// starting point.
    private func newAgent() {
        if let openHire {
            openHire(nil)
        } else {
            hiringFrom = NativeAgentTemplate.all[0]
        }
    }
}

// MARK: - Routed pages (the Mac)

#if os(macOS)
/// An agent's page, as the Mac's page stack pushes it (`.agent(id)`).
public struct NativeAgentRoutePage: View {
    private let model: NativeAgentsModel
    private let agentID: String
    private let apps: [NativeAgentAppChoice]
    private let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    private let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    private let openConversation: (String) -> Void
    private let welcome: Bool
    private let dismissWelcome: () -> Void
    private let allAgents: () -> Void

    /// - Parameters:
    ///   - welcome: just hired — the page opens with a word of welcome, once.
    ///   - allAgents: the missing-agent state's way back to the roster.
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
        self.localApprovals = localApprovals
        self.decideLocally = decideLocally
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
            localApprovals: localApprovals,
            decideLocally: decideLocally,
            welcome: welcome,
            dismissWelcome: dismissWelcome,
            allAgents: allAgents
        )
        .navigationTitle(model.agent(id: agentID)?.name ?? "Agent")
    }
}

/// Hiring, as the Mac's page stack pushes it (`.newAgent(template:)`): the
/// web's `/agents/new?template=`, a page rather than a sheet (register #66).
public struct NativeAgentHirePage: View {
    private let model: NativeAgentsModel
    private let apps: [NativeAgentAppChoice]
    private let templateID: String?
    private let onCancel: () -> Void
    private let onHired: (NativeAgent) -> Void

    public init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice] = [],
        templateID: String?,
        onCancel: @escaping () -> Void,
        onHired: @escaping (NativeAgent) -> Void
    ) {
        self.model = model
        self.apps = apps
        self.templateID = templateID
        self.onCancel = onCancel
        self.onHired = onHired
    }

    public var body: some View {
        NativeAgentStartView(
            model: model,
            templateID: templateID,
            onCancel: onCancel,
            onHired: onHired
        )
        .navigationTitle("New agent")
    }
}

/// The Mac creates a persistent conversation before any configuration.
public struct NativeAgentWorkspaceFrame<Content: View>: View {
    let model: NativeAgentsModel
    let currentAgentID: String?
    let openAgent: (String) -> Void
    let createAgent: () -> Void
    let content: Content
    @State private var query = ""
    @State private var teamExpanded = false

    public init(model: NativeAgentsModel, currentAgentID: String? = nil, openAgent: @escaping (String) -> Void,
                createAgent: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.model = model; self.currentAgentID = currentAgentID; self.openAgent = openAgent
        self.createAgent = createAgent; self.content = content()
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                team.frame(width: 210)
                Divider()
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }.frame(minWidth: 740)
            VStack(spacing: 0) {
                Button { teamExpanded.toggle() } label: {
                    HStack { Text("Agents").junoType(.ui); Spacer(); JunoIconView(.chevronDown, size: 14) }
                        .padding(JunoSpace.regular)
                }.buttonStyle(.plain)
                if teamExpanded { team.frame(maxHeight: 300) }
                Divider()
                content
            }
        }.background(Color.junoCanvas)
    }

    private var team: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text("Agents").junoType(JunoType.body.weight(.medium)); Spacer(); Text("\(model.agents.count)").junoType(.caption).foregroundStyle(Color.junoSecondaryInk) }
                .padding(.bottom, JunoSpace.roomy)
            Button(action: createAgent) {
                Label("Create agent", icon: .plus).junoType(.ui).frame(maxWidth: .infinity, alignment: .leading).padding(JunoSpace.cozy)
            }.buttonStyle(.plain).background(Color.junoRaised, in: RoundedRectangle(cornerRadius: 9))
            TextField("Find an agent", text: $query).textFieldStyle(.plain).junoType(.ui)
                .padding(.horizontal, JunoSpace.cozy).padding(.vertical, JunoSpace.regular).accessibilityLabel("Find an agent")
            ScrollView {
                VStack(spacing: JunoSpace.tight) {
                    ForEach(model.sidebarAgents.filter { query.isEmpty || "\($0.name) \($0.role)".localizedCaseInsensitiveContains(query) }) { agent in
                        NativeAgentTeamMember(agent: agent, selected: currentAgentID == agent.id) { openAgent(agent.id) }
                    }
                    if model.agents.isEmpty { Text("Your agents will appear here.").junoType(.caption).foregroundStyle(Color.junoSecondaryInk).padding(JunoSpace.cozy) }
                }
            }
            HStack(spacing: JunoSpace.snug) {
                Circle().fill(model.needsYouCount > 0 ? Color.junoAccent : Color.junoSecondaryInk).frame(width: 5, height: 5)
                Text(model.needsYouCount > 0 ? "\(model.needsYouCount) need your input" : "No pending input").junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
            }.padding(.top, JunoSpace.roomy)
        }.padding(.horizontal, JunoSpace.regular).padding(.top, JunoSpace.roomy).padding(.bottom, JunoSpace.regular)
            .background(Color.junoCanvas)
    }
}

private struct NativeAgentTeamMember: View {
    let agent: NativeAgent
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.cozy) {
                JunoAgentFace(avatar: agent.avatar, state: agent.state, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.name).junoType(JunoType.ui.weight(.medium)).lineLimit(1)
                    Text(agent.state.label).junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                }
                Spacer(minLength: 0)
                if agent.needsYou > 0 { Text("\(agent.needsYou)").junoType(.caption).monospacedDigit() }
            }.padding(JunoSpace.cozy).frame(maxWidth: .infinity, alignment: .leading)
                .background(selected || hovering ? Color.junoHover : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).onHover { hovering = $0 }.accessibilityLabel("\(agent.name), \(agent.state.label)")
    }
}

private struct NativeAgentWorkspaceToolbar: View {
    let title: String
    let detail: String
    var body: some View {
        HStack(spacing: JunoSpace.regular) {
            Text(title).junoType(JunoType.ui.weight(.medium))
            Text(detail).junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
            Spacer()
        }.padding(.horizontal, JunoSpace.roomy).padding(.vertical, JunoSpace.regular)
    }
}

private struct NativeAgentStartView: View {
    let model: NativeAgentsModel
    let templateID: String?
    let onCancel: () -> Void
    let onHired: (NativeAgent) -> Void
    @State private var prompt = ""
    @State private var selected = "custom"
    @State private var busy = false
    @State private var failure: String?
    @State private var requestKey: String?
    @State private var requestText = ""
    @State private var requestTemplate = ""
    @FocusState private var composing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NativeAgentWorkspaceFrame(model: model, openAgent: { id in if let agent = model.agent(id: id) { onHired(agent) } }, createAgent: { composing = true }) {
            VStack(spacing: 0) {
                NativeAgentWorkspaceToolbar(title: "Create agent", detail: "Configure through conversation")
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                            Text("Give your agent a job.").junoType(JunoType.title.weight(.medium))
                            Text("Tell it what to handle and what a good result looks like. It’ll save its brief and work out the details with you.")
                                .junoType(.body).foregroundStyle(Color.junoSecondaryInk)
                        }
                        VStack(alignment: .leading, spacing: JunoSpace.regular) {
                            Text("Your first message").junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                            ZStack(alignment: .topLeading) {
                                if prompt.isEmpty {
                                    Text("For example: review my inbox each morning, flag urgent messages, and draft replies for my approval.")
                                        .junoType(.body).foregroundStyle(Color.junoSecondaryInk).padding(.top, 8).allowsHitTesting(false)
                                }
                                TextEditor(text: $prompt).scrollContentBackground(.hidden).junoType(.body)
                                    .frame(minHeight: 100, maxHeight: 160).focused($composing).disabled(busy).accessibilityLabel("Your agent’s job")
                            }
                            HStack {
                                Text(busy ? "Starting your conversation…" : "⌘ Enter to send").junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                                Spacer()
                                Button(busy ? "Starting…" : "Create & start", action: start)
                                    .buttonStyle(.junoProminent).disabled(busy || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.count > NativeAgentLimits.instructions)
                                    .keyboardShortcut(.return, modifiers: .command).accessibilityIdentifier("juno.agents.start.submit")
                            }
                        }.padding(JunoSpace.roomy).background(Color.junoRaised, in: RoundedRectangle(cornerRadius: 12))
                        if let failure { Text(failure).junoType(.ui).foregroundStyle(Color.junoDestructiveInk) }
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            Text("Try a request").junoType(.ui).foregroundStyle(Color.junoSecondaryInk)
                            ForEach(NativeAgentTemplate.all.filter { ["chief-of-staff", "researcher", "monitor"].contains($0.id) }) { template in
                                Button {
                                    selected = template.id; prompt = template.firstGoal.isEmpty ? template.promise : template.firstGoal; composing = true
                                } label: {
                                    HStack { Text(template.firstGoal.isEmpty ? template.promise : template.firstGoal).junoType(.ui); Spacer(); JunoIconView(.chevronRight, size: 14) }
                                        .padding(.vertical, JunoSpace.cozy).frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.plain).disabled(busy)
                            }
                        }
                        Divider()
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            Text("Your permissions stay in control.").junoType(JunoType.caption.weight(.medium))
                            Text("Connected apps require access. Sending, publishing, paying, and deleting require your approval.")
                                .junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                        }
                    }.frame(maxWidth: 600).padding(JunoSpace.roomy).padding(.top, JunoSpace.roomy).frame(maxWidth: .infinity)
                }
            }.onAppear { selected = templateID ?? "custom" }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: busy)
        }
    }

    private func start() {
        let message = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !message.isEmpty, message.count <= NativeAgentLimits.instructions,
              let template = NativeAgentTemplate.named(selected) else { return }
        if requestKey == nil || requestText != message || requestTemplate != selected {
            requestKey = UUID().uuidString
            requestText = message
            requestTemplate = selected
        }
        busy = true
        failure = nil
        var draft = NativeAgentDraft.conversationStarter(template)
        draft.creationKey = requestKey
        draft.starterMessage = message
        Task {
            if let agent = await model.hire(draft) { onHired(agent) }
            else { failure = model.lastErrorDescription ?? "Couldn’t start your agent. Your request is still here; try again." }
            busy = false
        }
    }
}

#endif

/// The roster itself: a page head, then either the tiles or — on a first visit
/// — the starting points, each a press away from a pre-filled hire. Muse's
/// lesson was that a blank canvas is the wrong first screen for an agent.
struct NativeAgentRoster: View {
    let model: NativeAgentsModel
    let open: (String) -> Void
    let hire: (NativeAgentTemplate) -> Void
    /// "Or start from scratch", and the header's New agent. Nil falls back
    /// to hiring from the custom and the first starting points.
    var hireFromScratch: (() -> Void)? = nil
    var newAgent: (() -> Void)? = nil

    #if os(macOS)
    @Environment(\.junoPageLayout) private var layout
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dealt = false
    @State private var query = ""
    @State private var filter = "all"
    #endif

    var body: some View {
        #if os(macOS)
        NativeAgentWorkspaceFrame(model: model, openAgent: open, createAgent: startNew) {
            VStack(spacing: 0) {
                NativeAgentWorkspaceToolbar(title: "Overview", detail: model.needsYouCount > 0 ? "\(model.needsYouCount) need your input" : "Your team’s current work")
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: JunoSpace.roomy) { macContent }
                        .padding(JunoSpace.roomy).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        // A failure while the roster is showing is a standing condition in
        // the window's toast host, rather than a box in the page: posted when
        // it changes, taken down when a later read succeeds.
        .junoToastStatus(
            id: "agents.roster.error",
            model.agents.isEmpty ? nil : model.lastErrorDescription
        ) { .error($0) }
        .accessibilityIdentifier("juno.agents.roster")
        #else
        NativeAgentsScroll(maxWidth: JunoReadingMeasure.wide) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                if let error = model.lastErrorDescription {
                    NativeAgentsProblem(message: error, dismiss: { model.clearError() })
                }
                if model.agents.isEmpty {
                    firstHire
                } else {
                    tiles
                }
            }
        }
        .accessibilityIdentifier("juno.agents.roster")
        #endif
    }

    private func startNew() {
        if let newAgent {
            newAgent()
        } else {
            hire(NativeAgentTemplate.all[0])
        }
    }

    private func startFromScratch() {
        if let hireFromScratch {
            hireFromScratch()
        } else if let custom = NativeAgentTemplate.named("custom") {
            hire(custom)
        }
    }

    #if os(macOS)
    // MARK: The Mac's page

    @ViewBuilder
    private var macContent: some View {
        if model.agents.isEmpty, model.phase == .idle || model.phase == .loading {
            skeletonCards
        } else if model.agents.isEmpty, model.phase == .failed || model.phase == .offline {
            JunoEmptyState(
                title: "Couldn’t load your agents",
                message: model.lastErrorDescription ?? "Juno could not reach your agents.",
                icon: .agents,
                actionLabel: "Try again",
                action: { Task { await model.refresh() } },
                tone: .error
            )
        } else if model.agents.isEmpty {
            macFirstHire
        } else {
            HStack(spacing: JunoSpace.roomy) {
                Picker("Filter agents", selection: $filter) {
                    Text("Everyone").tag("all")
                    Text("Needs you").tag("attention")
                    Text("Working").tag("active")
                }.pickerStyle(.segmented).frame(maxWidth: 360)
                Spacer()
                TextField("Find a teammate", text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                    .accessibilityLabel("Find a teammate")
            }
            if visibleAgents.isEmpty {
                Text(query.isEmpty ? "No agents in this view." : "No teammates match that search.")
                    .junoType(.ui).foregroundStyle(Color.junoSecondaryInk).padding(.vertical, JunoSpace.roomy)
            }
            VStack(spacing: JunoSpace.snug) {
                ForEach(visibleAgents) { agent in
                    NativeAgentRosterCard(agent: agent) { open(agent.id) }
                    Divider()
                }
            }

        }
    }

    private var visibleAgents: [NativeAgent] {
        model.orderedAgents.filter { agent in
            let matches = query.isEmpty || "\(agent.name) \(agent.role)".localizedCaseInsensitiveContains(query)
            return matches && (filter == "all" || (filter == "attention" ? agent.needsYou > 0 || agent.state == .waiting || agent.state == .blocked : agent.state == .working || agent.state == .thinking))
        }
    }

    /// One column below 576pt of page, two to 896, three above: the web's
    /// `sm:grid-cols-2 lg:grid-cols-3`, stepped on the page's own width.
    private var gridColumns: [GridItem] {
        let width = layout?.columnWidth ?? 900
        let count = width >= 896 ? 3 : width >= 576 ? 2 : 1
        return Array(
            repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top),
            count: count
        )
    }

    /// Cards shaped like the roster's — a face and three lines — breathing
    /// while the roster is read.
    private var skeletonCards: some View {
        LazyVGrid(columns: gridColumns, alignment: .leading, spacing: JunoSpace.cozy) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(alignment: .top, spacing: JunoSpace.regular) {
                    JunoSkeleton(height: JunoAgentFaceSize.md, width: JunoAgentFaceSize.md, cornerRadius: JunoAgentFaceSize.md / 2)
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        JunoSkeleton(height: 14, width: 96)
                        JunoSkeleton(height: 12, width: 140)
                        JunoSkeleton(height: 12, width: 180)
                    }
                    .padding(.top, JunoSpace.micro)
                    Spacer(minLength: 0)
                }
                .padding(JunoSpace.regular)
                .junoCard(cornerRadius: JunoRadius.card)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading agents")
    }

    /// "Hire your first agent": four starting faces overlapping, the title,
    /// the promise, the starting points and — for anyone who wants none of
    /// them — a way to start from scratch.
    private var macFirstHire: some View {
        let templates = NativeAgentTemplate.all.filter { $0.id != "custom" }
        return VStack(alignment: .leading, spacing: JunoSpace.section) {
            VStack(spacing: JunoSpace.cozy) {
                HStack(spacing: -JunoSpace.cozy) {
                    ForEach(0..<min(4, templates.count), id: \.self) { index in
                        JunoAgentFace(
                            avatar: templates[index].avatar,
                            state: index == 1 ? .working : .idle,
                            size: JunoAgentFaceSize.md
                        )
                    }
                }
                .accessibilityHidden(true)
                Text("Make room for a teammate.")
                    .junoType(.title)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Describe the job. Build its way of working together in conversation.")
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 480)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)

            LazyVGrid(columns: gridColumns, alignment: .leading, spacing: JunoSpace.cozy) {
                ForEach(templates) { template in
                    NativeAgentTemplateCard(template: template) { hire(template) }
                }
            }

            HStack(spacing: 0) {
                Text("Or ")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                Button(action: startFromScratch) {
                    Text("start from scratch")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoAccentInk)
                        .underline()
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Hire an agent with a blank brief")
                Text(".")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .frame(maxWidth: .infinity)
        }
    }
    #endif

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                #if os(macOS)
                Text("Agents")
                    .junoPageHeading()
                    .accessibilityAddTraits(.isHeader)
                #else
                Text("Agents")
                    .junoPageHeading(compact: true)
                    .accessibilityAddTraits(.isHeader)
                #endif
                Text("Teammates that take on work, keep going when you leave, and come back only when they need you.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: JunoSpace.snug)
            if !model.agents.isEmpty {
                Button {
                    hire(NativeAgentTemplate.all[0])
                } label: {
                    Label("New agent", icon: .plus)
                }
                .buttonStyle(.bordered)
                .nativeAgentNeutralTint()
                .frame(minHeight: 44)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.agents.new")
            }
        }
    }

    private var tiles: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 280), spacing: JunoSpace.cozy, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.cozy
        ) {
            ForEach(model.orderedAgents) { agent in
                Button {
                    open(agent.id)
                } label: {
                    NativeAgentRosterTile(agent: agent)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
            }
        }
    }

    private var firstHire: some View {
        let templates = NativeAgentTemplate.all.filter { $0.id != "custom" }
        return VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(spacing: JunoSpace.snug) {
                HStack(spacing: -JunoSpace.cozy) {
                    ForEach(0..<min(4, templates.count), id: \.self) { index in
                        JunoAgentFace(
                            avatar: templates[index].avatar,
                            state: index == 1 ? .working : .idle,
                            size: JunoAgentFaceSize.md
                        )
                    }
                }
                .accessibilityHidden(true)
                Text("Make room for a teammate.")
                    .junoEmptyTitle()
                    .junoInk()
                    .accessibilityAddTraits(.isHeader)
                Text("Describe the job. Build its way of working together in conversation.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 260), spacing: JunoSpace.cozy, alignment: .top)],
                alignment: .leading,
                spacing: JunoSpace.cozy
            ) {
                ForEach(templates) { template in
                    Button {
                        hire(template)
                    } label: {
                        NativeAgentTemplateTile(template: template, selected: false)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.junoPress)
                }
            }

            Button {
                if let custom = NativeAgentTemplate.named("custom") { hire(custom) }
            } label: {
                Text("Or start from scratch")
                    .font(.callout)
                    .junoInk()
                    .underline()
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
        }
    }
}

/// One agent on the roster: face, name, role and the state sentence. The dot
/// is there only while it needs you.
struct NativeAgentRosterTile: View {
    let agent: NativeAgent

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var waiting: Bool { agent.state == .waiting }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.regular) {
            JunoAgentFace(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.md)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.snug) {
                    Text(agent.name)
                        .font(.body.weight(.medium))
                        .junoInk()
                        .lineLimit(1)
                    if waiting {
                        NativeAgentNeedsYouDot()
                    }
                }
                if !agent.role.isEmpty {
                    Text(agent.role)
                        .font(.callout)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }
                Text(sentence)
                    .font(.callout)
                    .foregroundStyle(waiting ? Color.junoForeground : Color.junoMutedForeground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.top, JunoSpace.hairline)
            }
            Spacer(minLength: 0)
        }
        .nativeAgentTile(padding: JunoSpace.regular)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence)"))
        .accessibilityAddTraits(.isButton)
    }
}

/// A starting point: its face, its name and its one-line promise.
struct NativeAgentTemplateTile: View {
    let template: NativeAgentTemplate
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoAgentFace(avatar: template.avatar, size: JunoAgentFaceSize.sm)
            VStack(alignment: .leading, spacing: 2) {
                Text(template.label)
                    .font(.callout.weight(.medium))
                    .junoInk()
                Text(template.promise)
                    .font(.callout)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .nativeAgentTile(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

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

#if os(macOS)
/// One agent on the Mac's roster (`AgentCard`): an opaque card with the 48pt
/// face, the name, the role and the state sentence, a tonal fill under the
/// pointer. Nothing lifts. The dot is there only while it needs you.
struct NativeAgentRosterCard: View {
    let agent: NativeAgent
    let open: () -> Void

    @State private var isHovering = false

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var waiting: Bool { agent.state == .waiting }

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                JunoAgentFace(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.md)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    HStack(spacing: JunoSpace.snug) {
                        Text(agent.name)
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                        if waiting {
                            NativeAgentNeedsYouDot()
                        }
                    }
                    if !agent.role.isEmpty {
                        Text(agent.role)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                    }
                    Text(sentence)
                        .junoType(.ui)
                        .foregroundStyle(waiting ? Color.junoForeground : Color.junoSecondaryInk)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.tight)
                }
                .padding(.top, JunoSpace.micro)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.roomy)
            // Every card in a row as tall as the tallest, so the grid reads
            // as rows rather than as a ragged edge.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.junoRaised)
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence)"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("juno.agents.card.\(agent.id)")
    }
}

/// A starting point on the first-hire page: its face, its label, its promise.
struct NativeAgentTemplateCard: View {
    let template: NativeAgentTemplate
    let hire: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: hire) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoAgentFace(avatar: template.avatar, size: JunoAgentFaceSize.sm)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(template.label)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    Text(template.promise)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(JunoSpace.comfy)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}
#endif
