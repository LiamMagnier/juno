import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// An agent's profile (DIRECTION.md, Profile sheet): what it is, in prose.
///
/// The top is the display moment: the face at 96 on its halo, the name in
/// the display italic, the role, and "Change anything by telling Wren." with
/// a Message button. Then sections, each hidden when empty: Needs you,
/// Working on, Goals, Routines, What it knows, What it can use and How much it
/// asks. The footer is Pause and Retire.
///
/// **Almost nothing here is a form.** The controls are: answer what it is
/// waiting on, check a goal, pause a routine, forget a note, remove an app,
/// open or turn off its computer, pause, and retire. Every other change is
/// made by telling it, in its thread.
public struct NativeAgentProfileSheet: View {
    private let model: NativeAgentsModel
    private let agentID: String
    private let apps: [NativeAgentAppChoice]
    private let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    private let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    private let message: () -> Void
    private let openThread: (String) -> Void
    private let close: () -> Void

    @State private var confirmingRetire = false
    @State private var showingComputer = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - apps: the apps this account has connected, to name the ones it may
    ///     use by their labels.
    ///   - localApprovals: approvals a run executing on this Mac has raised,
    ///     by run id. Nil anywhere but the Mac.
    ///   - decideLocally: answers one of those through the coordinator
    ///     holding the run.
    ///   - message: closes the sheet and puts the caret in the agent's
    ///     thread.
    ///   - openThread: opens a conversation by id: a task's own thread.
    public init(
        model: NativeAgentsModel,
        agentID: String,
        apps: [NativeAgentAppChoice] = [],
        localApprovals: (@MainActor (String) -> [WorkApprovalRequest])? = nil,
        decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)? = nil,
        message: @escaping () -> Void,
        openThread: @escaping (String) -> Void,
        close: @escaping () -> Void
    ) {
        self.model = model
        self.agentID = agentID
        self.apps = apps
        self.localApprovals = localApprovals
        self.decideLocally = decideLocally
        self.message = message
        self.openThread = openThread
        self.close = close
    }

    public var body: some View {
        Group {
            if let agent = model.agent(id: agentID) {
                sheet(agent)
            } else if model.loadingDetailID == agentID {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Loading")
            } else {
                gone
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 580, minHeight: 560, idealHeight: 760)
        #endif
        .junoSheetSurface(.page)
        .task(id: agentID) { await model.loadDetail(id: agentID) }
        .accessibilityIdentifier("juno.agents.profile")
    }

    // MARK: The sheet

    @ViewBuilder
    private func sheet(_ agent: NativeAgent) -> some View {
        #if os(macOS)
        VStack(spacing: 0) {
            ScrollView {
                NativeAgentProfileContent(
                    model: model,
                    agent: agent,
                    apps: apps,
                    localApprovals: localApprovals,
                    decideLocally: decideLocally,
                    message: message,
                    openThread: openThread,
                    openComputer: { showingComputer = true }
                )
                .padding(.horizontal, JunoSpace.section)
                .padding(.top, JunoSpace.section)
                .padding(.bottom, JunoSpace.roomy)
            }
            .scrollBounceBehavior(.basedOnSize)
            footer(agent)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.vertical, JunoSpace.regular)
        }
        .modifier(sheetChrome(agent))
        #else
        NavigationStack {
            ScrollView {
                VStack(spacing: JunoSpace.section) {
                    NativeAgentProfileContent(
                        model: model,
                        agent: agent,
                        apps: apps,
                        localApprovals: localApprovals,
                        decideLocally: decideLocally,
                        message: message,
                        openThread: openThread,
                        openComputer: { showingComputer = true }
                    )
                    footer(agent)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.snug)
                .padding(.bottom, JunoSpace.region)
            }
            .scrollBounceBehavior(.basedOnSize)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close)
                }
            }
            .refreshable { await model.loadDetail(id: agentID) }
        }
        .modifier(sheetChrome(agent))
        #endif
    }

    private func sheetChrome(_ agent: NativeAgent) -> NativeAgentProfileChrome {
        NativeAgentProfileChrome(
            model: model,
            agent: agent,
            confirmingRetire: $confirmingRetire,
            showingComputer: $showingComputer,
            retired: close
        )
    }

    private func footer(_ agent: NativeAgent) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Button(agent.isPaused ? "Resume" : "Pause") {
                Task { await model.setPaused(id: agent.id, paused: !agent.isPaused) }
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .contentShape(.rect)
            .disabled(model.isMutating)
            Button("Retire", role: .destructive) { confirmingRetire = true }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                .disabled(model.isMutating)
            Spacer(minLength: 0)
            #if os(macOS)
            Button("Done", action: close)
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                .keyboardShortcut(.cancelAction)
            #endif
        }
        .controlSize(NativeAgentProfileContent.controlSize)
    }

    private var gone: some View {
        VStack(spacing: JunoSpace.cozy) {
            Text("This agent is no longer here.")
                .junoType(.bodyLarge)
                .foregroundStyle(Color.junoForeground)
            Text("It may have been retired. Its thread stays in your chats.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
            Button("Close", action: close)
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                .padding(.top, JunoSpace.snug)
        }
        .multilineTextAlignment(.center)
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The confirmations and the computer, hung off whichever container the
/// platform's sheet has.
private struct NativeAgentProfileChrome: ViewModifier {
    let model: NativeAgentsModel
    let agent: NativeAgent
    @Binding var confirmingRetire: Bool
    @Binding var showingComputer: Bool
    let retired: () -> Void

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Retire \(agent.name)?",
                isPresented: $confirmingRetire,
                titleVisibility: .visible
            ) {
                Button("Retire", role: .destructive) {
                    Task {
                        if await model.retire(id: agent.id) { retired() }
                    }
                }
                .contentShape(.rect)
                Button("Cancel", role: .cancel) {}
                    .contentShape(.rect)
            } message: {
                Text("Its routines stop and it leaves your agents. Its thread stays, as an ordinary chat.")
            }
            .nativeAgentComputerPresentation(isPresented: $showingComputer, model: model, agent: agent)
    }
}

