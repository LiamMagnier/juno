import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// What an agent's thread says about the agent (DIRECTION.md, Agent thread),
/// as pure rules a test can hold still.
enum DesktopAgentThread {
    /// The header's second line: the thread's own state when it knows better
    /// than the roster ("Thinking" while a reply streams, "Listening" while a
    /// call is open), otherwise the roster's sentence, re-said locally when it
    /// names a time.
    static func sentence(for agent: NativeAgent, state: JunoAgentState?) -> String {
        NativeAgentThreadHeader.sentence(for: agent, state: state)
    }

    /// The empty thread's second line, in the agent's own voice.
    static func greetingLine(for agent: NativeAgent) -> String {
        agent.status == .paused
            ? "I’m paused. Resume me from my profile to start something new."
            : "Tell me what to take care of. I’ll set myself up."
    }
}

// MARK: - Header

/// The presence header above an agent's transcript: the shared
/// ``NativeAgentThreadHeader`` (face 40 on its halo, the name, the live
/// sentence, Computer, Profile and the menu) at the reading measure. Chrome
/// drawn as content, opaque, over the column's hairline, which the host draws.
struct DesktopAgentThreadHeader: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    /// The thread's own state, when it knows better than the roster.
    var state: JunoAgentState? = nil
    let openProfile: () -> Void

    var body: some View {
        NativeAgentThreadHeader(model: model, agent: agent, state: state, openProfile: openProfile)
    }
}

// MARK: - Greeting

/// The empty thread greets in the agent's own voice instead of Juno's: the
/// face at 96 on its halo, "Hi, I'm Iris." in the display italic, one line of
/// promise and three suggestions that fill the composer. The shared
/// ``NativeAgentGreeting`` at the display size the column's width gives.
struct DesktopAgentGreeting: View {
    let agent: NativeAgent
    /// The chat column's width, which the display size is fluid against.
    let columnWidth: CGFloat
    /// Fills the composer with a suggestion; nil leaves them out.
    var pick: ((String) -> Void)? = nil

    var body: some View {
        NativeAgentGreeting(
            agent: agent,
            displaySize: ChatGreeting.size(forColumnWidth: columnWidth),
            pick: pick
        )
        .accessibilityIdentifier("juno.desktop.chat.agent-greeting")
    }
}
