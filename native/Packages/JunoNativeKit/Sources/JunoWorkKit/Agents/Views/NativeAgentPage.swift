import Foundation
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
/// The page answers "what is it doing, and does it need me?" first. Anything
/// that needs the person is answered in the agent's thread, where the question
/// and its approval card already live — the Work cards are the gate, never a
/// second copy of them here.
struct NativeAgentPage: View {
    let model: NativeAgentsModel
    let agentID: String
    let apps: [NativeAgentAppChoice]
    let openConversation: (String) -> Void
    /// The page's own way back, on the Mac where it replaces the roster in
    /// place. Nil in a navigation stack, whose back button already says it.
    var back: (() -> Void)?

    @State private var tab: NativeAgentTab = .now
    @State private var costQuestion: NativeAgentCostQuestion?
    @State private var confirmingRetire = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    private var retireTitle: String {
        "Delete \(model.agent(id: agentID)?.name ?? "this agent")?"
    }

    var body: some View {
        Group {
            if let agent = model.agent(id: agentID) {
                page(agent)
            } else if model.loadingDetailID == agentID {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Loading agent")
            } else {
                NativeAgentsNotice(
                    title: "This agent is no longer here",
                    message: model.lastErrorDescription ?? "It may have been retired on another device.",
                    icon: .agents,
                    actionLabel: back == nil ? nil : "Back to agents",
                    action: back
                )
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
            Button("Delete agent", role: .destructive) { retire() }
                .contentShape(.rect)
            Button("Cancel", role: .cancel) {}
                .contentShape(.rect)
        } message: {
            Text("Its routines stop. Its thread and its tasks stay, as ordinary chats and tasks.")
        }
        .accessibilityIdentifier("juno.agents.page")
    }

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
        }
        .onChange(of: tab) { _, _ in model.clearMutationMessage() }
    }

    @ViewBuilder
    private func tabContent(_ agent: NativeAgent) -> some View {
        let detail = model.details[agentID]
        switch tab {
        case .now:
            NativeAgentNowTab(
                model: model,
                agent: agent,
                detail: detail,
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
                entries: model.activity[agent.id] ?? []
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
        Task { await model.setPaused(id: agent.id, paused: !agent.isPaused) }
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
        Task {
            guard await model.retire(id: agentID) else { return }
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
            .menuIndicator(.hidden)
            .fixedSize()
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
            .accessibilityLabel("More")
        }
    }
}

// MARK: - Now

/// Now: the block that needs you first, then the task it is doing, then its
/// ideas, then what is coming up. The native page is simpler than the web's —
/// a question is answered in the thread, where its card lives.
struct NativeAgentNowTab: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let detail: NativeAgentDetail?
    let openTask: (NativeAgentTask) -> Void
    let startIdea: (NativeAgentIdea) -> Void
    let dismissIdea: (NativeAgentIdea) -> Void

    private var tasks: [NativeAgentTask] {
        if let detail, !detail.tasks.isEmpty { return detail.tasks }
        return agent.task.map { [$0] } ?? []
    }

    private var waiting: [NativeAgentTask] {
        tasks.filter { $0.needsAttention || $0.status == "waiting_input" || $0.status == "waiting_approval" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            if !waiting.isEmpty || agent.needsYou > 0 {
                needsYou
            }
            latestTask
            ideas
            upcoming
        }
    }

    private var needsYou: some View {
        let count = max(agent.needsYou, waiting.count)
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                NativeAgentNeedsYouDot()
                NativeAgentHeading(title: count == 1 ? "Needs you on one task" : "Needs you on \(count) tasks")
            }
            ForEach(waiting) { task in
                NativeAgentTaskLine(task: task, open: { openTask(task) })
            }
            Text("Answer it in the thread, where the question and its approval card are. Deny is always first.")
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
                .textFieldStyle(.roundedBorder)
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
                            .textFieldStyle(.roundedBorder)
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
/// ask, approvals, goals, ideas, routines, and what it learned.
struct NativeAgentActivityTab: View {
    let model: NativeAgentsModel
    let agentID: String
    let entries: [NativeAgentActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if entries.isEmpty {
                Text("Nothing has happened yet. Everything it does is written here.")
                    .font(.callout)
                    .junoSecondaryInk()
            } else {
                ForEach(entries) { entry in
                    NativeAgentActivityLine(entry: entry)
                    if entry.id != entries.last?.id {
                        Divider()
                    }
                }
            }
        }
        .task(id: agentID) { await model.loadActivity(id: agentID) }
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
