import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The five tabs of an agent's page (AGENTS.md §5.2).
enum NativeAgentTab: String, CaseIterable, Identifiable {
    case now, goals, routines, activity, profile

    var id: String { rawValue }

    var label: String {
        switch self {
        case .now: "Now"
        case .goals: "Goals"
        case .routines: "Routines"
        case .activity: "Activity"
        case .profile: "Profile"
        }
    }
}

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

/// One agent's page: the face at size with its live state, the name, the role
/// and the state sentence; **Message** as the one primary action with Pause or
/// Resume beside it; then Now, Goals, Routines, Activity and Profile.
///
/// The page answers "what is it doing, and does it need me?" first. What
/// needs the person is answered on the Now tab, on the same approval and
/// question its thread shows — read from the task's run and sent through the
/// same routes, digest and all — so there is one gate, drawn in two places.
/// Without a Work client the tab says where to answer instead.
struct NativeAgentPage: View {
    let model: NativeAgentsModel
    let agentID: String
    let apps: [NativeAgentAppChoice]
    let openConversation: (String) -> Void
    /// The page's own way back, on the Mac where it replaces the roster in
    /// place. Nil in a navigation stack, whose back button already says it.
    var back: (() -> Void)?
    /// Approvals raised by a run executing on this Mac, by run id. They have
    /// no server row, so only the Mac holding the run can show them.
    var localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    /// Answers one of those, through the coordinator holding the run.
    var decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    /// Just hired: the page opens with a word of welcome, once.
    var welcome = false
    var dismissWelcome: (() -> Void)?
    /// The missing-agent state's way back to the roster ("All agents").
    var allAgents: (() -> Void)?

    @State private var tab: NativeAgentTab = .now
    @State private var costQuestion: NativeAgentCostQuestion?
    @State private var confirmingRetire = false
    /// The first moments after a hire, when the face arrives at its larger
    /// size before it settles (the web's landing → greeting → settling).
    @State private var arriving = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    #if os(macOS)
    @Environment(\.junoToast) private var toast
    #endif

    private var retireTitle: String {
        #if os(macOS)
        "Retire \(model.agent(id: agentID)?.name ?? "this agent")?"
        #else
        "Delete \(model.agent(id: agentID)?.name ?? "this agent")?"
        #endif
    }

    var body: some View {
        Group {
            if let agent = model.agent(id: agentID) {
                page(agent)
            } else if model.loadingDetailID == agentID {
                #if os(macOS)
                JunoPage(measure: .wide) {
                    HStack(spacing: JunoSpace.roomy) {
                        JunoSkeleton(height: JunoAgentFaceSize.lg, width: JunoAgentFaceSize.lg, cornerRadius: JunoAgentFaceSize.lg / 2)
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            JunoSkeleton(height: 28, width: 220)
                            JunoSkeleton(height: 14, width: 160)
                            JunoSkeleton(height: 14, width: 280)
                        }
                    }
                    .padding(.bottom, JunoSpace.section)
                } content: {
                    VStack(spacing: JunoSpace.cozy) {
                        ForEach(0..<3, id: \.self) { _ in
                            JunoSkeleton(height: 72, cornerRadius: JunoRadius.card)
                        }
                    }
                }
                .accessibilityLabel("Loading agent")
                #else
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Loading agent")
                #endif
            } else {
                #if os(macOS)
                JunoPage(measure: .wide) {
                    EmptyView()
                } content: {
                    JunoEmptyState(
                        title: "This agent is no longer here",
                        message: "It may have been retired. Its thread and tasks are still in your chats.",
                        icon: .agents,
                        actionLabel: "All agents",
                        action: { if let allAgents { allAgents() } else { dismiss() } }
                    )
                }
                #else
                NativeAgentsNotice(
                    title: "This agent is no longer here",
                    message: model.lastErrorDescription ?? "It may have been retired on another device.",
                    icon: .agents,
                    actionLabel: back == nil ? nil : "Back to agents",
                    action: back
                )
                #endif
            }
        }
        #if os(iOS)
        .navigationTitle(model.agent(id: agentID)?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        #endif
        // The page's lazy reflection rides on opening it: the server makes it
        // a no-op until six hours have passed, so an opened page never costs
        // more than one.
        .task(id: agentID) {
            await reload()
            await model.reflect(agentID: agentID, force: false)
        }
        // Seen once: leaving the page is enough of an answer to the welcome.
        .onDisappear { dismissWelcome?() }
        .confirmationDialog(
            "Start it?",
            isPresented: Binding(
                get: { costQuestion != nil },
                set: { if !$0 { costQuestion = nil } }
            ),
            titleVisibility: .visible,
            presenting: costQuestion
        ) { question in
            Button("Start") { confirm(question) }
                .contentShape(.rect)
            Button("Cancel", role: .cancel) { costQuestion = nil }
                .contentShape(.rect)
        } message: { question in
            Text(question.message)
        }
        .confirmationDialog(
            retireTitle,
            isPresented: $confirmingRetire,
            titleVisibility: .visible
        ) {
            #if os(macOS)
            Button("Retire", role: .destructive) { retire() }
                .contentShape(.rect)
            Button("Keep It", role: .cancel) {}
                .contentShape(.rect)
            #else
            Button("Delete agent", role: .destructive) { retire() }
                .contentShape(.rect)
            Button("Cancel", role: .cancel) {}
                .contentShape(.rect)
            #endif
        } message: {
            #if os(macOS)
            Text("Its routines stop and it leaves the roster. Its thread and its tasks are kept. This cannot be undone.")
            #else
            Text("Its routines stop. Its thread and its tasks stay, as ordinary chats and tasks.")
            #endif
        }
        #if os(macOS)
        // A standing condition in the window's toast host rather than a box
        // in the page (Phase 4 §2.8): posted when it changes, taken down when
        // a later request succeeds.
        .junoToastStatus(id: "agents.page.error", model.lastErrorDescription) { .error($0) }
        #endif
        .accessibilityIdentifier("juno.agents.page")
    }