// MARK: - The prose

/// Everything between the header and the footer.
struct NativeAgentProfileContent: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let apps: [NativeAgentAppChoice]
    let localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    let message: () -> Void
    let openThread: (String) -> Void
    let openComputer: () -> Void

    #if os(macOS)
    static let controlSize: ControlSize = .regular
    #else
    static let controlSize: ControlSize = .large
    #endif

    private var detail: NativeAgentDetail? { model.details[agent.id] }

    private var tasks: [NativeAgentTask] {
        model.tasks(for: agent.id)
    }

    private var waiting: [NativeAgentTask] {
        tasks.filter(NativeAgentGate.isWaiting)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            header
                .padding(.bottom, JunoSpace.snug)
            if !waiting.isEmpty {
                needsYou
            }
            workingOn
            goals
            routines
            knows
            canUse
            asks
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: readKey) { await followGates() }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 0) {
            NativeAgentPresence(
                avatar: agent.avatar,
                state: agent.isPaused ? .sleeping : agent.state,
                size: NativeAgentMetrics.profileFace,
                name: agent.name
            )
            // Room for the halo, which spreads past the face.
            .padding(.top, NativeAgentMetrics.profileFace * 0.6)
            Text(agent.name)
                .junoDisplayItalic(Self.nameSize)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(2)
                .padding(.top, JunoSpace.section)
                .accessibilityAddTraits(.isHeader)
            if !agent.role.isEmpty {
                Text(agent.role)
                    .junoType(.bodyLarge)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.top, JunoSpace.tight)
            }
            if agent.isPaused {
                Text("Paused. Its routines are off until you resume it.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoTertiaryInk)
                    .padding(.top, JunoSpace.snug)
            }
            Text("Change anything by telling \(agent.name).")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.top, JunoSpace.roomy)
            Button(action: message) {
                Label("Message", icon: .message)
            }
            .buttonStyle(.junoProminent)
            .contentShape(.rect)
            .controlSize(Self.controlSize)
            .padding(.top, JunoSpace.cozy)
            .accessibilityIdentifier("juno.agents.profile.message")
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    #if os(macOS)
    private static let nameSize: CGFloat = 40
    #else
    private static let nameSize: CGFloat = 32
    #endif

    // MARK: Needs you

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentNeedsYouLine()
                .accessibilityAddTraits(.isHeader)
            ForEach(waiting) { task in
                NativeAgentGateStack(
                    model: model,
                    agentID: agent.id,
                    task: task,
                    gate: gate(for: task),
                    approvalsOnThisMac: approvalsOnThisMac(for: task),
                    decideLocally: decideLocally,
                    open: { open(task) }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func gate(for task: NativeAgentTask) -> NativeAgentGate? {
        model.gates[agent.id]?.first { $0.id == task.sessionID }
    }

    private func approvalsOnThisMac(for task: NativeAgentTask) -> [WorkApprovalRequest] {
        guard let localApprovals, decideLocally != nil, let runID = gate(for: task)?.runID else { return [] }
        return localApprovals(runID)
    }

    /// Whether what this sheet shows can change faster than the roster's
    /// minute: something waits on the person, or its newest task is live.
    private var follows: Bool {
        guard model.canAnswerInPlace else { return false }
        if !waiting.isEmpty || agent.needsYou > 0 { return true }
        guard let status = tasks.first?.status, let known = JunoWorkStatus(rawValue: status) else { return false }
        return !known.isTerminal && known != .draft
    }

    private var readKey: String {
        "\(agent.id)|\(follows)|\(tasks.first?.sessionID ?? "")|\(waiting.map(\.sessionID).joined(separator: ","))"
    }

    /// Reads the gates on arrival, then every ten seconds while something
    /// here can move. Closing the sheet cancels it.
    private func followGates() async {
        await readGates()
        guard follows else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            await readGates()
        }
    }

    private func readGates() async {
        let knowsWhich = model.tasks(for: agent.id).contains(where: NativeAgentGate.isWaiting)
        if !knowsWhich, (model.agent(id: agent.id)?.needsYou ?? 0) > 0 {
            await model.loadDetail(id: agent.id)
        }
        await model.loadGates(agentID: agent.id)
    }

    // MARK: Working on

    @ViewBuilder
    private var workingOn: some View {
        if let task = liveTask {
            NativeAgentSection("Working on") {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                    Text(task.title)
                        .junoType(.body)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    NativeAgentTextButton(title: "Show in thread") { open(task) }
                }
            }
        }
    }

    /// The task it is doing now, if any: its newest, while that is still live.
    private var liveTask: NativeAgentTask? {
        guard let task = tasks.first, !NativeAgentGate.isWaiting(task),
            let status = JunoWorkStatus(rawValue: task.status), !status.isTerminal, status != .draft
        else { return nil }
        return task
    }

    private func open(_ task: NativeAgentTask) {
        if let conversationID = task.conversationID ?? agent.conversationID {
            openThread(conversationID)
        } else {
            message()
        }
    }

    // MARK: Goals

    @ViewBuilder
    private var goals: some View {
        let list = (detail?.goals ?? []).filter { $0.status != .dropped }
        let open = list.filter { $0.status != .achieved }
        let achieved = Array(list.filter { $0.status == .achieved }.suffix(3))
        if !open.isEmpty || !achieved.isEmpty {
            NativeAgentSection("Goals") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(open + achieved) { goal in
                        NativeAgentGoalLine(goal: goal, busy: model.isMutating) {
                            Task {
                                await model.setGoalStatus(agentID: agent.id, goalID: goal.id, status: .achieved)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Routines

    @ViewBuilder
    private var routines: some View {
        let list = detail?.routines ?? []
        if !list.isEmpty {
            NativeAgentSection("Routines") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(list) { routine in
                        NativeAgentRoutineLine(
                            routine: routine,
                            canPause: model.canPauseRoutines,
                            busy: model.isTogglingRoutine(routine.id)
                        ) { enabled in
                            Task {
                                await model.setRoutineEnabled(agentID: agent.id, routineID: routine.id, enabled: enabled)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: What it knows

    @ViewBuilder
    private var knows: some View {
        let notes = detail?.notes ?? []
        if !notes.isEmpty {
            NativeAgentSection("What it knows") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(notes) { note in
                        NativeAgentNoteLine(note: note, busy: model.isMutating) {
                            Task { await model.deleteNote(agentID: agent.id, noteID: note.id) }
                        }
                    }
                }
            }
        }
    }

    // MARK: What it can use

    @ViewBuilder
    private var canUse: some View {
        let computer = model.computer(for: agent.id)
        if !agent.connectorIDs.isEmpty || computer != nil {
            NativeAgentSection("What it can use") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(agent.connectorIDs, id: \.self) { connectorID in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                            Text(appLabel(connectorID))
                                .junoType(.body)
                                .foregroundStyle(Color.junoForeground)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            NativeAgentTextButton(title: "Remove") {
                                Task { await model.removeApp(agentID: agent.id, connectorID: connectorID) }
                            }
                            .disabled(model.isMutating)
                        }
                    }
                    if let computer {
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Its own computer")
                                    .junoType(.body)
                                    .foregroundStyle(Color.junoForeground)
                                Text(NativeAgentComputerWords.sentence(for: computer, name: agent.name))
                                    .junoType(.ui)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            NativeAgentTextButton(title: "Open", action: openComputer)
                            NativeAgentTextButton(title: "Turn off") {
                                Task { await model.computerAction(agentID: agent.id, action: "disable") }
                            }
                        }
                        .padding(.top, agent.connectorIDs.isEmpty ? 0 : JunoSpace.snug)
                    }
                }
            }
        }
    }

    /// The app's name as the account's connections say it, or its id in
    /// words when it is not connected any more.
    private func appLabel(_ connectorID: String) -> String {
        if let app = apps.first(where: { $0.id == connectorID }) { return app.label }
        let bare = connectorID.split(separator: ":").last.map(String.init) ?? connectorID
        return bare.replacingOccurrences(of: "-", with: " ").capitalized
    }

    // MARK: How much it asks

    private var asks: some View {
        NativeAgentSection("How much it asks") {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(NativeAgentFormat.autonomySentence(agent.approvalMode, name: agent.name))
                    .junoType(.body)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Ask \(agent.name) to change this.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoTertiaryInk)
            }
        }
    }
}

// MARK: - Lines

/// One goal as a checklist line. Checking it achieves it; an achieved goal
/// stays checked, quietly.
struct NativeAgentGoalLine: View {
    let goal: NativeAgentGoal
    let busy: Bool
    let achieve: () -> Void

    private var done: Bool { goal.status == .achieved }

    var body: some View {
        Button(action: achieve) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                JunoIconView(done ? .circleCheck : .circle, size: 16)
                    .foregroundStyle(done ? Color.junoSecondaryInk : Color.junoTertiaryInk)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(goal.title)
                        .junoType(.body)
                        .foregroundStyle(done || goal.status == .paused ? Color.junoSecondaryInk : Color.junoForeground)
                        .strikethrough(done, color: Color.junoTertiaryInk)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if goal.status == .paused {
                        Text("Paused")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoTertiaryInk)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: NativeAgentMetrics.target)
            .padding(.vertical, JunoSpace.hairline)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(done || busy)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: goal.title))
        .accessibilityValue(done ? "Achieved" : goal.status == .paused ? "Paused" : "Not yet")
        .accessibilityHint(done ? "" : "Marks it achieved")
        .accessibilityAddTraits(done ? [.isButton, .isSelected] : .isButton)
    }
}

