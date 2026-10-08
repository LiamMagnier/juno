import Foundation
import JunoDesignSystem
import SwiftUI

/// The Agents home: a person's team, not a settings screen. The web's
/// `agents-home.tsx`, shared by the Mac and the iPhone.
///
/// With no agents it is the Chat landing's twin: the face the new agent will
/// get (it watches you type), a question in the greeting's serif, the same
/// composer, and one line of promise. Describing a job creates the agent that
/// face belongs to, which hops once and opens its thread, where it sets itself
/// up in conversation.
///
/// With agents, the same composer sits above a grid of live cards: the face
/// says what each one is doing before the words do. No second navigation
/// column, no filters, no counts, no chips under the composer.
struct NativeAgentsHome: View {
    let model: NativeAgentsModel
    /// The person's name, for the empty page's question. Only the first word
    /// is used.
    var personName: String?
    /// Focus the field on arrival: the web's `/agents/new`.
    var focusComposer = false
    /// Opens an agent's thread.
    let openAgent: (NativeAgent) -> Void

    var body: some View {
        Group {
            if model.agents.isEmpty, model.phase == .idle || model.phase == .loading {
                skeleton
            } else if model.agents.isEmpty, model.phase == .failed || model.phase == .offline {
                NativeAgentsNotice(
                    title: "Couldn’t load your agents",
                    message: model.lastErrorDescription ?? "Juno could not reach your agents.",
                    icon: .agents,
                    actionLabel: "Try again",
                    action: { Task { await model.refresh() } }
                )
            } else if model.agents.isEmpty {
                NativeAgentsFirst(model: model, personName: personName, openAgent: openAgent)
            } else {
                NativeAgentsTeam(model: model, focusComposer: focusComposer, openAgent: openAgent)
            }
        }
        .junoAgentGazeField()
    }

    private var skeleton: some View {
        NativeAgentsScroll(maxWidth: JunoReadingMeasure.wide) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                JunoSkeleton(height: 34, width: 160)
                JunoSkeleton(height: 16, width: 260)
                JunoSkeleton(height: 98, cornerRadius: JunoComposerMetrics.cornerRadius)
                    .padding(.top, JunoSpace.region)
                HStack(spacing: JunoSpace.cozy) {
                    ForEach(0..<3, id: \.self) { _ in
                        JunoSkeleton(height: 176, cornerRadius: JunoRadius.panel)
                    }
                }
                .padding(.top, JunoSpace.expanse)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading agents")
    }
}

// MARK: - No agents yet

/// The Chat landing's twin, with the face you are about to meet.
private struct NativeAgentsFirst: View {
    let model: NativeAgentsModel
    let personName: String?
    let openAgent: (NativeAgent) -> Void

    @Environment(\.junoTextScale) private var textScale
    @State private var viewport = CGSize(width: 640, height: 600)

    private var firstName: String? {
        personName?.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace).first.map(String.init)
    }

    var body: some View {
        let size = JunoType.displaySize(forColumnWidth: min(viewport.width, 1_024))
        ScrollView {
            NativeAgentJobComposer(model: model, team: [], style: .hero, autoFocus: true, openAgent: openAgent) {
                heading(size: size)
            }
            .frame(maxWidth: 672)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.expanse)
            // The web's `pb-[12vh]`: centred a little above the middle, where
            // the Chat landing's greeting sits.
            .padding(.bottom, viewport.height * 0.12)
            .frame(maxWidth: .infinity, minHeight: viewport.height)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
    }

    private func heading(size: CGFloat) -> some View {
        Group {
            if let firstName {
                Text("Who should take care of it, \(Text(firstName).font(JunoType.displayItalic(size: size).font(scale: textScale)))?")
            } else {
                Text("Who should take care of it?")
            }
        }
        .junoType(.display(size: size))
        .foregroundStyle(Color.junoForeground)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - The team

private struct NativeAgentsTeam: View {
    let model: NativeAgentsModel
    let focusComposer: Bool
    let openAgent: (NativeAgent) -> Void

    var body: some View {
        #if os(macOS)
        JunoPage(measure: .wide) {
            NativeAgentsTeamHeader(agents: model.orderedAgents)
        } content: {
            content
        }
        #else
        NativeAgentsScroll(maxWidth: JunoReadingMeasure.wide) {
            VStack(alignment: .leading, spacing: 0) {
                NativeAgentsTeamHeader(agents: model.orderedAgents)
                content
            }
        }
        #endif
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            NativeAgentJobComposer(
                model: model,
                team: model.agents,
                style: .compact,
                autoFocus: focusComposer,
                openAgent: openAgent
            ) {
                EmptyView()
            }
            NativeAgentsGrid(model: model, openAgent: openAgent)
                .padding(.top, JunoSpace.expanse)
        }
    }
}