    #if os(macOS)
    /// The Mac's page (Phase 4 C3): a wide page whose header is the agent —
    /// the face, the name on the title rung, the role, its state in words and
    /// the sentence — with Message as the one prominent action; then the
    /// welcome, once; then the five tabs.
    private func page(_ agent: NativeAgent) -> some View {
        JunoPage(measure: .wide) {
            NativeAgentPageHeader(
                agent: agent,
                arriving: arriving,
                message: { message(agent) },
                togglePause: { togglePause(agent) },
                thinkItOver: { thinkItOver(agent) },
                editProfile: { tab = .profile },
                retire: { confirmingRetire = true },
                isMutating: model.isMutating
            )
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                if welcome {
                    NativeAgentWelcome(
                        agent: agent,
                        message: {
                            dismissWelcome?()
                            message(agent)
                        },
                        later: { dismissWelcome?() }
                    )
                    .transition(.opacity)
                }
                JunoSegmented(
                    options: tabOptions(agent),
                    selection: $tab,
                    accessibilityLabel: "\(agent.name)’s page"
                )
                .fixedSize()
                tabContent(agent)
            }
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
                value: welcome
            )
        }
        .onChange(of: tab) { _, _ in model.clearMutationMessage() }
        .onAppear {
            guard welcome, !reduceMotion else { return }
            arriving = true
        }
        .task(id: welcome) {
            guard arriving else { return }
            try? await Task.sleep(for: .milliseconds(1_600))
            withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) { arriving = false }
        }
    }

    /// Now carries the count of what needs the person as its badge; Goals
    /// and Routines their counts, as the web's control does.
    private func tabOptions(_ agent: NativeAgent) -> [JunoSegmented<NativeAgentTab>.Option] {
        let detail = model.details[agentID]
        let goals = detail?.goals.filter { $0.status == .active }.count ?? 0
        let routines = detail?.routines.count ?? 0
        return [
            .init(.now, "Now", badge: agent.needsYou > 0 ? agent.needsYou : nil),
            .init(.goals, "Goals", count: goals > 0 ? goals : nil),
            .init(.routines, "Routines", count: routines > 0 ? routines : nil),
            .init(.activity, "Activity"),
            .init(.profile, "Profile"),
        ]
    }

    /// "Think it over now": the person asking, answered in the web's words.
    private func thinkItOver(_ agent: NativeAgent) {
        Task {
            guard let outcome = await model.reflect(agentID: agent.id, force: true) else { return }
            model.clearMutationMessage()
            switch outcome {
            case .reflected(let ideas, _, _):
                toast(.success(
                    ideas > 0
                        ? "\(agent.name) has \(ideas) new \(ideas == 1 ? "idea" : "ideas")."
                        : "\(agent.name) looked things over. Nothing new to suggest."
                ))
            case .skipped(let reason):
                toast(JunoToast(
                    id: "agent-reflect",
                    tone: nil,
                    title: reason == "paused"
                        ? "\(agent.name) is paused."
                        : reason == "no_answer"
                            ? "It could not think that over just now. Try again in a moment."
                            : "It thought things over a moment ago."
                ))
            }
        }
    }
    #else
    private func page(_ agent: NativeAgent) -> some View {
        NativeAgentsScroll(maxWidth: JunoReadingMeasure.reading) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                NativeAgentHeader(
                    agent: agent,
                    back: back,
                    message: { message(agent) },
                    togglePause: { togglePause(agent) },
                    editProfile: { tab = .profile },
                    delete: { confirmingRetire = true },
                    isMutating: model.isMutating
                )
                if let error = model.lastErrorDescription {
                    NativeAgentsProblem(message: error, dismiss: { model.clearError() })
                } else if let note = model.lastMutationExplanation {
                    Text(note)
                        .junoCaption()
                        .transition(.opacity)
                }
                if welcome {
                    NativeAgentWelcome(
                        agent: agent,
                        message: {
                            dismissWelcome?()
                            message(agent)
                        },
                        later: { dismissWelcome?() }
                    )
                    .transition(.opacity)
                }
                Picker("Section", selection: $tab) {
                    ForEach(NativeAgentTab.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                tabContent(agent)
            }
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
                value: model.lastMutationExplanation
            )
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
                value: welcome
            )
        }
        .onChange(of: tab) { _, _ in model.clearMutationMessage() }
    }
    #endif

    @ViewBuilder
    private func tabContent(_ agent: NativeAgent) -> some View {
        let detail = model.details[agentID]
        switch tab {
        case .now:
            NativeAgentNowTab(
                model: model,
                agent: agent,
                detail: detail,
                localApprovals: localApprovals,
                decideLocally: decideLocally,
                openTask: openTask,
                startIdea: { idea in startIdea(idea, confirm: false) },
                dismissIdea: dismissIdea
            )
        case .goals:
            NativeAgentGoalsTab(
                model: model,
                agent: agent,
                goals: detail?.goals ?? [],
                workOn: workOn
            )
        case .routines:
            NativeAgentRoutinesTab(
                model: model,
                agent: agent,
                routines: detail?.routines ?? []
            )
        case .activity:
            NativeAgentActivityTab(
                model: model,
                agentID: agent.id,
                entries: model.activity[agent.id] ?? [],
                tasks: model.tasks(for: agent.id),
                openTask: openTask
            )
        case .profile:
            NativeAgentProfileTab(
                model: model,
                agent: agent,
                notes: detail?.notes ?? [],
                apps: apps,
                delete: { confirmingRetire = true }
            )
            .id(agent.id)
        }
    }

    // MARK: Actions

    private func reload() async {
        await model.loadDetail(id: agentID)
        await model.loadActivity(id: agentID)
    }

    /// Message opens the agent's thread — created on first use — in the app's
    /// own chat.
    private func message(_ agent: NativeAgent) {
        Task {
            guard let conversationID = await model.threadConversationID(for: agent.id) else { return }
            openConversation(conversationID)
        }
    }

    /// A task's own thread when it has one, the agent's otherwise: tasks the
    /// agent starts run in its thread, so the two are usually the same.
    private func openTask(_ task: NativeAgentTask) {
        if let conversationID = task.conversationID {
            openConversation(conversationID)
        } else if let agent = model.agent(id: agentID) {
            message(agent)
        }
    }

    private func togglePause(_ agent: NativeAgent) {
        let pausing = !agent.isPaused
        Task {
            await model.setPaused(id: agent.id, paused: pausing)
            #if os(macOS)
            // The model says "Paused." or "Resumed." when it worked; the
            // page says it the web's way instead.
            guard model.lastMutationExplanation != nil else { return }
            model.clearMutationMessage()
            toast(.success(
                pausing
                    ? "\(agent.name) is paused. Its routines are off until you resume it."
                    : "\(agent.name) is back."
            ))
            #endif
        }
    }

    private func startIdea(_ idea: NativeAgentIdea, confirm: Bool) {
        Task {
            let outcome = await model.decideIdea(
                agentID: agentID,
                ideaID: idea.id,
                action: .start,
                confirmExpensive: confirm
            )
            if case .needsConfirmation(_, let message)? = outcome {
                costQuestion = NativeAgentCostQuestion(message: message, retry: .idea(idea.id))
            }
        }
    }

    private func dismissIdea(_ idea: NativeAgentIdea) {
        Task {
            _ = await model.decideIdea(agentID: agentID, ideaID: idea.id, action: .dismiss)
        }
    }

    /// A goal's "Work on this": the goal becomes a task in the agent's thread,
    /// and the thread opens so the person watches it start.
    private func workOn(_ goal: NativeAgentGoal) {
        let brief = goal.detail.isEmpty ? goal.title : "\(goal.title)\n\n\(goal.detail)"
        startTask(title: goal.title, goal: brief, confirm: false)
    }

    private func startTask(title: String, goal: String, confirm: Bool) {
        Task {
            let outcome = await model.startTask(
                agentID: agentID,
                title: title,
                goal: goal,
                confirmExpensive: confirm
            )
            switch outcome {
            case .needsConfirmation(_, let message)?:
                costQuestion = NativeAgentCostQuestion(
                    message: message,
                    retry: .task(title: title, goal: goal)
                )
            case .accepted(_, let threadID)?:
                if let conversationID = threadID { openConversation(conversationID) }
            case nil:
                break
            }
        }
    }

    private func confirm(_ question: NativeAgentCostQuestion) {
        costQuestion = nil
        switch question.retry {
        case .idea(let ideaID):
            Task {
                _ = await model.decideIdea(
                    agentID: agentID,
                    ideaID: ideaID,
                    action: .start,
                    confirmExpensive: true
                )
            }
        case .task(let title, let goal):
            startTask(title: title, goal: goal, confirm: true)
        }
    }

    private func retire() {
        #if os(macOS)
        let name = model.agent(id: agentID)?.name ?? "The agent"
        #endif
        Task {
            guard await model.retire(id: agentID) else { return }
            #if os(macOS)
            model.clearMutationMessage()
            toast(.success("\(name) was retired. Its thread and its tasks are kept."))
            #endif
            // Back to the roster: on the Mac by the page's own control, in a
            // navigation stack by popping this page.
            if let back {
                back()
            } else {
                dismiss()
            }
        }
    }
}