/// One routine: "Every weekday at 08:30: Morning briefing", with its pause
/// switch.
struct NativeAgentRoutineLine: View {
    let routine: NativeAgentRoutine
    let canPause: Bool
    let busy: Bool
    let setEnabled: (Bool) -> Void

    private var words: String {
        routine.schedule.isEmpty ? routine.name : "\(routine.schedule): \(routine.name)"
    }

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text(words)
                    .junoType(.body)
                    .foregroundStyle(routine.enabled ? Color.junoForeground : Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if !routine.enabled {
                    Text("Paused")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoTertiaryInk)
                } else if let at = routine.nextRunAt {
                    Text("Next \(NativeAgentFormat.upcoming(at))")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoTertiaryInk)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if canPause {
                Toggle(
                    isOn: Binding(get: { routine.enabled }, set: { setEnabled($0) })
                ) {
                    Text(routine.enabled ? "Pause \(routine.name)" : "Resume \(routine.name)")
                }
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Color.junoAccent)
                .disabled(busy)
                #if os(macOS)
                .controlSize(.small)
                #endif
            }
        }
        .frame(minHeight: NativeAgentMetrics.target)
        .padding(.vertical, JunoSpace.tight)
    }
}

/// One thing it knows, with a way to forget it: under the pointer on the
/// Mac, always on the phone.
struct NativeAgentNoteLine: View {
    let note: NativeAgentNote
    let busy: Bool
    let forget: () -> Void