/// "Agents", then what is happening in one plain sentence.
private struct NativeAgentsTeamHeader: View {
    let agents: [NativeAgent]

    #if os(macOS)
    @Environment(\.junoPageLayout) private var layout
    /// The page column's width; the phone has no `JunoPage`, so it measures itself.
    private var pageColumn: CGFloat? { layout?.columnWidth }
    #else
    private var pageColumn: CGFloat? { nil }
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            #if os(macOS)
            // The Mac names the place as its sidebar row does, in the page
            // title every other Mac page wears (round 2).
            Text("Orbit")
                .junoPageTitle(columnWidth: pageColumn)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            #else
            Text("Agents")
                .junoType(.display(size: JunoType.pageTitle(columnWidth: pageColumn ?? 640).size))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            #endif
            Text(NativeAgentStarter.teamSentence(agents))
                .junoType(.body)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, JunoSpace.region)
    }
}

/// One column on a narrow page, two from 560pt, three from 896pt: the web's
/// `@[40rem]/page:grid-cols-2 @[66rem]/page:grid-cols-3`.
private struct NativeAgentsGrid: View {
    let model: NativeAgentsModel
    let openAgent: (NativeAgent) -> Void

    #if os(macOS)
    @Environment(\.junoPageLayout) private var layout
    /// The page column's width; the phone has no `JunoPage`, so it measures itself.
    private var pageColumn: CGFloat? { layout?.columnWidth }
    #else
    private var pageColumn: CGFloat? { nil }
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0

    private var columns: [GridItem] {
        let column = pageColumn ?? width
        let count = column >= 896 ? 3 : column >= 560 ? 2 : 1
        return Array(repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top), count: count)
    }

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: JunoSpace.cozy) {
            ForEach(model.orderedAgents) { agent in
                NativeAgentCard(
                    agent: agent,
                    open: { openAgent(agent) },
                    togglePin: { Task { await model.setPinned(id: agent.id, pinned: !agent.isPinned) } },
                    togglePause: { Task { await model.setPaused(id: agent.id, paused: !agent.isPaused) } }
                )
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: model.orderedAgents.map(\.id))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .padding(.bottom, JunoSpace.expanse)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your agents")
    }
}

// MARK: - A card

/// One agent: its face on its halo, its name and role, the sentence it is
/// living (or, in the accent with a hand, that it needs you), and a quiet
/// footnote. A faint wash of its colour from the face's corner, so the grid
/// reads as people before it reads as text. Hover lifts the card and wakes
/// the face; the menu (Pin, Pause) shows under the pointer.
struct NativeAgentCard: View {
    let agent: NativeAgent
    let open: () -> Void
    let togglePin: () -> Void
    let togglePause: () -> Void

    @State private var hovering = false

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var attention: Bool { agent.needsPerson }
    private var tone: Color { agent.avatar.tone.color }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                JunoAgentPresence(avatar: agent.avatar, state: agent.state, size: 52)
                    .padding(.top, JunoSpace.hairline)
                    .padding(.leading, JunoSpace.hairline)
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(agent.name)
                        .junoType(JunoType.bodyLarge.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if !agent.role.isEmpty {
                        Text(agent.role)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                    }
                }
                .padding(.top, JunoSpace.roomy)
                Group {
                    if attention {
                        NativeAgentNeedsYouLine(sentence: sentence)
                    } else {
                        JunoAgentStatusLine(sentence, state: agent.state, type: .ui, color: Color.junoForeground.opacity(0.8))
                    }
                }
                .padding(.top, JunoSpace.tight)
                Text(NativeAgentStarter.footnote(for: agent) ?? " ")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .padding(.top, JunoSpace.regular)
            }
            .padding(EdgeInsets(top: 22, leading: 22, bottom: 18, trailing: 22))
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .contentShape(.rect(cornerRadius: JunoRadius.panel))
        }
        .buttonStyle(NativeAgentCardStyle(tone: tone, attention: attention))
        .overlay(alignment: .topTrailing) { menu }
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(agent.name). \(attention ? "Needs you. " : "")\(sentence)"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("juno.agents.card.\(agent.id)")
    }

    private var menu: some View {
        Menu {
            Button(action: togglePin) {
                Label(agent.isPinned ? "Unpin" : "Pin", icon: agent.isPinned ? .pinOff : .pin)
            }
            Button(action: togglePause) {
                Label(agent.isPaused ? "Resume" : "Pause", icon: agent.isPaused ? .play : .pause)
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
        .help("More for \(agent.name)")
        .accessibilityLabel("More for \(agent.name)")
        #if os(macOS)
        .opacity(hovering ? 1 : 0)
        #endif
        .padding(JunoSpace.close)
    }
}

/// "Needs you", said the one way attention is said: the accent and a hand,
/// as plain text. Never a pill or a dot.
struct NativeAgentNeedsYouLine: View {
    let sentence: String
    var type: JunoType = JunoType.ui.weight(.medium)
    var iconSize: CGFloat = 14

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.tight) {
            JunoIconView(.hand, size: iconSize)
                .accessibilityHidden(true)
            Text(verbatim: sentence)
                .junoType(type)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(Color.junoAccentInk)
    }
}