// MARK: - Header

/// The face at size with its live state, the name, the role, the state
/// sentence, and the page's actions. Message is the one accent on the page.
struct NativeAgentHeader: View {
    let agent: NativeAgent
    let back: (() -> Void)?
    let message: () -> Void
    let togglePause: () -> Void
    let editProfile: () -> Void
    let delete: () -> Void
    let isMutating: Bool

    var body: some View {
        #if os(macOS)
        HStack(alignment: .top, spacing: JunoSpace.roomy) {
            if let back {
                Button(action: back) {
                    JunoIconView(.arrowLeft, size: 16)
                        .junoSecondaryInk()
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .keyboardShortcut("[", modifiers: .command)
                .help("Back to agents (⌘[)")
                .accessibilityLabel("Back to agents")
            }
            face
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                identity
                actions
            }
            Spacer(minLength: 0)
        }
        #else
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            face
            identity
            actions
        }
        #endif
    }

    private var face: some View {
        JunoAgentFace(
            avatar: agent.avatar,
            state: agent.state,
            size: JunoAgentFaceSize.lg,
            name: agent.name
        )
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            #if os(macOS)
            Text(agent.name)
                .junoPageHeading()
                .accessibilityAddTraits(.isHeader)
            #else
            Text(agent.name)
                .junoPageHeading(compact: true)
                .accessibilityAddTraits(.isHeader)
            #endif
            if !agent.role.isEmpty {
                Text(agent.role)
                    .font(.callout)
                    .junoSecondaryInk()
            }
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                if agent.state == .waiting {
                    NativeAgentNeedsYouDot()
                }
                Text(NativeAgentFormat.stateSentence(for: agent))
                    .font(.callout)
                    .foregroundStyle(agent.state == .waiting ? Color.junoForeground : Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, JunoSpace.hairline)
        }
    }

    private var actions: some View {
        HStack(spacing: JunoSpace.snug) {
            Button(action: message) {
                Label("Message", icon: .message)
            }
            // Opaque, in the Juno accent: glass is chrome, never content or a
            // sheet's body (MACOS_LIQUID_GLASS_REDESIGN.md §0.1).
            .buttonStyle(.junoProminent)
            .frame(minHeight: 44)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.agents.message")

            Button(agent.isPaused ? "Resume" : "Pause", action: togglePause)
                .buttonStyle(.bordered)
                .nativeAgentNeutralTint()
                .disabled(isMutating)
                .frame(minHeight: 44)
                .contentShape(.rect)

            Menu {
                Button("Edit profile", action: editProfile)
                Button("Delete agent…", role: .destructive, action: delete)
            } label: {
                JunoIconView(.ellipsis, size: 16)
            }
            .menuStyle(.button)
            .buttonStyle(.bordered)
            .nativeAgentNeutralTint()
            .menuIndicator(.hidden)
            .fixedSize()
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
            .accessibilityLabel("More")
        }
    }
}

