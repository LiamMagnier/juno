import Foundation
import JunoDesignSystem
import SwiftUI

/// **Agents** — the roster, each agent's page, and hiring (docs/design/AGENTS.md
/// §3.1 and §5), shared by the Mac and the iPhone.
///
/// The roster is a tile per agent — face, name, role and one sentence of
/// state — and a New agent button. Nothing else. The agents that need the
/// person come first, so the first tile is always the one to look at, which is
/// the question this page is opened to answer.
///
/// **An agent is pushed, on both platforms.** On the Mac this screen is a
/// page inside the Chat window's detail column, which gives every page a
/// navigation stack of its own (MACOS_LIQUID_GLASS_REDESIGN.md §9), so opening
/// an agent pushes its page and the system's back button returns; on the
/// iPhone the screen sits in the app's stack. The page draws no back control
/// of its own on either.
///
/// "Message" hands the agent's thread to `openConversation`, which each app
/// wires to its own chat: the thread is an ordinary conversation.
public struct NativeAgentsScreen: View {
    private let model: NativeAgentsModel
    private let apps: [NativeAgentAppChoice]
    private let openConversation: (String) -> Void

    @State private var selectedAgentID: String?
    @State private var hiringFrom: NativeAgentTemplate?

    /// - Parameters:
    ///   - apps: the apps this account has connected, offered to an agent by
    ///     name. Empty hides the choice rather than offering nothing.
    ///   - openConversation: opens a conversation by id in the app's chat.
    public init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice] = [],
        openConversation: @escaping (String) -> Void
    ) {
        self.model = model
        self.apps = apps
        self.openConversation = openConversation
    }

    public var body: some View {
        content
            .sheet(item: $hiringFrom) { template in
                NativeAgentHireView(
                    model: model,
                    apps: apps,
                    template: template,
                    onCancel: { hiringFrom = nil },
                    onHired: { agent in
                        hiringFrom = nil
                        selectedAgentID = agent.id
                    }
                )
            }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        roster
            .navigationDestination(item: $selectedAgentID) { agentID in
                NativeAgentPage(
                    model: model,
                    agentID: agentID,
                    apps: apps,
                    openConversation: openConversation,
                    back: nil
                )
                .navigationTitle(model.agents.first { $0.id == agentID }?.name ?? "Agent")
            }
        #else
        roster
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $selectedAgentID) { agentID in
                NativeAgentPage(
                    model: model,
                    agentID: agentID,
                    apps: apps,
                    openConversation: openConversation,
                    back: nil
                )
            }
            .refreshable { await model.refresh() }
        #endif
    }

    @ViewBuilder
    private var roster: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading agents")
        case .failed, .offline:
            if model.agents.isEmpty {
                NativeAgentsNotice(
                    title: "Couldn’t load your agents",
                    message: model.lastErrorDescription ?? "Juno could not reach your agents.",
                    icon: .agents,
                    actionLabel: "Try again",
                    action: { Task { await model.refresh() } }
                )
            } else {
                NativeAgentRoster(model: model, open: open, hire: hire)
            }
        case .ready:
            NativeAgentRoster(model: model, open: open, hire: hire)
        }
    }

    private func open(_ agentID: String) {
        selectedAgentID = agentID
    }

    private func hire(_ template: NativeAgentTemplate) {
        hiringFrom = template
    }
}

/// The roster itself: a page head, then either the tiles or — on a first visit
/// — the starting points, each a press away from a pre-filled hire. Muse's
/// lesson was that a blank canvas is the wrong first screen for an agent.
struct NativeAgentRoster: View {
    let model: NativeAgentsModel
    let open: (String) -> Void
    let hire: (NativeAgentTemplate) -> Void

