import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// An agent's profile: what it is, in prose. The web's `AgentProfile`
/// (`agent-panel.tsx`): one sheet, no tabs.
///
/// Almost nothing here is a form. Its face on its halo (press it to change
/// the face), its name in the serif italic, its role, and one invitation:
/// "Change anything by telling it", with Message. Then what needs you or what
/// it is working on, its ideas (Start, Not now), what it is working toward,
/// when it works, what it knows, what it can use and how much it asks. It can
/// be paused, an app or a note removed, its computer turned off, and it can
/// retire; every other change is made by telling it.
public struct NativeAgentProfileView: View {
    private let model: NativeAgentsModel
    private let agentID: String
    private let apps: [NativeAgentAppChoice]
    private let message: () -> Void
    private let openComputer: (() -> Void)?
    private let close: (() -> Void)?
    private let retired: () -> Void

    @State private var confirm: Confirm?
    @State private var busy: String?
    @State private var costQuestion: NativeAgentCostQuestion?
    @State private var customizing = false
    /// The Mac list is open: "Your Mac" was chosen here (see `macList`). Only
    /// on a device that cannot name itself as the Mac (`listsMacs`).
    @State private var choosingMac = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.nativeAgentThisMac) private var thisMac

    enum Confirm: Identifiable {
        case retire, computerOn, computerOff
        var id: Self { self }
    }

    /// - Parameters:
    ///   - apps: the account's connected apps, to name an agent's by their
    ///     labels.
    ///   - message: the one invitation: close this and talk to it.
    ///   - openComputer: shows its computer. Nil hides Open.
    ///   - close: the sheet's close control. Nil on a page.
    ///   - retired: after it retired, to leave its thread or page.
    public init(
        model: NativeAgentsModel,
        agentID: String,
        apps: [NativeAgentAppChoice] = [],
        message: @escaping () -> Void,
        openComputer: (() -> Void)? = nil,
        close: (() -> Void)? = nil,
        retired: @escaping () -> Void = {}
    ) {
        self.model = model
        self.agentID = agentID
        self.apps = apps
        self.message = message
        self.openComputer = openComputer
        self.close = close
        self.retired = retired
    }

    public var body: some View {
        ScrollView {
            Group {
                if let agent = model.agent(id: agentID) {
                    content(agent, detail: model.details[agentID])
                } else if model.loadingDetailID == agentID || model.phase == .loading {
                    VStack(spacing: JunoSpace.regular) {
                        JunoSkeleton(height: 96, width: 96, cornerRadius: 48)
                        JunoSkeleton(height: 26, width: 128)
                        JunoSkeleton(height: 16, width: 192)
                    }
                    .padding(.top, JunoSpace.vast)
                    .frame(maxWidth: .infinity)
                    .accessibilityElement()
                    .accessibilityLabel("Loading profile")
                } else {
                    NativeAgentsNotice(
                        title: "This agent is no longer here",
                        message: "It may have been retired. Its thread and tasks are still in your chats.",
                        icon: .agents
                    )
                }
            }
            .frame(maxWidth: 440)
            .padding(.horizontal, JunoSpace.section)
            .padding(.top, JunoSpace.vast)
            .padding(.bottom, JunoSpace.expanse)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .overlay(alignment: .topTrailing) {
            if let close {
                Button(action: close) {
                    JunoIconView(.close, size: 16)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Close profile")
                .accessibilityLabel("Close profile")
                .padding(JunoSpace.cozy)
            }
        }
        .junoAgentGazeField()
        .task(id: agentID) { await model.loadDetail(id: agentID) }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible,
            presenting: confirm
        ) { which in
            switch which {
            case .retire:
                Button("Retire", role: .destructive) { retire() }
                    .contentShape(.rect)
            case .computerOn:
                Button("Give It One") { computer("enable") }
                    .contentShape(.rect)
            case .computerOff:
                Button("Turn Off", role: .destructive) { computer("disable") }
                    .contentShape(.rect)
            }
            Button("Cancel", role: .cancel) { confirm = nil }
                .contentShape(.rect)
        } message: { which in
            switch which {
            case .retire:
                Text("Its routines stop and it leaves your agents. This conversation stays in your history.")
            case .computerOn:
                Text("It gets a private desktop on your server. What it signs in to and the files it keeps stay there between tasks, until you reset or turn it off.")
            case .computerOff:
                Text("The computer is deleted, with everything it signed in to and every file on it.")
            }
        }
        .confirmationDialog(
            "Start it?",
            isPresented: Binding(get: { costQuestion != nil }, set: { if !$0 { costQuestion = nil } }),
            titleVisibility: .visible,
            presenting: costQuestion
        ) { question in
            Button("Start") { startConfirmed(question) }
                .contentShape(.rect)
            Button("Cancel", role: .cancel) { costQuestion = nil }
                .contentShape(.rect)
        } message: { question in
            Text(question.message)
        }
        .sheet(isPresented: $customizing) {
            if let agent = model.agent(id: agentID) {
                NativeAgentFaceSheet(model: model, agent: agent, done: { customizing = false })
            }
        }
        .accessibilityIdentifier("juno.agents.profile")
    }

    private var name: String { model.agent(id: agentID)?.name ?? "this agent" }

    private var confirmTitle: String {
        switch confirm {
        case .retire: "Retire \(name)?"
        case .computerOn: "Give \(name) a computer?"
        case .computerOff: "Turn off \(name)’s computer?"
        case nil: ""
        }
    }

    // MARK: Content

    private func content(_ agent: NativeAgent, detail: NativeAgentDetail?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(agent)
            VStack(alignment: .leading, spacing: 36) {
                attention(agent)
                if let detail {
                    ideas(agent, detail.ideas)
                    goals(agent, detail.goals.filter { $0.status == .active })
                    routines(agent, detail.routines)
                    notes(agent, detail.notes)
                    uses(agent, detail)
                }
                NativeAgentProfileSection(title: "How much it asks") {
                    Text(Self.asks(agent.approvalMode))
                        .junoType(.body)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Ask \(agent.name) to change this.")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.top, JunoSpace.hairline)
                }
                runsOn(agent)
            }
            .padding(.top, JunoSpace.expanse)
            footer(agent)
        }
    }

    private func header(_ agent: NativeAgent) -> some View {
        VStack(spacing: 0) {
            NativeAgentFaceButton(agent: agent, customize: { customizing = true })
            Text(agent.name)
                .junoType(.displayItalic(size: JunoType.title.size + 4))
                .foregroundStyle(Color.junoForeground)
                .padding(.top, JunoSpace.cozy)
                .accessibilityAddTraits(.isHeader)
            let role = agent.role.trimmingCharacters(in: .whitespacesAndNewlines)
            if !role.isEmpty {
                Text(role)
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.top, JunoSpace.hairline)
            }
            Text("Change anything by telling \(agent.name).")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.top, JunoSpace.regular)
            Button("Message", action: message)
                .buttonStyle(.junoProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.regular)
                .padding(.top, JunoSpace.regular)
                .accessibilityIdentifier("juno.agents.message")
                .contentShape(.capsule)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func attention(_ agent: NativeAgent) -> some View {
        let needsYou = agent.state == .waiting || agent.needsYou > 0
        if needsYou || agent.task != nil {
            NativeAgentProfileSection(title: needsYou ? "Needs you" : "Working on") {
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    if needsYou {
                        JunoIconView(.hand, size: 16)
                            .foregroundStyle(Color.junoAccentInk)
                            .padding(.top, 2)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text(agent.task?.title ?? NativeAgentFormat.stateSentence(for: agent))
                            .junoType(needsYou ? JunoType.body.weight(.medium) : .body)
                            .foregroundStyle(needsYou ? Color.junoAccentInk : Color.junoForeground)
                            .fixedSize(horizontal: false, vertical: true)
                        NativeAgentQuietLink(title: needsYou ? "Answer in chat" : "Show in chat", action: message)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func ideas(_ agent: NativeAgent, _ ideas: [NativeAgentIdea]) -> some View {
        if !ideas.isEmpty {
            NativeAgentProfileSection(title: "Ideas") {
                VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                    ForEach(ideas.prefix(3)) { idea in
                        VStack(alignment: .leading, spacing: JunoSpace.micro) {
                            Text(idea.title)
                                .junoType(.body)
                                .foregroundStyle(Color.junoForeground)
                                .fixedSize(horizontal: false, vertical: true)
                            if !idea.detail.isEmpty {
                                Text(idea.detail)
                                    .junoType(.ui)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: JunoSpace.hairline) {
                                Button("Start") { decide(idea, .start) }
                                    .buttonStyle(.junoProminent)
                                    .buttonBorderShape(.capsule)
                                    .controlSize(.small)
                                    .disabled(busy == idea.id)
                                    .contentShape(.capsule)
                                Button("Not now") { decide(idea, .dismiss) }
                                    .buttonStyle(.borderless)
                                    .controlSize(.small)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .disabled(busy == idea.id)
                                    .contentShape(.rect)
                            }
                            .padding(.top, JunoSpace.snug)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func goals(_ agent: NativeAgent, _ goals: [NativeAgentGoal]) -> some View {
        if !goals.isEmpty {
            NativeAgentProfileSection(title: "Working toward") {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(goals) { goal in
                        Button {
                            act(goal.id) { await model.setGoalStatus(agentID: agent.id, goalID: goal.id, status: .achieved) }
                        } label: {
                            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                                JunoIconView(.square, size: 16)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .padding(.top, 2)
                                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                                    Text(goal.title)
                                        .junoType(.body)
                                        .foregroundStyle(Color.junoForeground)
                                        .fixedSize(horizontal: false, vertical: true)
                                    if let note = goal.lastCheckInNote, !note.isEmpty {
                                        Text(note)
                                            .junoType(.ui)
                                            .foregroundStyle(Color.junoSecondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .disabled(busy == goal.id)
                        .multilineTextAlignment(.leading)
                        .accessibilityLabel("Mark “\(goal.title)” achieved")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func routines(_ agent: NativeAgent, _ routines: [NativeAgentRoutine]) -> some View {
        if !routines.isEmpty {
            NativeAgentProfileSection(title: "When it works") {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(routines) { routine in
                        HStack(alignment: .center, spacing: JunoSpace.cozy) {
                            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                                Text(routine.name)
                                    .junoType(.body)
                                    .foregroundStyle(routine.enabled ? Color.junoForeground : Color.junoSecondaryInk)
                                Text(Self.when(routine))
                                    .junoType(.ui)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: JunoSpace.snug)
                            Toggle(
                                isOn: Binding(
                                    get: { routine.enabled },
                                    set: { on in
                                        act(routine.id) {
                                            await model.setRoutineEnabled(agentID: agent.id, routineID: routine.id, enabled: on)
                                        }
                                    }
                                )
                            ) {
                                Text("\(routine.enabled ? "Pause" : "Resume") \(routine.name)")
                            }
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .tint(Color.junoAccent)
                            .disabled(busy == routine.id)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func notes(_ agent: NativeAgent, _ notes: [NativeAgentNote]) -> some View {
        if !notes.isEmpty {
            NativeAgentProfileSection(title: "What it knows") {
                VStack(alignment: .leading, spacing: JunoSpace.close) {
                    ForEach(notes) { note in
                        NativeAgentRemovableRow(label: "Forget this", icon: true, disabled: busy == note.id) {
                            Text(note.content)
                                .junoType(.body)
                                .foregroundStyle(Color.junoForeground)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        } remove: {
                            act(note.id) { await model.deleteNote(agentID: agent.id, noteID: note.id) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func uses(_ agent: NativeAgent, _ detail: NativeAgentDetail) -> some View {
        let computer = detail.computerConfigured ? detail.computer : nil
        let hasComputer = computer.map { $0.enabled && $0.status != "disabled" } ?? false
        let canGetComputer = detail.computerConfigured && !hasComputer
        if !agent.connectorIDs.isEmpty || hasComputer || canGetComputer {
            NativeAgentProfileSection(title: "What it can use") {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    if hasComputer, let computer {
                        HStack(alignment: .center, spacing: JunoSpace.cozy) {
                            JunoIconView(.monitor, size: 16)
                                .foregroundStyle(Color.junoSecondaryInk)
                            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                                Text("Its own computer")
                                    .junoType(.body)
                                    .foregroundStyle(Color.junoForeground)
                                Text(Self.computerWords(computer.status))
                                    .junoType(.ui)
                                    .foregroundStyle(Color.junoSecondaryInk)
                            }
                            Spacer(minLength: JunoSpace.snug)
                            if let openComputer {
                                Button("Open", action: openComputer)
                                    .buttonStyle(.junoGlass)
                                    .buttonBorderShape(.capsule)
                                    .controlSize(.small)
                                    .tint(nil)
                                    .contentShape(.capsule)
                            }
                            Button("Turn off") { confirm = .computerOff }
                                .buttonStyle(.borderless)
                                .controlSize(.small)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .contentShape(.rect)
                        }
                    }
                    if canGetComputer {
                        HStack(alignment: .center, spacing: JunoSpace.cozy) {
                            JunoIconView(.monitor, size: 16)
                                .foregroundStyle(Color.junoSecondaryInk)
                            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                                Text("A computer of its own")
                                    .junoType(.body)
                                    .foregroundStyle(Color.junoForeground)
                                Text("To sign in to sites, run code and keep files.")
                                    .junoType(.ui)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: JunoSpace.snug)
                            Button("Give it one") { confirm = .computerOn }
                                .buttonStyle(.junoGlass)
                                .buttonBorderShape(.capsule)
                                .controlSize(.small)
                                .tint(nil)
                                .disabled(busy == "computer")
                                .contentShape(.capsule)
                        }
                    }
                    ForEach(agent.connectorIDs, id: \.self) { id in
                        NativeAgentRemovableRow(label: "Remove", icon: false, disabled: busy == "app-\(id)") {
                            Text(appName(id))
                                .junoType(.body)
                                .foregroundStyle(Color.junoForeground)
                        } remove: {
                            act("app-\(id)") {
                                await model.update(id: agent.id, NativeAgentPatch(connectorIDs: agent.connectorIDs.filter { $0 != id }))
                            }
                        }
                    }
                }
            }
        }
    }

    /// "Run on": the cloud, or a Mac through the Work relay. The web's
    /// `RunsOnSection`. Set by the person only; the agent's own tools cannot
    /// move it. Read against the Mac it is pinned to (`preferredHostID`), not
    /// just "a Mac": an agent pinned to another of the person's Macs is not
    /// labelled "This Mac", and this Mac's Work switch is only raised when its
    /// tasks would actually run here. Choosing this Mac points at the one
    /// switch that lets work run here, rather than granting anything itself.
    private func runsOn(_ agent: NativeAgent) -> some View {
        let placement = NativeAgentMacPlacement.of(
            preferredHostID: agent.preferredHostID,
            thisMacHostID: thisMac?.hostID
        )
        return NativeAgentProfileSection(title: "Runs on") {
            Picker(
                "Runs on",
                selection: Binding(
                    get: { agent.executionTarget },
                    set: { target in chooseTarget(target, for: agent) }
                )
            ) {
                Text("Cloud").tag(NativeAgentExecutionTarget.cloud)
                Text(
                    Self.macSegmentTitle(
                        target: agent.executionTarget,
                        placement: placement,
                        onMac: thisMac != nil,
                        thisMacHostID: thisMac?.hostID
                    )
                )
                .tag(NativeAgentExecutionTarget.mac)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 260, alignment: .leading)
            .disabled(busy == "runs-on")
            .accessibilityIdentifier("juno.agents.profile.runs-on")
            Text(Self.runsOnWords(agent.executionTarget))
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.cozy)
            if agent.executionTarget == .cloud, agent.cloudWorkAvailable == false {
                Text("No cloud worker is running, so tasks can't start.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoWarningInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.hairline)
            }
            if agent.executionTarget == .mac, let thisMac {
                if placement == .anotherMac {
                    // Its tasks go to the Mac it is pinned to, wherever this
                    // profile is open; this Mac's Work switch has no bearing.
                    Text("\(agent.name) runs on another of your Macs.")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.hairline)
                    if let hostID = thisMac.hostID {
                        NativeAgentQuietLink(title: "Use this Mac instead") {
                            useThisMac(hostID, for: agent, thisMac: thisMac)
                        }
                            .disabled(busy == "runs-on")
                            .padding(.top, JunoSpace.hairline)
                            .accessibilityIdentifier("juno.agents.profile.use-this-mac")
                    }
                } else if !thisMac.workAllowed {
                    Text("Work is switched off on this Mac, so \(agent.name)'s tasks can't start here yet.")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoWarningInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.hairline)
                    NativeAgentQuietLink(title: "Allow work on this Mac") {
                        Task { @MainActor in thisMac.allowWork() }
                    }
                        .padding(.top, JunoSpace.hairline)
                        .accessibilityIdentifier("juno.agents.profile.allow-work")
                }
            }
            if listsMacs && (agent.executionTarget == .mac || choosingMac) {
                macList(agent)
            }
        }
    }

    /// Whether this device picks the Mac from a list: it cannot name itself as
    /// the Mac. The iPhone (no `thisMac`), and a Mac not paired for Work yet
    /// (`thisMac.hostID == nil`), whose "Your Mac" sends no host and so meets
    /// the same "Pick which Mac" refusal the iPhone does.
    private var listsMacs: Bool { NativeAgentMacChoice.listsMacs(thisMacHostID: thisMac?.hostID) }

    /// Which Mac, on a device that cannot name itself as the Mac
    /// (`listsMacs`): the web's Mac list under "Your Mac". Shown while the
    /// agent runs on a Mac, and from the moment "Your Mac" is chosen, so a move
    /// the server refuses for want of a named Mac (an agent with routines, on
    /// an account with several Macs: "Pick which Mac") is one pick away instead
    /// of a dead end. Picking sends the target and the Mac together, as the
    /// web's `chooseMac` does; "Any of your Macs" sends `preferredHostId: null`
    /// and clears a stored Mac. With no list to offer, it says where the choice
    /// can be made instead.
    @ViewBuilder
    private func macList(_ agent: NativeAgent) -> some View {
        let hosts = model.workHosts
        let chosen = NativeAgentMacChoice.chosen(
            target: agent.executionTarget,
            preferredHostID: agent.preferredHostID,
            among: hosts
        )
        Group {
            if !hosts.isEmpty {
                if agent.executionTarget != .mac {
                    Text(NativeAgentMacChoice.pickMac)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.hairline)
                }
                Picker(
                    "Which Mac",
                    selection: Binding<String?>(
                        get: { chosen },
                        set: { id in chooseMac(id, for: agent) }
                    )
                ) {
                    if NativeAgentMacChoice.offersAnyMac(chosen: chosen, hostCount: hosts.count) {
                        Text(NativeAgentMacChoice.anyMac).tag(String?.none)
                    }
                    ForEach(hosts) { host in
                        Text(verbatim: "\(host.displayName) · \(NativeAgentMacChoice.stateWords(host))")
                            .tag(Optional(host.hostID))
                    }
                }
                .pickerStyle(.menu)
                .disabled(busy == "runs-on")
                .padding(.top, JunoSpace.hairline)
                .accessibilityIdentifier("juno.agents.profile.which-mac")
            } else {
                Text(
                    NativeAgentMacChoice.emptyWords(
                        canList: model.canListWorkHosts,
                        loaded: model.workHostsLoaded,
                        failed: model.workHostsLoadFailed
                    )
                )
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.hairline)
            }
        }
        .task(id: agent.id) { await model.loadWorkHosts() }
    }

    private func chooseTarget(_ target: NativeAgentExecutionTarget, for agent: NativeAgent) {
        guard target != agent.executionTarget else { return }
        // Where the Mac is picked from a list (the iPhone, or a Mac not paired
        // yet) it opens with the choice, so a move refused for want of a named
        // Mac is one pick away (`macList`).
        if listsMacs { choosingMac = target == .mac }
        // On this Mac, prefer this Mac; elsewhere any Mac switched on for Work.
        // A nil host sends nothing, so a Mac chosen on the web stays chosen.
        let host = target == .mac ? thisMac?.hostID : nil
        // Whether its tasks will run here once saved: pinned here now, or
        // pinned nowhere and so free to.
        let runsHere = host != nil || agent.preferredHostID == nil
        act("runs-on") {
            let saved = await model.update(
                id: agent.id,
                NativeAgentPatch(executionTarget: target, preferredHostID: host)
            )
            // The switch is the person's to press, so this only takes them to it.
            if saved, target == .mac, runsHere, let thisMac, !thisMac.workAllowed {
                await thisMac.allowWork()
            }
        }
    }

    /// Points the agent at one of the account's Macs from the list, or at any
    /// of them (`hostID` nil): that choice alone when it already runs on a
    /// Mac, the target and the choice together otherwise
    /// (`NativeAgentMacChoice.patch`), as the web's `chooseMac` sends them.
    private func chooseMac(_ hostID: String?, for agent: NativeAgent) {
        guard
            let patch = NativeAgentMacChoice.patch(
                hostID,
                target: agent.executionTarget,
                preferredHostID: agent.preferredHostID
            )
        else { return }
        act("runs-on") { await model.update(id: agent.id, patch) }
    }

    /// Points an agent already set to run on a Mac at this one, leaving where
    /// it runs alone: only `preferredHostID` is sent.
    private func useThisMac(_ hostID: String, for agent: NativeAgent, thisMac: NativeAgentThisMac) {
        act("runs-on") {
            let saved = await model.update(id: agent.id, NativeAgentPatch(preferredHostID: hostID))
            if saved, !thisMac.workAllowed {
                await thisMac.allowWork()
            }
        }
    }

    private func footer(_ agent: NativeAgent) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Button(agent.isPaused ? "Resume" : "Pause") {
                act("pause") { await model.setPaused(id: agent.id, paused: !agent.isPaused) }
            }
            .buttonStyle(.junoGlass)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .tint(nil)
            .disabled(busy == "pause")
            .contentShape(.capsule)
            Button("Retire") { confirm = .retire }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentShape(.rect)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, JunoSpace.vast)
    }

    // MARK: Actions

    private func act(_ key: String, _ work: @escaping () async -> Void) {
        busy = key
        Task {
            await work()
            if busy == key { busy = nil }
            model.clearMutationMessage()
        }
    }

    private func decide(_ idea: NativeAgentIdea, _ action: NativeAgentIdeaAction) {
        busy = idea.id
        Task {
            let outcome = await model.decideIdea(agentID: agentID, ideaID: idea.id, action: action)
            busy = nil
            if case .needsConfirmation(_, let message)? = outcome {
                costQuestion = NativeAgentCostQuestion(message: message, retry: .idea(idea.id))
            }
        }
    }

    private func startConfirmed(_ question: NativeAgentCostQuestion) {
        costQuestion = nil
        guard case .idea(let ideaID) = question.retry else { return }
        Task {
            _ = await model.decideIdea(agentID: agentID, ideaID: ideaID, action: .start, confirmExpensive: true)
        }
    }

    private func computer(_ action: String) {
        confirm = nil
        act("computer") {
            await model.computerAction(agentID: agentID, action: action)
            await model.loadDetail(id: agentID)
        }
    }

    private func retire() {
        confirm = nil
        Task {
            if await model.retire(id: agentID) { retired() }
        }
    }

    // MARK: Words

    /// The Mac segment's title, for the Mac it would mean. On the iPhone (no
    /// `thisMac`) it is always "Your Mac". For a cloud agent it names what
    /// choosing it does: "This Mac" once this Mac is paired (it pins the agent
    /// here). For a Mac agent it names the Mac it is pinned to: this one,
    /// another one, or none ("Your Mac", any switched-on Mac).
    static func macSegmentTitle(
        target: NativeAgentExecutionTarget,
        placement: NativeAgentMacPlacement,
        onMac: Bool,
        thisMacHostID: String?
    ) -> String {
        guard onMac else { return "Your Mac" }
        if target == .cloud { return thisMacHostID == nil ? "Your Mac" : "This Mac" }
        switch placement {
        case .thisMac: return "This Mac"
        case .anotherMac: return "Another Mac"
        case .anyMac: return "Your Mac"
        }
    }

    /// `RUNS_ON_COPY`.
    static func runsOnWords(_ target: NativeAgentExecutionTarget) -> String {
        switch target {
        case .cloud: "Works with your laptop closed."
        case .mac: "Needs the Alevr Mac app open. If your Mac is offline, tasks don't start."
        }
    }

    /// `ASKS_COPY`.
    static func asks(_ policy: JunoWorkPermissionPolicy) -> String {
        switch policy {
        case .conservative: "Asks before anything that changes something."
        case .balanced: "Works on its own and asks before anything important."
        case .permissive: "Just does it, and still asks before sending, paying or deleting."
        }
    }

    static func when(_ routine: NativeAgentRoutine, now: Date = Date()) -> String {
        guard routine.enabled else { return "Paused" }
        if let at = routine.nextRunAt {
            let schedule = routine.schedule.isEmpty ? "" : "\(routine.schedule). "
            return "\(schedule)Next \(NativeAgentFormat.upcoming(at, now: now))."
        }
        return routine.schedule
    }

    /// `computerWords`.
    static func computerWords(_ status: String) -> String {
        switch status {
        case "awake": "Awake"
        case "resting": "Resting. Opens instantly."
        case "waking", "starting": "Waking up"
        case "error": "Couldn’t be reached"
        default: "Asleep. Wakes when it starts working."
        }
    }

    /// A connected app by its name: the account's own label when it has one,
    /// else the web's `appName`.
    private func appName(_ id: String) -> String {
        if let label = apps.first(where: { $0.id == id })?.label { return label }
        return Self.appName(id)
    }

    static func appName(_ id: String) -> String {
        let known: [String: String] = [
            "gmail": "Gmail",
            "googlecalendar": "Google Calendar",
            "google_calendar": "Google Calendar",
            "googledrive": "Google Drive",
            "notion": "Notion",
            "slack": "Slack",
            "github": "GitHub",
            "linear": "Linear",
            "outlook": "Outlook",
        ]
        let key = id.lowercased().split(separator: ":").last.map(String.init) ?? id.lowercased()
        if let name = known[key] { return name }
        return key
            .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

// MARK: - Parts

/// A section of the profile: a quiet heading, then prose.
struct NativeAgentProfileSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, JunoSpace.cozy)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A line with a quiet way to take it away, shown under the pointer on the
/// Mac and always on the phone: "Forget this" on a note, "Remove" on an app.
private struct NativeAgentRemovableRow<Label: View>: View {
    let label: String
    let icon: Bool
    let disabled: Bool
    @ViewBuilder let content: () -> Label
    let remove: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: remove) {
                Group {
                    if icon {
                        JunoIconView(.close, size: 14)
                    } else {
                        Text(label).junoType(.ui)
                    }
                }
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(minWidth: NativeAgentMetrics.target, minHeight: icon ? NativeAgentMetrics.target : 22)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .help(label)
            .accessibilityLabel(label)
            #if os(macOS)
            .opacity(hovering ? 1 : 0)
            #endif
            .padding(.top, icon ? -4 : 0)
        }
        .onHover { hovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovering)
    }
}

/// A quiet text button: the secondary ink, the foreground under the pointer.
struct NativeAgentQuietLink: View {
    let title: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .junoType(.ui)
                .foregroundStyle(hovering ? Color.junoForeground : Color.junoSecondaryInk)
                .underline(hovering)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The profile's face: the presence at 88, pressed to change it. "Customize"
/// appears under the pointer.
private struct NativeAgentFaceButton: View {
    let agent: NativeAgent
    let customize: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: customize) {
            VStack(spacing: JunoSpace.cozy) {
                JunoAgentPresence(avatar: agent.avatar, state: agent.state, size: 88, spread: 0.55)
                    .scaleEffect(hovering ? JunoMotion.scaleFrom(1.04, reduceMotion: reduceMotion) : 1)
                Text("Customize")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    #if os(macOS)
                    .opacity(hovering ? 1 : 0)
                    #endif
            }
            .contentShape(.rect)
        }
        .buttonStyle(.junoAgentFace)
        .onHover { hovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: hovering)
        .help("Customize \(agent.name)")
        .accessibilityLabel("Customize \(agent.name)")
    }
}

/// Changing the face: the builder, the face as it will be, and Save.
private struct NativeAgentFaceSheet: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let done: () -> Void

    @State private var avatar: JunoAgentAvatar

    init(model: NativeAgentsModel, agent: NativeAgent, done: @escaping () -> Void) {
        self.model = model
        self.agent = agent
        self.done = done
        _avatar = State(initialValue: agent.avatar)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            HStack(spacing: JunoSpace.regular) {
                JunoAgentPresence(avatar: avatar, state: .idle, size: 64, spread: 0.4)
                Text("\(agent.name)’s face")
                    .junoType(.title)
                    .foregroundStyle(Color.junoForeground)
            }
            NativeAgentFaceBuilder(avatar: $avatar)
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel", action: done)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
                Button("Save") {
                    Task {
                        var saved = avatar == agent.avatar
                        if !saved {
                            saved = await model.update(id: agent.id, NativeAgentPatch(avatar: avatar))
                        }
                        if saved {
                            model.clearMutationMessage()
                            done()
                        }
                    }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .contentShape(.rect)
            }
        }
        .padding(JunoSpace.section)
        .frame(minWidth: 420)
        .junoAgentGazeField()
    }
}

/// Which Mac an agent set to run on a Mac uses, seen from the Mac showing its
/// profile: none named (any Mac switched on for Work), this one, or another.
enum NativeAgentMacPlacement: Equatable {
    case anyMac
    case thisMac
    case anotherMac

    static func of(preferredHostID: String?, thisMacHostID: String?) -> NativeAgentMacPlacement {
        guard let preferredHostID else { return .anyMac }
        return preferredHostID == thisMacHostID ? .thisMac : .anotherMac
    }
}

/// The "Which Mac" list for an agent on a device that cannot name itself as
/// the Mac (the web's Mac list under "Your Mac" in `RunsOnSection`), as rules
/// with no view in them.
enum NativeAgentMacChoice {
    /// `RUNS_ON_MESSAGE` (agent-panel.tsx), word for word.
    static let anyMac = "Any of your Macs"
    static let pickMac = "Pick the Mac it should use."
    static let checking = "Checking your Macs…"
    static let noMac = "No Mac is set up yet. Open the Alevr Mac app and turn on Allow Alevr Work on this Mac."
    /// Where the choice can be made when this device cannot list the Macs:
    /// never the dead end "Pick which Mac" with nothing to pick from.
    static let elsewhere = "Pick which Mac it uses in the Alevr Mac app or on the web."

    /// `runsOnHostLabel`: a Mac's line, in the words a refused task uses for
    /// the same state (`RUNS_ON_HOST_LABELS`).
    static func stateWords(_ host: WorkHostSummary) -> String {
        if !host.enabled || host.revokedAt != nil { return "Work is switched off on this Mac" }
        switch host.state {
        case "online", "idle": return "Online"
        case "stale": return "Not responding"
        default: return "Offline"
        }
    }

    /// The Mac shown as chosen: the preferred Mac while the agent runs on a
    /// Mac and that Mac is listed; else none ("Any of your Macs", or nothing
    /// picked yet).
    static func chosen(
        target: NativeAgentExecutionTarget,
        preferredHostID: String?,
        among hosts: [WorkHostSummary]
    ) -> String? {
        guard target == .mac, let preferredHostID, hosts.contains(where: { $0.hostID == preferredHostID }) else {
            return nil
        }
        return preferredHostID
    }

    /// Whether the list is shown here: on the iPhone (no Mac of its own) and
    /// on a Mac not paired for Work (no host id), which cannot be "This Mac".
    static func listsMacs(thisMacHostID: String?) -> Bool {
        thisMacHostID == nil
    }

    /// Whether "Any of your Macs" is a row, as on the web: when there is a
    /// choice to make (two Macs or more), or when it is what is in force (no
    /// Mac chosen). With one Mac and that Mac chosen there is nothing to clear.
    static func offersAnyMac(chosen: String?, hostCount: Int) -> Bool {
        chosen == nil || hostCount >= 2
    }

    /// What picking `hostID` sends, or nil when it is already the choice: the
    /// Mac alone for an agent already on a Mac, else the target and the Mac
    /// together, so a move refused for want of a named Mac goes through.
    /// `hostID` nil is "Any of your Macs": `preferredHostId: null`, which
    /// clears a stored Mac, as the web's `chooseMac(null)` sends it. Measured
    /// against the stored preference, not the row shown, like `macChoiceSaves`.
    static func patch(
        _ hostID: String?,
        target: NativeAgentExecutionTarget,
        preferredHostID: String?
    ) -> NativeAgentPatch? {
        guard let hostID else {
            if target == .mac {
                return preferredHostID == nil ? nil : NativeAgentPatch(clearsPreferredHost: true)
            }
            return NativeAgentPatch(executionTarget: .mac, clearsPreferredHost: true)
        }
        if target == .mac {
            return hostID == preferredHostID ? nil : NativeAgentPatch(preferredHostID: hostID)
        }
        return NativeAgentPatch(executionTarget: .mac, preferredHostID: hostID)
    }

    /// The line in place of the list when there are no Macs to show: still
    /// reading, none paired, or (no Work client, or the read failed) where
    /// else the choice can be made.
    static func emptyWords(canList: Bool, loaded: Bool, failed: Bool) -> String {
        guard canList, !failed else { return elsewhere }
        return loaded ? noMac : checking
    }
}

public extension EnvironmentValues {
    /// This Mac, for an agent's "Runs on" control. Nil off the Mac.
    @Entry var nativeAgentThisMac: NativeAgentThisMac? = nil
}