#if os(macOS)
/// The Mac's agent header, in the page template's place: the face (the
/// page's one piece of character, main's faces unchanged), the name on the
/// title rung, the role, and the state in words · the sentence; then Message
/// (the one prominent action), Pause or Resume, and More. The rule under it
/// is the template's.
struct NativeAgentPageHeader: View {
    let agent: NativeAgent
    let arriving: Bool
    let message: () -> Void
    let togglePause: () -> Void
    let thinkItOver: () -> Void
    let editProfile: () -> Void
    let retire: () -> Void
    let isMutating: Bool

    @Environment(\.junoPageLayout) private var layout

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: JunoSpace.roomy) {
                    face
                    identity
                    Spacer(minLength: JunoSpace.section)
                    actions
                }
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    HStack(alignment: .center, spacing: JunoSpace.roomy) {
                        face
                        identity
                    }
                    actions
                }
            }
            .padding(.bottom, JunoSpace.roomy)
            Rectangle()
                .fill(Color.junoBorder)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .padding(.bottom, JunoSpace.section)
    }

    private var face: some View {
        JunoAgentFace(
            avatar: agent.avatar,
            state: agent.state,
            size: arriving ? JunoAgentFaceSize.xl : JunoAgentFaceSize.lg,
            name: agent.name
        )
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(agent.name)
                .junoPageTitle(columnWidth: layout?.columnWidth)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if !agent.role.isEmpty {
                Text(agent.role)
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                if agent.state == .waiting {
                    NativeAgentNeedsYouDot()
                }
                Text(agent.state.label)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                Text("·")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                Text(NativeAgentFormat.stateSentence(for: agent))
                    .junoType(.ui)
                    .foregroundStyle(agent.state == .waiting ? Color.junoForeground : Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, JunoSpace.hairline)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var actions: some View {
        HStack(spacing: JunoSpace.close) {
            Button(action: message) {
                Label("Message", icon: .message)
            }
            .buttonStyle(.junoProminent)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.agents.message")

            Button(agent.isPaused ? "Resume" : "Pause", action: togglePause)
                .buttonStyle(.bordered)
                .tint(nil)
                .disabled(isMutating)
                .contentShape(.rect)

            Menu {
                Button("Think It Over Now", action: thinkItOver)
                    .disabled(agent.status != .active)
                Button("Edit Profile", action: editProfile)
                Divider()
                Button("Retire…", role: .destructive, action: retire)
            } label: {
                JunoIconView(.more, size: 16)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More")
            .accessibilityLabel("More for \(agent.name)")
        }
        .fixedSize()
    }
}
#endif

// MARK: - Now

/// Now: the block that needs you first — each waiting task with the approvals
/// and the question it is stopped at, answerable here — then the task it is
/// doing, what its computer did, its ideas, and what is coming up.
struct NativeAgentNowTab: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let detail: NativeAgentDetail?
    let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    let openTask: (NativeAgentTask) -> Void
    let startIdea: (NativeAgentIdea) -> Void
    let dismissIdea: (NativeAgentIdea) -> Void

    private var tasks: [NativeAgentTask] {
        if let detail, !detail.tasks.isEmpty { return detail.tasks }
        return agent.task.map { [$0] } ?? []
    }

    private var waiting: [NativeAgentTask] {
        tasks.filter(NativeAgentGate.isWaiting)
    }

    /// Whether what this tab shows can change faster than the roster's minute:
    /// something is waiting on the person, or its newest task is still going
    /// and may stop to ask at any moment.
    private var follows: Bool {
        guard model.canAnswerInPlace else { return false }
        if !waiting.isEmpty || agent.needsYou > 0 { return true }
        guard let status = tasks.first?.status, let known = JunoWorkStatus(rawValue: status) else {
            return false
        }
        return !known.isTerminal && known != .draft
    }

    /// What the reading loop depends on. A change restarts it at once, so a
    /// task that has just started waiting is read now rather than a tick later.
    private var readKey: String {
        let waitingIDs = waiting.map(\.sessionID).joined(separator: ",")
        return "\(agent.id)|\(follows)|\(tasks.first?.sessionID ?? "")|\(waitingIDs)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            if !waiting.isEmpty || agent.needsYou > 0 {
                needsYou
            }
            latestTask
            computer
            ideas
            upcoming
        }
        .task(id: readKey) { await follow() }
    }

    /// Reads on arrival, then every ten seconds for as long as the tab is on
    /// screen and something here can move. Leaving the tab cancels it.
    private func follow() async {
        await readGates()
        guard follows else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            await readGates()
        }
    }

    /// Reads the gates, first catching the page up when the roster says the
    /// agent needs the person and the page's tasks do not say which: a task
    /// that started waiting after the page opened is not in its list yet.
    private func readGates() async {
        let agentID = agent.id
        let knowsWhich = model.tasks(for: agentID).contains(where: NativeAgentGate.isWaiting)
        let needsYou = model.agent(id: agentID)?.needsYou ?? 0
        if !knowsWhich, needsYou > 0 {
            await model.loadDetail(id: agentID)
        }
        await model.loadGates(agentID: agentID)
    }

    private func gate(for task: NativeAgentTask) -> NativeAgentGate? {
        model.gates[agent.id]?.first { $0.id == task.sessionID }
    }

    /// The approvals this task's run raised on this Mac. They win over the
    /// server's copy: the coordinator holding the run is the one waiting.
    private func approvalsOnThisMac(for task: NativeAgentTask) -> [WorkApprovalRequest] {
        guard let localApprovals, decideLocally != nil, let runID = gate(for: task)?.runID else {
            return []
        }
        return localApprovals(runID)
    }

    private func answersHere(_ task: NativeAgentTask) -> Bool {
        if !approvalsOnThisMac(for: task).isEmpty { return true }
        guard let gate = gate(for: task) else { return false }
        return !gate.isEmpty
    }

    private var needsYou: some View {
        let count = max(agent.needsYou, waiting.count)
        let answerable = waiting.contains { answersHere($0) }
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                NativeAgentNeedsYouDot()
                NativeAgentHeading(title: count == 1 ? "Needs you on one task" : "Needs you on \(count) tasks")
            }
            ForEach(waiting) { task in
                NativeAgentGateStack(
                    model: model,
                    agentID: agent.id,
                    task: task,
                    gate: gate(for: task),
                    approvalsOnThisMac: approvalsOnThisMac(for: task),
                    decideLocally: decideLocally,
                    open: { openTask(task) }
                )
            }
            Text(answerable
                ? "Answering here answers it in its thread too."
                : "Answer it in its thread, where the question and its approval card are.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var latestTask: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentHeading(title: agent.state == .working ? "Working on" : "Latest task")
            if let task = tasks.first {
                NativeAgentTaskLine(task: task, open: { openTask(task) })
            } else {
                Text("Nothing yet. Message it, or give it a goal to work on.")
                    .font(.callout)
                    .junoSecondaryInk()
            }
        }
    }

    /// Its computer: the calls its newest run made, in words (AGENTS.md
    /// §5.2). Shown only for the run the page is about, and only once it has
    /// done something.
    @ViewBuilder
    private var computer: some View {
        if let feed = model.computers[agent.id],
            feed.sessionID == tasks.first?.sessionID,
            !feed.lines.isEmpty
        {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    NativeAgentHeading(title: "Its computer")
                    Text(feed.isLive ? "Live" : "Last run")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(feed.lines) { line in
                        NativeAgentComputerLineView(line: line)
                    }
                }
            }
        }
    }

    private var ideas: some View {
        let list = detail?.ideas ?? []
        let reflecting = model.isReflecting(agent.id)
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                NativeAgentHeading(title: "Ideas")
                Spacer(minLength: JunoSpace.snug)
                if reflecting {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Thinking it over")
                }
                Button {
                    Task { await model.reflect(agentID: agent.id, force: true) }
                } label: {
                    Text("Think it over")
                        .font(.callout)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .disabled(reflecting || agent.isPaused)
            }
            if list.isEmpty {
                Text(agent.isPaused
                    ? "It is paused, so it is not suggesting anything."
                    : "No ideas right now. It suggests things from its goals and what it knows, at most every six hours.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(list) { idea in
                    NativeAgentIdeaTile(
                        idea: idea,
                        busy: model.isMutating,
                        start: { startIdea(idea) },
                        dismiss: { dismissIdea(idea) }
                    )
                }
            }
        }
    }

    private var upcoming: some View {
        let routines = (detail?.routines ?? [])
            .filter { $0.enabled && $0.nextRunAt != nil }
            .sorted { ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture) }
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentHeading(title: "Upcoming")
            if routines.isEmpty {
                if let next = agent.nextRoutine, let at = next.nextRunAt {
                    Text("\(next.name), \(NativeAgentFormat.upcoming(at))")
                        .font(.callout)
                        .junoInk()
                } else {
                    Text("Nothing scheduled. A routine has it work on a clock.")
                        .font(.callout)
                        .junoSecondaryInk()
                }
            } else {
                ForEach(routines.prefix(3)) { routine in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Text(routine.name)
                            .font(.callout)
                            .junoInk()
                            .lineLimit(1)
                        Spacer(minLength: JunoSpace.snug)
                        if let at = routine.nextRunAt {
                            Text(NativeAgentFormat.upcoming(at))
                                .junoCaption()
                        }
                    }
                }
            }
        }
    }
}

