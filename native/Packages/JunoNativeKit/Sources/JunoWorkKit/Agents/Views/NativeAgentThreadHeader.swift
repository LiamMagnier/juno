import Foundation
import JunoDesignSystem
import SwiftUI

/// The presence bar an agent's thread gains (the web's `AgentThreadHeader`):
/// its live face on its halo, its name and the one sentence it is living
/// right now, over a faint wash of its own colour. Pressing the face opens
/// its profile. On the right: its computer (when it has one), the profile,
/// and More (Pause, Pin, Duplicate, Retire).
///
/// Attention is said the one way: the sentence in the accent with a hand.
/// No dot, no pill, no count.
///
/// The host places it, pads it and draws any hairline under it: the Mac's
/// chat column and the phone's thread have different chrome, and this bar
/// should not guess at either. Given no model it is the bar alone, and the
/// face calls `openAgent`.
public struct NativeAgentThreadHeader: View {
    private let agent: NativeAgent
    private let state: JunoAgentState?
    private let level: CGFloat
    private let model: NativeAgentsModel?
    private let apps: [NativeAgentAppChoice]
    private let openThread: ((String) -> Void)?
    private let focusComposer: (() -> Void)?
    private let retired: (() -> Void)?
    private let drawsWash: Bool
    private let openAgent: () -> Void

    @State private var showingProfile = false
    @State private var showingComputer = false
    @State private var confirmingRetire = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - state: the thread's own state when it knows better than the roster:
    ///     thinking while a reply streams, listening while a call is open.
    ///     Nil shows the agent's.
    ///   - level: while listening, the caller's voice level (0...1).
    ///   - model: the agents model, for the profile, the computer and the
    ///     menu. Nil draws the bar alone.
    ///   - apps: the account's connected apps, by name, for the profile.
    ///   - openThread: opens a conversation by id: a duplicate's new thread.
    ///   - focusComposer: the profile's Message, after it closes.
    ///   - retired: after it retired, to leave its thread.
    ///   - drawsWash: false when the host draws ``NativeAgentBarWash`` across
    ///     a wider row itself.
    ///   - openAgent: the face's action when there is no model.
    public init(
        agent: NativeAgent,
        state: JunoAgentState? = nil,
        level: CGFloat = 0,
        model: NativeAgentsModel? = nil,
        apps: [NativeAgentAppChoice] = [],
        openThread: ((String) -> Void)? = nil,
        focusComposer: (() -> Void)? = nil,
        retired: (() -> Void)? = nil,
        drawsWash: Bool = true,
        openAgent: @escaping () -> Void = {}
    ) {
        self.agent = agent
        self.state = state
        self.level = level
        self.model = model
        self.apps = apps
        self.openThread = openThread
        self.focusComposer = focusComposer
        self.retired = retired
        self.drawsWash = drawsWash
        self.openAgent = openAgent
    }

    private var shownState: JunoAgentState { state ?? agent.state }

    /// The roster's sentence, unless the thread knows a state the roster does
    /// not: then that state's own word.
    public nonisolated static func sentence(for agent: NativeAgent, state: JunoAgentState?) -> String {
        guard let state, state != agent.state else {
            return NativeAgentFormat.stateSentence(for: agent)
        }
        return state.label
    }

    private var sentence: String { Self.sentence(for: agent, state: state) }

    private var attention: Bool {
        shownState == .waiting || shownState == .blocked || agent.needsYou > 0
    }

    private var hasComputer: Bool {
        guard let detail = model?.details[agent.id], detail.computerConfigured, let computer = detail.computer else {
            return false
        }
        return computer.enabled && computer.status != "disabled"
    }

    public var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            Button(action: openProfile) {
                HStack(alignment: .center, spacing: JunoSpace.cozy) {
                    JunoAgentPresence(avatar: agent.avatar, state: shownState, size: 34, spread: 0.4, level: level)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(agent.name)
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                        if attention {
                            NativeAgentNeedsYouLine(sentence: sentence, type: JunoType.caption.weight(.medium), iconSize: 12)
                        } else {
                            JunoAgentStatusLine(sentence, state: shownState, type: .caption)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, JunoSpace.micro)
                .padding(.trailing, JunoSpace.snug)
                .contentShape(.rect)
            }
            .buttonStyle(.junoAgentFace)
            .help("Open \(agent.name)’s profile")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence). Open profile"))
            .accessibilityAddTraits(.isButton)

