import Foundation
import JunoDesignSystem
import SwiftUI

/// The one row an agent's thread gains (AGENTS.md §5.3): the face, the name,
/// what it is doing in words, and — pressed — its page. The web's
/// `AgentThreadHeader`.
///
/// The dot is the row's one trailing signal and appears only while the agent
/// needs the person. The face is decorative here because the name and the
/// sentence are printed beside it, and the row says both as one label.
///
/// The host places it, pads it and draws any hairline under it: the Mac's
/// chat column and the phone's thread have different chrome, and this row
/// should not guess at either.
public struct NativeAgentThreadHeader: View {
    private let agent: NativeAgent
    private let state: JunoAgentState?
    private let openAgent: () -> Void

    /// - Parameters:
    ///   - state: the thread's own state when it knows better than the roster
    ///     — thinking while a reply streams, listening while a call is open.
    ///     Nil shows the agent's.
    ///   - openAgent: opens the agent's page.
    public init(
        agent: NativeAgent,
        state: JunoAgentState? = nil,
        openAgent: @escaping () -> Void
    ) {
        self.agent = agent
        self.state = state
        self.openAgent = openAgent
    }

    private var shownState: JunoAgentState {
        state ?? agent.state
    }

    /// The roster's sentence, unless the thread knows a state the roster does
    /// not: then that state's own word, rather than a sentence about a task
    /// the thread is not doing.
    private var sentence: String {
        guard let state, state != agent.state else {
            return NativeAgentFormat.stateSentence(for: agent)
        }
        return state.label
    }

    public var body: some View {
        Button(action: openAgent) {
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                JunoAgentFace(avatar: agent.avatar, state: shownState, size: JunoAgentFaceSize.sm)
                VStack(alignment: .leading, spacing: 0) {
                    Text(agent.name)
                        .font(.callout.weight(.medium))
                        .junoInk()
                        .lineLimit(1)
                    Text(sentence)
                        .junoCaption()
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: JunoSpace.snug)
                if shownState == .waiting {
                    NativeAgentNeedsYouDot()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Open \(agent.name)’s page")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence)"))
        .accessibilityHint("Opens its page")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("juno.agents.thread-header")
    }
}