/// One task: its title, its state in words, when it last moved, and the way
/// into its thread.
struct NativeAgentTaskLine: View {
    let task: NativeAgentTask
    let open: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.callout.weight(.medium))
                    .junoInk()
                    .lineLimit(2)
                HStack(spacing: JunoSpace.hairline) {
                    Text(NativeAgentFormat.taskStatus(task.status))
                    if let at = task.lastActivityAt {
                        Text("·")
                        Text(NativeAgentFormat.ago(at))
                    }
                }
                .junoCaption()
            }
            Spacer(minLength: JunoSpace.snug)
            Button(action: open) {
                Text("Open in chat")
                    .font(.callout)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
        }
        .nativeAgentTile()
    }
}

/// One waiting task and what it is stopped at: its line, then its approvals,
/// oldest first, then its question. A task with nothing answerable here is
/// its line alone, and Open in chat is the way to the gate.
struct NativeAgentGateStack: View {
    let model: NativeAgentsModel
    let agentID: String
    let task: NativeAgentTask
    let gate: NativeAgentGate?
    /// Approvals raised by this task's run on this Mac. When there are any
    /// they are the ones shown, answered through `decideLocally`.
    let approvalsOnThisMac: [WorkApprovalRequest]
    let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentTaskLine(task: task, open: open)
            if !approvalsOnThisMac.isEmpty {
                ForEach(approvalsOnThisMac) { approval in
                    NativeWorkApprovalCard(approval: approval) { decision in
                        decideLocally?(approval, decision)
                    }
                }
            } else if let gate {
                ForEach(gate.approvals) { approval in
                    NativeWorkApprovalCard(
                        approval: approval,
                        busy: model.isAnswering(approval.approvalID)
                    ) { decision in
                        decide(approval, decision)
                    }
                }
            }
            if let question = gate?.question {
                NativeWorkQuestionCard(
                    question: question,
                    busy: model.isAnswering(question.questionID)
                ) { reply in
                    await model.answer(
                        agentID: agentID,
                        sessionID: task.sessionID,
                        question: question,
                        text: reply
                    )
                }
                // A new question is a new card, with an empty box.
                .id(question.questionID)
            }
        }
    }

    private func decide(_ approval: WorkApprovalRequest, _ decision: JunoWorkApprovalDecision) {
        Task { await model.decide(agentID: agentID, approval, decision) }
    }
}

