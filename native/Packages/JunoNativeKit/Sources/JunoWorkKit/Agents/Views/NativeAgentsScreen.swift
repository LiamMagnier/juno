import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// **Agents home** (docs/design/agents-rework/DIRECTION.md), shared by the Mac
/// and the iPhone.
///
/// You never hire; you ask. The page is one sentence field under a display
/// headline, three suggestions drawn from the starting points, and the agents
/// you already have. Sending the sentence creates a blank agent, opens its
/// thread in the app's own chat and delivers the sentence as the first
/// message; the agent names itself and sets itself up from there with its
/// own tools. There is no form, no template grid and no hire sheet.
///
/// Each app wires the two hand-offs to its own chat: `openThread` opens a
/// conversation by id, and `startThread` opens one and sends the sentence
/// through the chat's own send path.
public struct NativeAgentsScreen: View {
    private let model: NativeAgentsModel
    private let openThread: (String) -> Void
    private let startThread: (String, String) -> Void

    @State private var draft = ""
    @State private var isStarting = false
    @State private var startError: String?
    @State private var dealt = false
    @FocusState private var composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - openThread: opens a conversation by id in the app's chat.
    ///   - startThread: opens a conversation by id and sends the message as
    ///     its first, through the app's chat.
    public init(
        model: NativeAgentsModel,
        openThread: @escaping (String) -> Void,
        startThread: @escaping (_ conversationID: String, _ message: String) -> Void
    ) {
        self.model = model
        self.openThread = openThread
        self.startThread = startThread
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var body: some View {
        NativeAgentsScroll(maxWidth: Self.measure) {
            VStack(spacing: 0) {
                headline
                composer
                    .padding(.top, Self.headlineGap)
                NativeAgentSuggestionList(lines: NativeAgentSuggestions.home) { line in
                    draft = line
                    composerFocused = true
                }
                .frame(maxWidth: Self.composerMeasure, alignment: .leading)
                .padding(.top, JunoSpace.cozy)
                .padding(.horizontal, JunoSpace.snug)
                if let startError {
                    NativeAgentsProblem(message: startError, dismiss: { self.startError = nil })
                        .frame(maxWidth: Self.composerMeasure, alignment: .leading)
                        .padding(.top, JunoSpace.cozy)
                        .transition(.opacity)
                }
                yourAgents
                    .padding(.top, Self.rosterGap)
            }
            .frame(maxWidth: .infinity)
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint), value: startError)
        }
        #if os(iOS)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        #endif
        .onChange(of: model.composeRequest) { _, _ in composerFocused = true }
        .accessibilityIdentifier("juno.agents.home")
    }

    // MARK: Layout

    #if os(macOS)
    private static let measure: CGFloat = 960
    private static let topInset: CGFloat = 56
    private static let headlineSize: CGFloat = 44
    private static let headlineGap: CGFloat = JunoSpace.section
    private static let rosterGap: CGFloat = 72
    #else
    private static let measure: CGFloat = JunoReadingMeasure.reading
    private static let topInset: CGFloat = JunoSpace.section
    private static let headlineSize: CGFloat = 34
    private static let headlineGap: CGFloat = JunoSpace.roomy
    private static let rosterGap: CGFloat = 48
    #endif
    private static let composerMeasure: CGFloat = 680

    // MARK: Headline

    private var headline: some View {
        Text("Who should take care of it?")
            .junoDisplayItalic(Self.headlineSize)
            .foregroundStyle(Color.junoForeground)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            .padding(.top, Self.topInset)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField(
                "Describe a job",
                text: $draft,
                prompt: Text("Describe a job. An agent will set itself up.").foregroundStyle(Color.junoTertiaryInk),
                axis: .vertical
            )
                .textFieldStyle(.plain)
                .junoType(.bodyLarge)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(2...8)
                .focused($composerFocused)
                .disabled(isStarting)
                .onSubmit(send)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .accessibilityIdentifier("juno.agents.home.composer")
            HStack {
                if isStarting {
                    Text("Setting up your agent")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .transition(.opacity)
                }
                Spacer(minLength: 0)
                sendButton
            }
            .padding(.leading, 20)
            .padding(.trailing, JunoSpace.cozy)
            .padding(.bottom, JunoSpace.cozy)
            .padding(.top, JunoSpace.snug)
        }
        .frame(maxWidth: Self.composerMeasure)
        .junoComposerGlass()
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isStarting)
    }

    private var sendButton: some View {
        let ready = !trimmedDraft.isEmpty && !isStarting
        return Button(action: send) {
            ZStack {
                Circle()
                    .fill(ready ? Color.junoAccent : Color.junoSecondary)
                if isStarting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    JunoIconView(.arrowUp, size: 16)
                        .foregroundStyle(ready ? Color.junoOnAccent : Color.junoTertiaryInk)
                }
            }
            .frame(width: Self.discSize, height: Self.discSize)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!ready)
        .keyboardShortcut(.return, modifiers: .command)
        .help("Send")
        .accessibilityLabel("Send")
        .accessibilityIdentifier("juno.agents.home.send")
    }

    #if os(macOS)
    private static let discSize: CGFloat = 30
    #else
    private static let discSize: CGFloat = 36
    #endif

    private func send() {
        let text = trimmedDraft
        guard !text.isEmpty, !isStarting else { return }
        isStarting = true
        startError = nil
        Task {
            defer { isStarting = false }
            guard let started = await model.startAgent() else {
                startError = model.lastErrorDescription ?? "Juno couldn’t set up an agent just now. Try again."
                model.clearError()
                return
            }
            draft = ""
            startThread(started.conversationID, text)
        }
    }

    // MARK: Your agents

    @ViewBuilder
    private var yourAgents: some View {
        if !model.agents.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                Text("Your agents")
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityAddTraits(.isHeader)
                tiles
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { dealt = true }
        } else if model.phase == .failed || model.phase == .offline {
            NativeAgentsProblem(
                message: model.lastErrorDescription ?? "Juno couldn’t reach your agents."
            )
            .frame(maxWidth: Self.composerMeasure, alignment: .leading)
        }
    }

    @ViewBuilder
    private var tiles: some View {
        let ordered = model.orderedAgents
        #if os(macOS)
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 200, maximum: 320), spacing: JunoSpace.regular, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.regular
        ) {
            ForEach(Array(ordered.enumerated()), id: \.element.id) { index, agent in
                NativeAgentTile(agent: agent) { open(agent) }
                    .opacity(dealt || reduceMotion ? 1 : 0)
                    .offset(y: dealt || reduceMotion ? 0 : JunoMotion.riseDistance)
                    .animation(JunoMotion.riseIn.delay(Double(min(index, 10)) * 0.04), value: dealt)
            }
        }
        #else
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(ordered) { agent in
                NativeAgentRow(agent: agent) { open(agent) }
            }
        }
        #endif
    }

    private func open(_ agent: NativeAgent) {
        Task {
            guard let conversationID = await model.threadConversationID(for: agent.id) else { return }
            openThread(conversationID)
        }
    }
}

