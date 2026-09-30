import JunoDesignSystem
import JunoVoiceKit
import JunoWorkKit
import SwiftUI

/// What an agent's thread says about the agent (the web's
/// `agent-thread-header.tsx`), as pure rules a test can hold still.
enum DesktopAgentThread {
    /// The bar's second line: the thread's own state when it knows better
    /// than the roster ("Thinking" while a reply streams, "Listening" while a
    /// call is open), otherwise the roster's sentence, re-said locally when
    /// it names a time.
    static func sentence(for agent: NativeAgent, state: JunoAgentState?) -> String {
        NativeAgentThreadHeader.sentence(for: agent, state: state)
    }

    /// The empty thread's line, in the agent's own voice (`AgentGreeting`).
    /// No chips: the composer below is the invitation.
    static func greetingLine(for agent: NativeAgent) -> String {
        agent.status == .paused
            ? "I’m paused. Resume me from the menu above when you need me."
            : "Tell me what to take care of. I’ll set myself up and start."
    }
}

// MARK: - Header

/// The presence bar an agent's thread gains, above the transcript: the
/// shared ``NativeAgentThreadHeader`` (face on its halo, name, live sentence,
/// a faint wash of its colour; Computer, Profile and More), at the chat
/// column's measure. The host draws the hairline under it.
struct DesktopAgentThreadHeader: View {
    let agent: NativeAgent
    /// The thread's own state, when it knows better than the roster.
    var state: JunoAgentState? = nil
    /// While a call is open, the caller's voice level (0...1).
    var level: CGFloat = 0
    var model: NativeAgentsModel? = nil
    var apps: [NativeAgentAppChoice] = []
    var openThread: ((String) -> Void)? = nil
    var focusComposer: (() -> Void)? = nil
    var retired: (() -> Void)? = nil
    /// False when the host draws the wash across the whole column.
    var drawsWash = true
    let openAgent: () -> Void

    var body: some View {
        NativeAgentThreadHeader(
            agent: agent,
            state: state,
            level: level,
            model: model,
            apps: apps,
            openThread: openThread,
            focusComposer: focusComposer,
            retired: retired,
            drawsWash: drawsWash,
            openAgent: openAgent
        )
    }
}

// MARK: - Greeting

/// The empty thread greets in the agent's own voice instead of Juno's
/// (`AgentGreeting`): its face on its halo at 88, then "Hi, I’m *Iris*." in
/// the greeting's serif with the name in its italic, then one line in the
/// secondary ink. No chips.
///
/// The face is sleeping while the agent is paused and at rest otherwise.
struct DesktopAgentGreeting: View {
    let agent: NativeAgent
    /// The chat column's width, which the display size is fluid against.
    let columnWidth: CGFloat

    @Environment(\.junoTextScale) private var textScale

    var body: some View {
        let size = ChatGreeting.size(forColumnWidth: columnWidth)
        VStack(spacing: 0) {
            JunoAgentPresence(
                avatar: agent.avatar,
                state: agent.status == .paused ? .sleeping : .idle,
                size: 88,
                name: agent.name,
                spread: 0.6
            )
            .junoAgentFaceTrigger()
            Text("Hi, I’m \(Text(agent.name).font(JunoType.displayItalic(size: size).font(scale: textScale))).")
                .junoType(.display(size: size))
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, JunoSpace.region)
            Text(DesktopAgentThread.greetingLine(for: agent))
                .junoBodyLarge()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                // The web's `max-w-md`.
                .frame(maxWidth: 448)
                .padding(.top, JunoSpace.cozy)
        }
        .multilineTextAlignment(.center)
        .junoAgentGazeField()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.agent-greeting")
    }
}

/// Reads a call's voice level in a view of its own, so the level moving many
/// times a second redraws the presence bar and not the whole chat column.
struct DesktopAgentVoiceLevel<Content: View>: View {
    let controller: JunoRealtimeVoiceController?
    @ViewBuilder let content: (CGFloat) -> Content

    var body: some View {
        content(controller.map { $0.muted ? 0 : CGFloat($0.level) } ?? 0)
    }
}

// MARK: - Whose thread

/// Whose thread the transcript is, for the parts that speak as the agent
/// rather than as Juno (the web's `AgentThreadContext`): the pending row
/// ("Mira is thinking", with her face) and the byline on her replies. Nil in
/// every other chat.
struct DesktopAgentThreadIdentity: Equatable {
    let name: String
    let avatar: JunoAgentAvatar

    init(_ agent: NativeAgent) {
        name = agent.name
        avatar = agent.avatar
    }
}

extension EnvironmentValues {
    @Entry var desktopAgentThread: DesktopAgentThreadIdentity? = nil
}

/// A reply's byline in an agent's thread: its face at 20 and its name.
struct DesktopAgentByline: View {
    let identity: DesktopAgentThreadIdentity

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoAgentFace(avatar: identity.avatar, state: .idle, size: JunoAgentFaceSize.xs, live: false)
            Text(identity.name)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
        }
        .accessibilityHidden(true)
    }
}

/// The pending row in an agent's thread, before any work shows: the agent's
/// face thinking and "<Name> is thinking" with the slow light, in place of
/// Juno's own.
struct DesktopAgentPendingRow: View {
    let identity: DesktopAgentThreadIdentity

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoAgentFace(avatar: identity.avatar, state: .thinking, size: JunoAgentFaceSize.sm)
            JunoAgentStatusLine("\(identity.name) is thinking", state: .thinking, type: .ui)
        }
        .frame(minHeight: 40)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(identity.name) is thinking")
    }
}