/// One call its run made: a toned dot, what it did in words, and one trailing
/// signal — when it happened, or the word for a call that did not simply
/// finish.
struct NativeAgentComputerLineView: View {
    let line: NativeAgentComputerLine

    private var tone: Color {
        switch line.state {
        case .running: Color.junoAccent
        case .done: Color.junoMutedForeground
        case .failed: Color.junoDanger
        case .refused, .unreported: Color.junoCaution
        }
    }

    private var trailing: String {
        switch line.state {
        case .running: "Now"
        case .done: NativeAgentFormat.ago(line.at)
        case .failed: "Didn’t work"
        case .refused: "Refused"
        case .unreported: "No answer"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Circle()
                .fill(tone)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(line.title)
                .font(.callout)
                .foregroundStyle(line.state == .done ? Color.junoMutedForeground : Color.junoForeground)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            Text(trailing)
                .junoCaption()
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityElement(children: .combine)
    }
}

/// The word of welcome a page opens with just after hiring: who arrived, the
/// promise it works under, and the one thing to do next. The web's "is here"
/// card; shown once, from the hire.
struct NativeAgentWelcome: View {
    let agent: NativeAgent
    let message: () -> Void
    let later: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("\(agent.name) is here.")
                .font(.callout.weight(.medium))
                .junoInk()
            Text("Tell it what to take on first. It works under “\(agent.approvalMode.agentAutonomyLabel)”, and always asks before anything it cannot take back.")
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: JunoSpace.snug) {
                Button("Message \(agent.name)", action: message)
                    .buttonStyle(.bordered)
                    .nativeAgentNeutralTint()
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                Button("Later", action: later)
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
        }
        .nativeAgentTile(padding: JunoSpace.regular)
        .accessibilityElement(children: .contain)
    }
}

/// An idea: what it is, why, and Start / Not now.
struct NativeAgentIdeaTile: View {
    let idea: NativeAgentIdea
    let busy: Bool
    let start: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(idea.title)
                .font(.callout.weight(.medium))
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
            if !idea.detail.isEmpty {
                Text(idea.detail)
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: JunoSpace.snug) {
                Button("Start", action: start)
                    .buttonStyle(.bordered)
                    .nativeAgentNeutralTint()
                    .disabled(busy)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                Button("Not now", action: dismiss)
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
        }
        .nativeAgentTile()
    }
}

// MARK: - Goals