    var body: some View {
        NativeAgentsScroll(maxWidth: JunoReadingMeasure.wide) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                if let error = model.lastErrorDescription {
                    NativeAgentsProblem(message: error, dismiss: { model.clearError() })
                }
                if model.agents.isEmpty {
                    firstHire
                } else {
                    tiles
                }
            }
        }
        .accessibilityIdentifier("juno.agents.roster")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                #if os(macOS)
                Text("Agents")
                    .junoPageHeading()
                    .accessibilityAddTraits(.isHeader)
                #else
                Text("Agents")
                    .junoPageHeading(compact: true)
                    .accessibilityAddTraits(.isHeader)
                #endif
                Text("Teammates that take on work, keep going when you leave, and come back only when they need you.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: JunoSpace.snug)
            if !model.agents.isEmpty {
                Button {
                    hire(NativeAgentTemplate.all[0])
                } label: {
                    Label("New agent", icon: .plus)
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.agents.new")
            }
        }
    }

    private var tiles: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 280), spacing: JunoSpace.cozy, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.cozy
        ) {
            ForEach(model.orderedAgents) { agent in
                Button {
                    open(agent.id)
                } label: {
                    NativeAgentRosterTile(agent: agent)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
            }
        }
    }

    private var firstHire: some View {
        let templates = NativeAgentTemplate.all.filter { $0.id != "custom" }
        return VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(spacing: JunoSpace.snug) {
                HStack(spacing: -JunoSpace.cozy) {
                    ForEach(0..<min(4, templates.count), id: \.self) { index in
                        JunoAgentFace(
                            avatar: templates[index].avatar,
                            state: index == 1 ? .working : .idle,
                            size: JunoAgentFaceSize.md
                        )
                    }
                }
                .accessibilityHidden(true)
                Text("Hire your first agent")
                    .junoEmptyTitle()
                    .junoInk()
                    .accessibilityAddTraits(.isHeader)
                Text("Start from a job. Everything is editable before you hire, and nothing it does that sends, pays or deletes happens without you.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 260), spacing: JunoSpace.cozy, alignment: .top)],
                alignment: .leading,
                spacing: JunoSpace.cozy
            ) {
                ForEach(templates) { template in
                    Button {
                        hire(template)
                    } label: {
                        NativeAgentTemplateTile(template: template, selected: false)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.junoPress)
                }
            }

            Button {
                if let custom = NativeAgentTemplate.named("custom") { hire(custom) }
            } label: {
                Text("Or start from scratch")
                    .font(.callout)
                    .junoInk()
                    .underline()
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
        }
    }
}

/// One agent on the roster: face, name, role and the state sentence. The dot
/// is there only while it needs you.
struct NativeAgentRosterTile: View {
    let agent: NativeAgent

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var waiting: Bool { agent.state == .waiting }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.regular) {
            JunoAgentFace(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.md)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.snug) {
                    Text(agent.name)
                        .font(.body.weight(.medium))
                        .junoInk()
                        .lineLimit(1)
                    if waiting {
                        NativeAgentNeedsYouDot()
                    }
                }
                if !agent.role.isEmpty {
                    Text(agent.role)
                        .font(.callout)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }
                Text(sentence)
                    .font(.callout)
                    .foregroundStyle(waiting ? Color.junoForeground : Color.junoMutedForeground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.top, JunoSpace.hairline)
            }
            Spacer(minLength: 0)
        }
        .nativeAgentTile(padding: JunoSpace.regular)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(agent.name). \(sentence)"))
        .accessibilityAddTraits(.isButton)
    }
}

/// A starting point: its face, its name and its one-line promise.
struct NativeAgentTemplateTile: View {
    let template: NativeAgentTemplate
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoAgentFace(avatar: template.avatar, size: JunoAgentFaceSize.sm)
            VStack(alignment: .leading, spacing: 2) {
                Text(template.label)
                    .font(.callout.weight(.medium))
                    .junoInk()
                Text(template.promise)
                    .font(.callout)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .nativeAgentTile(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// A screen with nothing to show but a reason: `JunoEmptyState` on the Mac,
/// the system's unavailable view on the phone, as each app's own pages do.
struct NativeAgentsNotice: View {
    let title: String
    let message: String
    let icon: JunoIcon
    var actionLabel: String?
    var action: (() -> Void)?

    var body: some View {
        #if os(macOS)
        JunoEmptyState(
            title: title,
            message: message,
            icon: icon,
            actionLabel: actionLabel,
            action: action
        )
        #else
        ContentUnavailableView {
            JunoIconLabel(verbatim: title, icon: icon, size: 28)
        } description: {
            Text(message)
        } actions: {
            if let actionLabel, let action {
                Button(actionLabel, action: action)
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            }
        }
        #endif
    }
}