// MARK: - A tile (the Mac)

/// One agent on the Mac's home: a real object, so a card. The face at 72 on
/// its halo, the name, and the live sentence; "Needs you" in the accent with
/// the hand while it waits on the person.
struct NativeAgentTile: View {
    let agent: NativeAgent
    let open: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var waiting: Bool { agent.state == .waiting }

    var body: some View {
        Button(action: open) {
            VStack(spacing: 0) {
                NativeAgentPresence(
                    avatar: agent.avatar,
                    state: agent.isPaused ? .sleeping : agent.state,
                    size: NativeAgentMetrics.tileFace
                )
                .padding(.top, JunoSpace.section)
                .padding(.bottom, JunoSpace.regular)
                Text(agent.name)
                    .junoType(JunoType.bodyLarge.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                if waiting {
                    NativeAgentNeedsYouLine()
                        .padding(.top, JunoSpace.tight)
                }
                Text(sentence)
                    .junoType(.ui)
                    .foregroundStyle(waiting ? Color.junoForeground : Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .lineLimit(2, reservesSpace: true)
                    .padding(.top, JunoSpace.tight)
                    .padding(.horizontal, JunoSpace.regular)
            }
            .padding(.bottom, JunoSpace.roomy)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: waiting ? "\(agent.name). Needs you. \(sentence)" : "\(agent.name). \(sentence)"))
        .accessibilityHint("Opens its thread")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("juno.agents.tile.\(agent.id)")
    }
}

// MARK: - A row (the iPhone)

/// One agent on the iPhone's home: the face at 72 on its halo, then the
/// name and the live sentence beside it. No container; space between rows.
struct NativeAgentRow: View {
    let agent: NativeAgent
    let open: () -> Void

    private var sentence: String { NativeAgentFormat.stateSentence(for: agent) }
    private var waiting: Bool { agent.state == .waiting }

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: JunoSpace.roomy) {
                NativeAgentPresence(
                    avatar: agent.avatar,
                    state: agent.isPaused ? .sleeping : agent.state,
                    size: NativeAgentMetrics.tileFace
                )
                .padding(JunoSpace.snug)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(agent.name)
                        .junoType(JunoType.bodyLarge.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    if waiting {
                        NativeAgentNeedsYouLine()
                    }
                    Text(sentence)
                        .junoType(.ui)
                        .foregroundStyle(waiting ? Color.junoForeground : Color.junoSecondaryInk)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: waiting ? "\(agent.name). Needs you. \(sentence)" : "\(agent.name). \(sentence)"))
        .accessibilityHint("Opens its thread")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("juno.agents.tile.\(agent.id)")
    }
}