            if model != nil {
                HStack(spacing: JunoSpace.micro) {
                    if hasComputer {
                        NativeAgentBarButton(icon: .monitor, label: "\(agent.name)’s computer", help: "Computer") {
                            showingComputer = true
                        }
                    }
                    NativeAgentBarButton(icon: .panelRight, label: "Profile", help: "Profile", action: openProfile)
                    menu
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(alignment: .leading) { wash }
        .onChange(of: sentence) { _, now in
            AccessibilityNotification.Announcement(now).post()
        }
        .sheet(isPresented: $showingProfile) {
            if let model {
                NativeAgentProfileView(
                    model: model,
                    agentID: agent.id,
                    apps: apps,
                    message: {
                        showingProfile = false
                        focusComposer?()
                    },
                    openComputer: {
                        showingProfile = false
                        showingComputer = true
                    },
                    close: { showingProfile = false },
                    retired: {
                        showingProfile = false
                        retired?()
                    }
                )
                #if os(macOS)
                .frame(width: 480, height: 680)
                #else
                .presentationDetents([.large])
                #endif
            }
        }
        .sheet(isPresented: $showingComputer) {
            if let model {
                NativeAgentComputerSheet(model: model, agentID: agent.id, done: { showingComputer = false })
            }
        }
        .confirmationDialog("Retire \(agent.name)?", isPresented: $confirmingRetire, titleVisibility: .visible) {
            Button("Retire \(agent.name)", role: .destructive) {
                Task {
                    if await model?.retire(id: agent.id) == true { retired?() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its routines and tasks stop and it leaves your team. This conversation stays in your history.")
        }
        .task(id: agent.id) {
            // The computer button needs the page's detail.
            if let model, model.details[agent.id] == nil { await model.loadDetail(id: agent.id) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.agents.thread-header")
    }

    @ViewBuilder
    private var wash: some View {
        if drawsWash {
            NativeAgentBarWash(avatar: agent.avatar)
        }
    }

    private var menu: some View {
        Menu {
            Button(action: togglePause) {
                Label(agent.isPaused ? "Resume" : "Pause", icon: agent.isPaused ? .play : .pause)
            }
            Button(action: togglePin) {
                Label(agent.isPinned ? "Unpin" : "Pin", icon: agent.isPinned ? .pinOff : .pin)
            }
            Button(action: duplicate) {
                Label("Duplicate", icon: .copy)
            }
            Divider()
            Button(role: .destructive) {
                confirmingRetire = true
            } label: {
                Label("Retire", icon: .archive)
            }
        } label: {
            JunoIconView(.more, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("\(agent.name) actions")
    }

    private func openProfile() {
        if model != nil {
            showingProfile = true
        } else {
            openAgent()
        }
    }

    private func togglePause() {
        guard let model else { return }
        Task { await model.setPaused(id: agent.id, paused: !agent.isPaused) }
    }

    private func togglePin() {
        guard let model else { return }
        Task { await model.setPinned(id: agent.id, pinned: !agent.isPinned) }
    }

    private func duplicate() {
        guard let model else { return }
        Task {
            guard let copy = await model.duplicate(id: agent.id) else { return }
            if let conversationID = copy.conversationID {
                openThread?(conversationID)
            } else if let conversationID = await model.threadConversationID(for: copy.id) {
                openThread?(conversationID)
            }
        }
    }
}

/// The bar's faint wash of the agent's own colour, from the face's side: the
/// web's `radial-gradient(60% 180% at 0% 0%, tone / 0.09, transparent 60%)`.
/// A host that pads the bar to a reading measure draws this across its full
/// width instead, so the wash runs edge to edge as the web's bar does.
public struct NativeAgentBarWash: View {
    private let avatar: JunoAgentAvatar

    public init(avatar: JunoAgentAvatar) {
        self.avatar = avatar
    }

    public var body: some View {
        LinearGradient(
            stops: [
                .init(color: avatar.tone.color.opacity(0.09), location: 0),
                .init(color: avatar.tone.color.opacity(0.03), location: 0.35),
                .init(color: avatar.tone.color.opacity(0), location: 0.6),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// An icon button on the bar: 28pt on the Mac, a hover fill, a tooltip.
struct NativeAgentBarButton: View {
    let icon: JunoIcon
    let label: String
    let help: String
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(hovering ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(hovering ? Color.junoHover : Color.clear)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovering)
        .help(help)
        .accessibilityLabel(label)
    }
}

/// The agent's computer in a sheet: watch it, take control, hand it back,
/// wake it, its files, reset. The existing computer view, given a frame.
public struct NativeAgentComputerSheet: View {
    private let model: NativeAgentsModel
    private let agentID: String
    private let done: () -> Void

    public init(model: NativeAgentsModel, agentID: String, done: @escaping () -> Void) {
        self.model = model
        self.agentID = agentID
        self.done = done
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let agent = model.agent(id: agentID) {
                ScrollView {
                    NativeAgentComputerView(model: model, agent: agent, computer: model.details[agentID]?.computer)
                        .padding(JunoSpace.section)
                }
            }
            HStack {
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
            .padding([.horizontal, .bottom], JunoSpace.section)
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 520)
        #endif
        .task(id: agentID) { await model.loadDetail(id: agentID) }
    }
}