/// The card's surface and its response: the tone wash on the card fill, a
/// hairline (the accent's, faintly, while it needs you), and on hover a 2pt
/// lift with a shadow of its own colour. The face inside notices too.
private struct NativeAgentCardStyle: ButtonStyle {
    let tone: Color
    let attention: Bool

    func makeBody(configuration: Configuration) -> some View {
        Card(configuration: configuration, tone: tone, attention: attention)
    }

    private struct Card: View {
        let configuration: ButtonStyleConfiguration
        let tone: Color
        let attention: Bool

        @State private var hovered = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        private var shape: RoundedRectangle {
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
        }

        var body: some View {
            configuration.label
                .environment(
                    \.junoAgentFaceTrigger,
                    JunoAgentFaceTrigger(hovered: hovered, pressed: configuration.isPressed)
                )
                .background {
                    shape
                        .fill(Color.junoRaised)
                        .overlay {
                            GeometryReader { proxy in
                                shape.fill(
                                    RadialGradient(
                                        colors: [tone.opacity(0.1), tone.opacity(0)],
                                        center: .topLeading,
                                        startRadius: 0,
                                        endRadius: max(proxy.size.width, proxy.size.height) * 0.66
                                    )
                                )
                            }
                        }
                        .shadow(
                            color: tone.opacity(hovered && !reduceMotion ? 0.3 : 0),
                            radius: 15,
                            y: 10
                        )
                }
                .overlay {
                    shape.strokeBorder(
                        attention ? Color.junoAccent.opacity(0.35) : Color.junoBorder.opacity(hovered ? 1 : 0.7),
                        lineWidth: 1
                    )
                }
                .offset(y: hovered && !configuration.isPressed ? JunoMotion.shift(-2, reduceMotion: reduceMotion) : 0)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.992, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

// MARK: - The composer

/// The one field. Describe a job, and the agent whose face sits beside it is
/// created, named and opened on its thread with that job as its first
/// message. While you type the face listens; while it is created it works;
/// when it arrives it hops, and then its thread opens.
struct NativeAgentJobComposer<Heading: View>: View {
    enum Style {
        /// The empty page: the face above, large, and the heading under it.
        case hero
        /// The team page: a small face inside the field.
        case compact
    }

    let model: NativeAgentsModel
    let team: [NativeAgent]
    let style: Style
    var autoFocus = false
    let openAgent: (NativeAgent) -> Void
    @ViewBuilder let heading: () -> Heading

    @State private var value = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var arrived = false
    @State private var example = 0
    @State private var salt = Int.random(in: 0..<997)
    /// The name and face at the moment of sending, held so the face beside
    /// the field does not change to the next one when the team grows.
    @State private var sent: (name: String, avatar: JunoAgentAvatar)?
    @State private var request: (key: String, text: String)?
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var name: String { sent?.name ?? NativeAgentStarter.nextName(team: team, salt: salt) }
    private var face: JunoAgentAvatar { sent?.avatar ?? NativeAgentStarter.nextFace(team: team, salt: salt) }
    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var faceState: JunoAgentState {
        if arrived { return .done }
        if busy { return .working }
        if !trimmed.isEmpty { return .listening }
        return .idle
    }

    private var caption: String {
        if busy || arrived { return "\(name) is setting up…" }
        if !trimmed.isEmpty { return "\(name) will take this on" }
        return "Describe a job. An agent sets itself up."
    }

    var body: some View {
        VStack(spacing: 0) {
            if style == .hero {
                JunoAgentPresence(avatar: face, state: faceState, size: 84, name: name, spread: 0.6)
                    .padding(.bottom, JunoSpace.wide)
                heading()
                    .padding(.bottom, JunoSpace.region)
            }
            // The chat composer's material and geometry, at the page's full
            // width (the shell caps itself at the transcript's measure; this
            // field spans the team page's column, as the web's does).
            VStack(alignment: .leading, spacing: 0) {
                field
                    .frame(maxWidth: .infinity, minHeight: JunoComposerMetrics.fieldMinimumHeight, alignment: .topLeading)
                    .padding(JunoComposerMetrics.fieldInsets)
                controls
                    .frame(height: JunoComposerMetrics.controlHeight)
                    .padding(JunoComposerMetrics.controlsInsets)
            }
            .junoComposerGlass()
            .focusEffectDisabled()
            below
                .padding(.top, JunoComposerMetrics.clusterSpacing)
        }
        .task(id: value.isEmpty) {
            guard value.isEmpty else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(NativeAgentStarter.exampleInterval))
                guard !Task.isCancelled else { return }
                example = (example + 1) % NativeAgentStarter.examples.count
            }
        }
        .onAppear {
            if autoFocus { focused = true }
        }
    }