/// Goals: each with its status, cadence and last check-in; add, pause,
/// achieve, drop; "Work on this" hands it to the agent as a task.
struct NativeAgentGoalsTab: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let goals: [NativeAgentGoal]
    let workOn: (NativeAgentGoal) -> Void

    @State private var draft = NativeAgentGoalDraft()

    private var ordered: [NativeAgentGoal] {
        let rank: (NativeAgentGoalStatus) -> Int = { status in
            switch status {
            case .active: 0
            case .paused: 1
            case .achieved: 2
            case .dropped: 3
            }
        }
        return goals.enumerated()
            .sorted { lhs, rhs in
                let left = rank(lhs.element.status)
                let right = rank(rhs.element.status)
                return left == right ? lhs.offset < rhs.offset : left < right
            }
            .map { $0.element }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            composer
            if ordered.isEmpty {
                Text("No goals yet. A goal is something it works towards over time and checks in on.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(ordered) { goal in
                        NativeAgentGoalTile(
                            goal: goal,
                            busy: model.isMutating,
                            workOn: { workOn(goal) },
                            setStatus: { status in
                                Task { await model.setGoalStatus(agentID: agent.id, goalID: goal.id, status: status) }
                            },
                            delete: {
                                Task { await model.deleteGoal(agentID: agent.id, goalID: goal.id) }
                            }
                        )
                    }
                }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentHeading(title: "New goal")
            TextField("Something it works towards over time", text: $draft.title)
                .nativeAgentField()
                .onSubmit(add)
            HStack(spacing: JunoSpace.snug) {
                Picker("Check-ins", selection: $draft.cadence) {
                    ForEach(NativeAgentGoalCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                .fixedSize()
                Spacer(minLength: JunoSpace.snug)
                Button("Add goal", action: add)
                    .buttonStyle(.bordered)
                    .nativeAgentNeutralTint()
                    .disabled(!draft.isValid || model.isMutating)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
        }
    }

    private func add() {
        let submitted = draft
        guard submitted.isValid else { return }
        Task {
            if await model.addGoal(agentID: agent.id, submitted) {
                draft = NativeAgentGoalDraft(cadence: submitted.cadence)
            }
        }
    }
}

/// One goal.
struct NativeAgentGoalTile: View {
    let goal: NativeAgentGoal
    let busy: Bool
    let workOn: () -> Void
    let setStatus: (NativeAgentGoalStatus) -> Void
    let delete: () -> Void

    private var meta: String {
        var parts = [goal.cadence.label]
        if let at = goal.lastCheckInAt {
            parts.append("last check-in \(NativeAgentFormat.ago(at))")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(goal.title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(goal.status == .active ? Color.junoForeground : Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: JunoSpace.snug)
                if goal.status != .active {
                    JunoCapsuleTag(goal.status.label)
                }
            }
            if !goal.detail.isEmpty {
                Text(goal.detail)
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(meta)
                .junoCaption()
            if let note = goal.lastCheckInNote, !note.isEmpty {
                Text(note)
                    .font(.callout)
                    .junoInk()
                    .padding(.leading, JunoSpace.snug)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color.junoBorder)
                            .frame(width: 2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: JunoSpace.snug) {
                if goal.status == .active {
                    Button("Work on this", action: workOn)
                        .buttonStyle(.bordered)
                        .nativeAgentNeutralTint()
                        .disabled(busy)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
                Menu {
                    if goal.status == .active {
                        Button("Pause") { setStatus(.paused) }
                    } else {
                        Button("Make active") { setStatus(.active) }
                    }
                    if goal.status != .achieved {
                        Button("Mark achieved") { setStatus(.achieved) }
                    }
                    if goal.status != .dropped {
                        Button("Drop") { setStatus(.dropped) }
                    }
                    Divider()
                    Button("Delete goal", role: .destructive, action: delete)
                } label: {
                    Text("Change")
                        .font(.callout)
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .fixedSize()
                .disabled(busy)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
        }
        .nativeAgentTile()
    }
}

// MARK: - Routines

/// Routines: the agent's automations with their next fire, and a way to add
/// one. Each is a real `WorkSchedule` under the agent; pausing, editing and run
/// history live in Automations, where every schedule already is.
struct NativeAgentRoutinesTab: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let routines: [NativeAgentRoutine]

    @State private var creating = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                NativeAgentHeading(title: routines.isEmpty ? "No routines yet" : "Its routines")
                Spacer(minLength: JunoSpace.snug)
                Button {
                    creating = true
                } label: {
                    Label("New routine", icon: .plus)
                }
                .buttonStyle(.bordered)
                .nativeAgentNeutralTint()
                .disabled(agent.isPaused)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            if routines.isEmpty {
                Text("A routine tells it when to work: a brief, and a clock to run it on.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(routines) { routine in
                    NativeAgentRoutineTile(routine: routine)
                }
            }
            Text("Pausing a routine, editing it and its run history are in Automations.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
        .sheet(isPresented: $creating) {
            NativeAgentRoutineEditor(
                agentName: agent.name,
                isSaving: model.isMutating,
                onCancel: { creating = false },
                onSave: { draft in
                    Task {
                        if await model.createRoutine(agentID: agent.id, draft) {
                            creating = false
                        }
                    }
                }
            )
        }
    }
}

struct NativeAgentRoutineTile: View {
    let routine: NativeAgentRoutine

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(routine.name)
                    .font(.callout.weight(.medium))
                    .junoInk()
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                if !routine.enabled {
                    JunoCapsuleTag("Paused")
                }
            }
            if !routine.schedule.isEmpty {
                Text(routine.schedule)
                    .font(.callout)
                    .junoSecondaryInk()
            }
            if routine.enabled, let at = routine.nextRunAt {
                Text("Next: \(NativeAgentFormat.upcoming(at))")
                    .junoCaption()
            } else if let at = routine.lastRunAt {
                Text("Last ran \(NativeAgentFormat.ago(at))")
                    .junoCaption()
            }
        }
        .nativeAgentTile()
    }
}

/// A new routine: a name, the brief, and a clock.
struct NativeAgentRoutineEditor: View {
    let agentName: String
    let isSaving: Bool
    let onCancel: () -> Void
    let onSave: (NativeAgentRoutineDraft) -> Void

    @State private var draft = NativeAgentRoutineDraft()
    @State private var time: Date = Calendar.current.date(
        bySettingHour: 9, minute: 0, second: 0, of: Date()
    ) ?? Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    Text("New routine for \(agentName)")
                        .junoEmptyTitle()
                        .junoInk()
                        .accessibilityAddTraits(.isHeader)
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        NativeAgentFieldLabel(title: "Name")
                        TextField("Weekly digest", text: $draft.name)
                            .nativeAgentField()
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        NativeAgentFieldLabel(title: "What it does each time")
                        TextEditor(text: $draft.instructions)
                            .font(.body)
                            .nativeAgentWell(minHeight: 120)
                            .accessibilityLabel("What it does each time")
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        NativeAgentFieldLabel(title: "When")
                        Picker("Repeats", selection: $draft.cadence) {
                            ForEach(NativeAgentRoutineCadence.allCases) { cadence in
                                Text(cadence.label).tag(cadence)
                            }
                        }
                        .pickerStyle(.menu)
                        .fixedSize()
                        if draft.cadence == .weekly {
                            Picker("Day", selection: $draft.weekday) {
                                ForEach(0..<7, id: \.self) { day in
                                    Text(NativeAgentFormat.weekdays[day]).tag(day)
                                }
                            }
                            .pickerStyle(.menu)
                            .fixedSize()
                        }
                        if draft.cadence == .monthly {
                            Stepper("Day \(draft.monthday) of the month", value: $draft.monthday, in: 1...31)
                                .fixedSize()
                        }
                        DatePicker(
                            draft.cadence == .hourly ? "Minute past the hour" : "Time",
                            selection: $time,
                            displayedComponents: .hourAndMinute
                        )
                        .fixedSize()
                        Text("In your time zone, \(draft.timezone).")
                            .junoCaption()
                    }
                }
                .padding(JunoSpace.roomy)
            }
            Divider()
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                Button("Create routine", action: save)
                    .keyboardShortcut(.defaultAction)
                    // Opaque, in the Juno accent: glass is chrome, never content or a
                    // sheet's body (MACOS_LIQUID_GLASS_REDESIGN.md §0.1).
                    .buttonStyle(.junoProminent)
                    .disabled(!isReady || isSaving)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)
        }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 520, idealHeight: 580)
        #endif
        .junoSheetSurface(.form)
    }

    private var isReady: Bool {
        var candidate = draft
        applyTime(to: &candidate)
        return candidate.isValid
    }

    private func applyTime(to draft: inout NativeAgentRoutineDraft) {
        let components = Calendar.current.dateComponents([.hour, .minute], from: time)
        draft.hour = components.hour ?? 9
        draft.minute = components.minute ?? 0
    }

    private func save() {
        var submitted = draft
        applyTime(to: &submitted)
        guard submitted.isValid else { return }
        onSave(submitted)
    }
}