    @State private var isHovering = false

    private var showsForget: Bool {
        #if os(macOS)
        isHovering
        #else
        true
        #endif
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Text(note.content)
                .junoType(.body)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: forget) {
                JunoIconView(.trash, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .opacity(showsForget ? 1 : 0)
            .disabled(busy)
            .help("Forget")
            .accessibilityLabel("Forget this")
        }
        .padding(.vertical, JunoSpace.micro)
        .contentShape(.rect)
        .onHover { isHovering = $0 }
    }
}

/// One waiting task and what it is stopped at: its title, then its
/// approvals, oldest first, then its question, answerable here with the same
/// Work cards its thread shows.
struct NativeAgentGateStack: View {
    let model: NativeAgentsModel
    let agentID: String
    let task: NativeAgentTask
    let gate: NativeAgentGate?
    let approvalsOnThisMac: [WorkApprovalRequest]
    let decideLocally: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    let open: () -> Void

    private var answerable: Bool {
        !approvalsOnThisMac.isEmpty || !(gate?.approvals.isEmpty ?? true) || gate?.question != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                Text(task.title)
                    .junoType(.body)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                NativeAgentTextButton(title: answerable ? "Show in thread" : "Answer in thread", action: open)
            }
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
                        Task { await model.decide(agentID: agentID, approval, decision) }
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
                .id(question.questionID)
            }
        }
    }
}