    private var field: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            if style == .compact {
                JunoAgentPresence(avatar: face, state: faceState, size: 28, spread: 0.35)
                    .padding(.top, -2)
                    .accessibilityHidden(true)
            }
            TextField(
                "",
                text: $value,
                prompt: Text(verbatim: NativeAgentStarter.examples[example]).foregroundStyle(Color.junoSecondaryInk),
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .junoType(.body)
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1...8)
            .focused($focused)
            .disabled(busy)
            .onSubmit(submit)
            #if os(macOS)
            .onKeyPress(.return, phases: .down) { press in
                if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
                submit()
                return .handled
            }
            .onKeyPress(.tab, phases: .down) { _ in
                guard value.isEmpty else { return .ignored }
                value = NativeAgentStarter.examples[example]
                return .handled
            }
            #endif
            .accessibilityLabel(style == .compact ? "Give a new agent a job" : "Describe a job for your first agent")
            .accessibilityIdentifier("juno.agents.composer")
        }
    }

    private var controls: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(verbatim: caption)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .padding(.leading, JunoSpace.tight)
                .contentTransition(.opacity)
            Spacer(minLength: JunoSpace.snug)
            sendButton
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: caption)
    }

    private var sendButton: some View {
        let enabled = !busy && !trimmed.isEmpty
        return Button(action: submit) {
            ZStack {
                Circle().fill(enabled || busy ? Color.junoAccent : Color.junoGlassFill)
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Color.junoOnAccent)
                        .environment(\.colorScheme, .dark)
                } else {
                    JunoIconView(.send, size: 14, weight: .bold)
                        .foregroundStyle(enabled ? Color.junoOnAccent : Color.junoSecondaryInk.opacity(0.5))
                }
            }
            .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help("Start \(name)")
        .accessibilityLabel("Start \(name)")
        .accessibilityIdentifier("juno.agents.composer.send")
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: enabled)
    }

    private var below: some View {
        Group {
            if let failure {
                Text(verbatim: failure)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoDestructiveInk)
            } else {
                Text(verbatim: NativeAgentStarter.promise)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .multilineTextAlignment(style == .hero ? .center : .leading)
        .frame(maxWidth: .infinity, alignment: style == .hero ? .center : .leading)
        .padding(.horizontal, JunoSpace.hairline)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func submit() {
        let text = trimmed
        guard !text.isEmpty, !busy, text.count <= NativeAgentLimits.instructions else { return }
        if request == nil || request?.text != text {
            request = (UUID().uuidString, text)
        }
        let chosen = (name: name, avatar: face)
        sent = chosen
        busy = true
        failure = nil
        let key = request?.key ?? UUID().uuidString
        Task {
            guard let agent = await model.start(job: text, name: chosen.name, avatar: chosen.avatar, creationKey: key) else {
                failure = model.lastErrorDescription ?? "Couldn’t start that agent. Your words are still here; try again."
                busy = false
                sent = nil
                return
            }
            model.clearMutationMessage()
            arrived = true
            // The face hops before the thread opens; nothing to wait for
            // under Reduce Motion.
            if !reduceMotion {
                try? await Task.sleep(for: .milliseconds(820))
            }
            openAgent(agent)
            value = ""
            request = nil
            busy = false
            arrived = false
            sent = nil
            salt = Int.random(in: 0..<997)
        }
    }
}