// MARK: - Activity

/// One log for everything the agent did: tasks started and finished, stops to
/// ask, approvals, work handed to a teammate or taken from one, goals, ideas,
/// routines, and what it learned. The server words every line; a line about
/// one of its runs opens that run's thread, as the web's does.
struct NativeAgentActivityTab: View {
    let model: NativeAgentsModel
    let agentID: String
    let entries: [NativeAgentActivity]
    /// The agent's tasks, for a line about one of them to open it.
    let tasks: [NativeAgentTask]
    let openTask: (NativeAgentTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if entries.isEmpty {
                Text("Nothing has happened yet. Everything it does is written here.")
                    .font(.callout)
                    .junoSecondaryInk()
            } else {
                ForEach(entries) { entry in
                    line(entry)
                    if entry.id != entries.last?.id {
                        Divider()
                    }
                }
            }
        }
        .task(id: agentID) { await model.loadActivity(id: agentID) }
    }

    /// A run this page does not list — work handed to a teammate runs in the
    /// teammate's thread — is a line and nothing more.
    @ViewBuilder
    private func line(_ entry: NativeAgentActivity) -> some View {
        if let task = openableTask(for: entry) {
            Button {
                openTask(task)
            } label: {
                NativeAgentActivityLine(entry: entry)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens its thread")
        } else {
            NativeAgentActivityLine(entry: entry)
        }
    }

    private func openableTask(for entry: NativeAgentActivity) -> NativeAgentTask? {
        guard entry.isAboutARun, let sessionID = entry.sessionID else { return nil }
        return tasks.first { $0.sessionID == sessionID }
    }
}

struct NativeAgentActivityLine: View {
    let entry: NativeAgentActivity

    private var tone: Color {
        switch entry.tone {
        case .attention: Color.junoCaution
        case .success: Color.junoSuccess
        case .danger: Color.junoDanger
        case .neutral: Color.junoMutedForeground
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Circle()
                .fill(tone)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(.callout)
                    .junoInk()
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = entry.detail {
                    Text(detail)
                        .font(.callout)
                        .junoSecondaryInk()
                        .lineLimit(3)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            if let at = entry.at {
                Text(NativeAgentFormat.ago(at))
                    .junoCaption()
            }
        }
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .combine)
    }
}
