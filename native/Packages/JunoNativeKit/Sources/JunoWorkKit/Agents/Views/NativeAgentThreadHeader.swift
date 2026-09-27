import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The presence header an agent's thread gains (DIRECTION.md, Agent thread):
/// the face at 40 on its halo, the name, and one live sentence. On the right,
/// Computer (only when it has one) and Profile, and a menu with Pause or
/// Resume, Pin and Retire. The thread is the agent; this row is its presence.
///
/// While the agent is at its computer the row says so quietly, "Using its
/// computer", and the Computer button opens the full-screen view.
///
/// The host places it, pads it and draws any hairline under it: the Mac's
/// chat column and the phone's thread have different chrome.
public struct NativeAgentThreadHeader: View {
    private let model: NativeAgentsModel
    private let agent: NativeAgent
    private let state: JunoAgentState?
    private let openProfile: () -> Void

    @State private var showingComputer = false
    @State private var confirmingRetire = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - state: the thread's own state when it knows better than the roster:
    ///     thinking while a reply streams, listening while a call is open. Nil
    ///     shows the agent's.
    ///   - openProfile: presents the agent's profile sheet.
    public init(
        model: NativeAgentsModel,
        agent: NativeAgent,
        state: JunoAgentState? = nil,
        openProfile: @escaping () -> Void
    ) {
        self.model = model
        self.agent = agent
        self.state = state
        self.openProfile = openProfile
    }

    private var shownState: JunoAgentState {
        if agent.isPaused, state == nil { return .sleeping }
        return state ?? agent.state
    }

    /// The roster's sentence, unless the thread knows a state the roster does
    /// not: then that state's own word.
    private var sentence: String {
        #if os(iOS)
        // No room beside the buttons on a phone: the live line says it.
        if usingComputer, state == nil, agent.state != .waiting { return "Using its computer" }
        #endif
        return Self.sentence(for: agent, state: state)
    }

    /// The header's second line, as a rule a test can hold still: the
    /// thread's own state when it knows better than the roster, otherwise the
    /// roster's sentence, re-said locally when it names a time.
    public nonisolated static func sentence(for agent: NativeAgent, state: JunoAgentState?) -> String {
        guard let state, state != agent.state else {
            return NativeAgentFormat.stateSentence(for: agent)
        }
        return state.label
    }

    private var hasComputer: Bool { model.computer(for: agent.id) != nil }
    private var usingComputer: Bool { model.isUsingComputer(agent.id) }

    public var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            Button(action: openProfile) {
                HStack(alignment: .center, spacing: JunoSpace.cozy) {
                    NativeAgentPresence(
                        avatar: agent.avatar,
                        state: shownState,
                        size: NativeAgentMetrics.headerFace
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(agent.name)
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                            if shownState == .waiting {
                                NativeAgentNeedsYouDot()
                            }
                            Text(sentence)
                                .junoType(.ui)
                                .foregroundStyle(shownState == .waiting ? Color.junoForeground : Color.junoSecondaryInk)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .contentTransition(.opacity)
                        }
                        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: sentence)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("\(agent.name)’s profile")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence)"))
            .accessibilityHint("Opens its profile")
            .accessibilityAddTraits(.isButton)

            Spacer(minLength: JunoSpace.snug)

            #if os(macOS)
            if usingComputer {
                Text("Using its computer")
                    .junoType(.ui)
                    .lineLimit(1)
                    .foregroundStyle(Color.junoTertiaryInk)
                .transition(.opacity)
            }
            #endif

            HStack(spacing: JunoSpace.micro) {
                if hasComputer {
                    NativeAgentIconButton(icon: .monitor, label: "Computer") { showingComputer = true }
                }
                NativeAgentIconButton(icon: .userCircle, label: "Profile", action: openProfile)
                menu
            }
        }
        .frame(minHeight: 52)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint), value: usingComputer)
        .task(id: agent.id) { await follow() }
        .onChange(of: sentence) { _, now in
            AccessibilityNotification.Announcement(now).post()
        }
        .nativeAgentComputerPresentation(isPresented: $showingComputer, model: model, agent: agent)
        .confirmationDialog(
            "Retire \(agent.name)?",
            isPresented: $confirmingRetire,
            titleVisibility: .visible
        ) {
            Button("Retire", role: .destructive) {
                Task { await model.retire(id: agent.id) }
            }
            .contentShape(.rect)
            Button("Cancel", role: .cancel) {}
                .contentShape(.rect)
        } message: {
            Text("Its routines stop and it leaves your agents. This thread stays, as an ordinary chat.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.agents.thread-header")
    }

    private var menu: some View {
        Menu {
            Button(agent.isPaused ? "Resume" : "Pause") {
                Task { await model.setPaused(id: agent.id, paused: !agent.isPaused) }
            }
            Button(agent.isPinned ? "Unpin" : "Pin") {
                Task { await model.setPinned(id: agent.id, pinned: !agent.isPinned) }
            }
            Divider()
            Button(nativeAgentMenuTitle("Retire…"), role: .destructive) { confirmingRetire = true }
        } label: {
            JunoIconView(.ellipsis, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More for \(agent.name)")
    }

    /// Reads its profile on arrival, so the header knows whether it has a
    /// computer, then keeps "Using its computer" honest while it has one.
    private func follow() async {
        await model.loadDetail(id: agent.id)
        while !Task.isCancelled, model.computer(for: agent.id) != nil {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await model.loadDetail(id: agent.id)
        }
    }
}

// MARK: - The empty thread

/// An agent's empty thread greets in its own voice: the face at 96 on its
/// halo, "Hi, I'm Wren." in the display italic, one line of promise, and
/// three suggestions that fill the composer.
public struct NativeAgentGreeting: View {
    private let agent: NativeAgent
    private let displaySize: CGFloat
    private let pick: ((String) -> Void)?

    /// - Parameters:
    ///   - displaySize: the headline's size, fluid against the column on the
    ///     Mac.
    ///   - pick: fills the composer with a suggestion. Nil leaves them out.
    public init(agent: NativeAgent, displaySize: CGFloat, pick: ((String) -> Void)? = nil) {
        self.agent = agent
        self.displaySize = displaySize
        self.pick = pick
    }

    private var promise: String {
        agent.isPaused
            ? "I’m paused. Resume me from my profile to start something new."
            : "Tell me what to take care of. I’ll set myself up."
    }

    public var body: some View {
        VStack(spacing: 0) {
            NativeAgentPresence(
                avatar: agent.avatar,
                state: agent.isPaused ? .sleeping : .idle,
                size: NativeAgentMetrics.profileFace,
                name: agent.name
            )
            Text(NativeAgentFormat.greeting(for: agent))
                .junoDisplayItalic(displaySize)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, JunoSpace.section)
            Text(promise)
                .junoBodyLarge()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 448)
                .padding(.top, JunoSpace.cozy)
            if let pick, !agent.isPaused {
                NativeAgentSuggestionList(lines: NativeAgentSuggestions.forAgent(agent), pick: pick)
                    .padding(.top, JunoSpace.roomy)
            }
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.agents.greeting")
    }
}
