import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// What an agent's thread says about the agent (AGENTS.md §5.3, the web's
/// `agent-thread-header.tsx`), as pure rules a test can hold still.
enum DesktopAgentThread {
    /// The header's second line: the thread's own state when it knows better
    /// than the roster — "Thinking" while a reply streams, "Listening" while
    /// a call is open — otherwise the roster's sentence, re-said locally when
    /// it names a time. The web's `localStateSentence(agent, state)`.
    static func sentence(for agent: NativeAgent, state: JunoAgentState?) -> String {
        guard let state, state != agent.state else {
            return NativeAgentFormat.stateSentence(for: agent)
        }
        return state.label
    }

    /// The empty thread's second line, in the agent's own voice.
    static func greetingLine(for agent: NativeAgent) -> String {
        if agent.status == .paused {
            return "I’m paused. Resume me from my page to start something new."
        }
        let role = agent.role.trimmingCharacters(in: .whitespacesAndNewlines)
        return role.isEmpty ? "What should I take on?" : "\(role). What should I take on?"
    }
}

// MARK: - Header

/// The one row an agent's thread gains, above the transcript: the face in its
/// live state, the name, what it is doing in words, and its page.
///
/// Chrome drawn as content — opaque, no glass — at the reading measure over
/// the column's hairline (the host draws the rule). The face and "Agent page"
/// both open the page, as on the web: the face is the thing a person reaches
/// for, the words are the thing a keyboard finds.
///
/// "Agent page" is the web's quiet text button — the secondary ink, lifting
/// to the foreground on a hover fill — not an accent link (Stage C notes).
struct DesktopAgentThreadHeader: View {
    let agent: NativeAgent
    /// The thread's own state, when it knows better than the roster.
    var state: JunoAgentState? = nil
    let openAgent: () -> Void

    @State private var isHoveringPage = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var sentence: String { DesktopAgentThread.sentence(for: agent, state: state) }

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            Button(action: openAgent) {
                JunoAgentFace(avatar: agent.avatar, state: state ?? agent.state, size: JunoAgentFaceSize.sm)
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Open \(agent.name)’s page")
            .accessibilityLabel("\(agent.name)’s page")

            VStack(alignment: .leading, spacing: 0) {
                Text(agent.name)
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(sentence)
                    .junoFont(size: 11, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: sentence)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            Button(action: openAgent) {
                Text("Agent page")
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(isHoveringPage ? Color.junoForeground : Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(minHeight: 28)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                            .fill(isHoveringPage ? Color.junoHover : Color.clear)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                    isHoveringPage = hovering
                }
            }
            .help("Open \(agent.name)’s page")
        }
        .frame(minHeight: 44)
        // Said when it changes, as the web's `aria-live="polite"` line is.
        .onChange(of: sentence) { _, now in
            AccessibilityNotification.Announcement(now).post()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.agents.thread-header")
    }
}

// MARK: - Greeting

/// The empty thread greets in the agent's own voice instead of Juno's
/// (`AgentGreeting`): the face at `lg`, then "Hi, I’m *Iris*." in the
/// greeting's serif — the one serif site — with the name in its italic, then
/// the role and "What should I take on?" in the secondary ink.
///
/// It replaces "How can I help, *Name*?" in an agent's empty thread only.
/// The face is sleeping while the agent is paused and at rest otherwise: a
/// greeting is not a live state, and an idle face never loops.
struct DesktopAgentGreeting: View {
    let agent: NativeAgent
    /// The chat column's width, which the display size is fluid against.
    let columnWidth: CGFloat

    @Environment(\.junoTextScale) private var textScale

    var body: some View {
        let size = ChatGreeting.size(forColumnWidth: columnWidth)
        VStack(spacing: 0) {
            JunoAgentFace(
                avatar: agent.avatar,
                state: agent.status == .paused ? .sleeping : .idle,
                size: JunoAgentFaceSize.lg,
                name: agent.name
            )
            Text("Hi, I’m \(Text(agent.name).font(JunoType.displayItalic(size: size).font(scale: textScale))).")
                .junoType(.display(size: size))
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, JunoSpace.roomy)
            Text(DesktopAgentThread.greetingLine(for: agent))
                .junoBodyLarge()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                // The web's `max-w-md`.
                .frame(maxWidth: 448)
                .padding(.top, JunoSpace.snug)
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.agent-greeting")
    }
}
