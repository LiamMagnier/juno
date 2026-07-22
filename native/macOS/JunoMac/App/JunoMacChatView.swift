import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// The central conversation workspace: a calm borderless transcript, a floating
/// Liquid Glass composer, and an optional contextual inspector.
///
/// The transcript is not a list of cards. Assistant answers render flat on the
/// canvas the way a document does — only the reader's own messages get a
/// container, because those are the ones that need to be told apart from the
/// answer flow.
struct JunoMacChatView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let projectName: (String) -> String?
    let openArtifact: (String) -> Void
    @Binding var inspectorVisible: Bool

    /// Drafts survive switching conversations — losing a half-written message
    /// to a stray click in the sidebar is the kind of small betrayal that makes
    /// an app feel untrustworthy.
    @State private var drafts: [String: String] = [:]
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @State private var isNearBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let bottomAnchor = "juno.chat.bottom"

    private var conversation: NativeConversation? { model.selectedConversation }

    private var messages: [NativeChatMessage] {
        conversation.map { model.messages(for: $0.id) } ?? []
    }

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation?.id
    }

    /// Grows with every streamed character, driving follow-the-stream scrolling
    /// without observing the whole message array.
    private var streamSignature: Int {
        let last = messages.last
        return messages.count
            + (last?.content.count ?? 0)
            + (last?.reasoning?.count ?? 0)
    }

    private var draft: Binding<String> {
        Binding(
            get: { conversation.flatMap { drafts[$0.id] } ?? "" },
            set: { value in
                guard let id = conversation?.id else { return }
                drafts[id] = value
            }
        )
    }

    var body: some View {
        Group {
            if let conversation {
                conversationBody(conversation)
            } else {
                ContentUnavailableView {
                    Label("chat.empty.title", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("chat.empty.description")
                } actions: {
                    Button("chat.new") {
                        Task {
                            if let id = await model.createConversation() {
                                model.selectedConversationID = id
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .background(Color.junoCanvas)
            }
        }
        .inspector(isPresented: inspectorBinding) {
            if let conversation {
                JunoMacChatInspector(
                    conversation: conversation,
                    messages: messages,
                    modelDisplayName: displayName(for: conversation.model),
                    projectName: conversation.projectId.flatMap(projectName),
                    artifacts: artifacts(for: conversation.id),
                    openArtifact: openArtifact
                )
                .inspectorColumnWidth(min: 240, ideal: 300, max: 420)
            }
        }
        .onAppear { configureSelections() }
        .onChange(of: conversation?.id) { _, _ in configureSelections() }
        .onChange(of: selectedModelID) { _, _ in configureSelections() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
    }

    /// The inspector is only offered when it has something to say. An empty
    /// pane that can be toggled open is worse than no toggle at all.
    private var inspectorBinding: Binding<Bool> {
        Binding(
            get: { inspectorVisible && hasInspectorContent },
            set: { inspectorVisible = $0 }
        )
    }

    private var hasInspectorContent: Bool { conversation != nil }

    private func artifacts(for conversationID: String) -> [NativeArtifact] {
        artifactModel?.artifacts.filter { $0.conversationID == conversationID } ?? []
    }

    /// The catalog's own name when it has one, otherwise a humanized form of
    /// the identifier — never the raw `provider:slug`.
    private func displayName(for modelID: String) -> String {
        model.modelCatalog.first { $0.id == modelID }?.displayName
            ?? junoDisplayModelName(modelID)
    }

    @ViewBuilder
    private func conversationBody(_ conversation: NativeConversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                if messages.isEmpty {
                    ContentUnavailableView {
                        Label("chat.thread.empty.title", systemImage: "text.bubble")
                    } description: {
                        Text("chat.thread.empty.description")
                    }
                    .frame(maxWidth: .infinity, minHeight: 320)
                } else {
                    LazyVStack(alignment: .leading, spacing: JunoSpace.section + 4) {
                        ForEach(messages) { message in
                            JunoMacMessageView(
                                message: message,
                                isStreaming: generatingHere && message.id == messages.last?.id
                            )
                            .id(message.id)
                        }
                        if generatingHere, messages.last?.role == .user {
                            JunoMacThinkingRow(phase: model.chatPhase)
                        }
                    }
                    // A comfortable measure: long lines are harder to read than
                    // a narrower column, however wide the window gets.
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, JunoSpace.region)
                    .padding(.top, JunoSpace.section)
                    // Clears the floating composer so the final line is never
                    // parked underneath it.
                    .padding(.bottom, 124)
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
            }
            .background(Color.junoCanvasWarm)
            // Marks the transcript itself, not the whole workspace: an
            // identifier on the container propagates to every descendant that
            // lacks one and silently overrides the ones that have it, which
            // made the composer and Send button unaddressable.
            .accessibilityIdentifier("juno.mac.conversation-detail")
            .defaultScrollAnchor(messages.count > 4 ? .bottom : .top)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let distance = geometry.contentSize.height
                    - geometry.contentOffset.y
                    - geometry.containerSize.height
                return geometry.contentSize.height <= geometry.containerSize.height
                    || distance < 120
            } action: { _, nearBottom in
                isNearBottom = nearBottom
            }
            .onChange(of: streamSignature) { _, _ in
                // Only follow the stream when the reader is already at the
                // bottom; yanking them away from text they scrolled back to
                // read is the single worst chat-UI defect.
                guard isNearBottom else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottom) { scrollToLatest(proxy) }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                JunoMacComposer(
                    text: draft,
                    conversation: conversation,
                    catalog: model.modelCatalog,
                    selectedModelID: $selectedModelID,
                    reasoningEffort: $reasoningEffort,
                    projectName: conversation.projectId.flatMap(projectName),
                    isGenerating: generatingHere,
                    canSend: !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        .isEmpty && !model.isGenerating && !conversation.isPending,
                    send: send,
                    stop: model.stopGeneration
                )
            }
            .safeAreaInset(edge: .top, spacing: 0) { banners }
        }
        .navigationTitle(conversation.title)
        .navigationSubtitle(displayName(for: conversation.model))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    inspectorVisible.toggle()
                } label: {
                    Label("chat.inspector.toggle", systemImage: "sidebar.trailing")
                }
                .help(Text("chat.inspector.toggle"))
                .keyboardShortcut("i", modifiers: [.command, .option])
                .accessibilityIdentifier("juno.mac.inspector-toggle")
            }
        }
    }

    @ViewBuilder
    private func scrollToLatest(_ proxy: ScrollViewProxy) -> some View {
        if !isNearBottom && !messages.isEmpty {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            } label: {
                Label("chat.scroll-to-latest", systemImage: "arrow.down")
                    .labelStyle(.iconOnly)
                    .font(.callout.weight(.semibold))
                    .padding(JunoSpacing.control)
            }
            .buttonStyle(.plain)
            .junoFloatingGlass(cornerRadius: 22)
            .overlay(Circle().strokeBorder(Color.junoHairline))
            .padding(.bottom, 148)
            .transition(.scale.combined(with: .opacity))
            .help(Text("chat.scroll-to-latest"))
            .accessibilityIdentifier("juno.mac.scroll-to-latest")
        }
    }

    /// Conflict, offline and retry states share one strip at the top of the
    /// canvas so they cannot stack up and push the transcript around.
    @ViewBuilder
    private var banners: some View {
        VStack(spacing: 0) {
            if model.conflictedMutationCount > 0 {
                JunoMacBanner(
                    systemImage: "exclamationmark.arrow.triangle.2.circlepath",
                    message: Text("chat.conflict.message"),
                    tint: .orange
                ) {
                    Button("conflict.keep-mine") {
                        Task { await model.resolveConflicts(keepLocalChanges: true) }
                    }
                    Button("conflict.use-server") {
                        Task { await model.resolveConflicts(keepLocalChanges: false) }
                    }
                }
                .accessibilityIdentifier("juno.mac.conversation-conflict")
            }
            if model.canRetrySelectedConversation && !model.isGenerating {
                JunoMacBanner(
                    systemImage: "exclamationmark.triangle.fill",
                    message: Text(model.chatErrorDescription ?? String(localized: "chat.interrupted")),
                    tint: .orange
                ) {
                    Button("chat.retry") {
                        if let id = conversation?.id {
                            model.retryLastMessage(conversationID: id)
                        }
                    }
                    .accessibilityIdentifier("juno.mac.chat-retry")
                }
            } else if model.phase == .offline {
                JunoMacBanner(
                    systemImage: "wifi.slash",
                    message: Text("chat.offline"),
                    tint: .secondary
                ) {
                    Button("common.retry") { Task { await model.reload() } }
                }
            }
        }
    }

    private func send() {
        guard let conversation else { return }
        let value = draft.wrappedValue
        if model.sendMessage(
            conversationID: conversation.id,
            prompt: value,
            modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
            reasoningEffort: reasoningEffort
        ) {
            drafts[conversation.id] = ""
        }
    }

    /// Keeps the model and effort pickers pointing at values the current model
    /// actually supports; an unsupported effort is silently corrected rather
    /// than sent to a backend that would reject it.
    private func configureSelections() {
        guard let conversation else { return }
        if selectedModelID.isEmpty
            || !model.modelCatalog.contains(where: { $0.id == selectedModelID })
        {
            selectedModelID = model.modelCatalog.contains(where: { $0.id == conversation.model })
                ? conversation.model
                : model.modelCatalog.first?.id ?? conversation.model
        }
        guard let selectedModel else { reasoningEffort = nil; return }
        if let reasoningEffort,
            !selectedModel.supportedReasoningEfforts.contains(reasoningEffort)
        {
            self.reasoningEffort = selectedModel.canDisableReasoning
                ? nil : selectedModel.supportedReasoningEfforts.first
        } else if reasoningEffort == nil && !selectedModel.canDisableReasoning {
            reasoningEffort = selectedModel.supportedReasoningEfforts.first
        }
    }
}

// MARK: - Messages

/// One turn in the transcript.
///
/// The assistant's answer has no container at all: label, content, actions. The
/// reader's own message sits in a restrained accent-tinted block, indented from
/// the left so the two voices are distinguishable without either being boxed.
private struct JunoMacMessageView: View {
    let message: NativeChatMessage
    let isStreaming: Bool
    @State private var isHovering = false
    @State private var didCopy = false
    @State private var showReasoning = false

    private var isUser: Bool { message.role == .user }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: JunoSpacing.compact) {
            if isUser {
                userContent
            } else {
                assistantContent
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isUser ? Text("chat.role.you") : Text("chat.role.juno"))
    }

    private var userContent: some View {
        VStack(alignment: .leading, spacing: JunoSpacing.compact) {
            JunoMarkdownText(message.content)
            if message.isPending {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.small)
                    Text("sync.pending").junoMetadata()
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy + 2)
        .padding(.vertical, JunoSpace.snug + 2)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoAccent.opacity(0.085))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoAccent.opacity(0.16))
        )
        .frame(maxWidth: 460, alignment: .trailing)
        .overlay(alignment: .bottomLeading) { copyButton.offset(x: -30) }
    }

    private var assistantContent: some View {
        VStack(alignment: .leading, spacing: JunoSpacing.control) {
            if let reasoning = message.reasoning, !reasoning.isEmpty {
                DisclosureGroup(isExpanded: $showReasoning) {
                    JunoMarkdownText(reasoning)
                        .foregroundStyle(.secondary)
                        .padding(.top, JunoSpacing.compact)
                } label: {
                    Label("chat.reasoning", systemImage: "sparkles")
                        .font(.system(.caption, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("juno.mac.message-reasoning")
            }

            if message.content.isEmpty && isStreaming {
                JunoMacStreamingDots()
            } else {
                JunoMarkdownText(message.content)
            }

            if !message.sources.isEmpty {
                JunoMacSourceList(sources: message.sources)
            }

            if let error = message.errorDescription {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack(spacing: JunoSpacing.compact) {
                copyButton
                Spacer(minLength: 0)
                if let modelName = message.model, !modelName.isEmpty {
                    Text(junoDisplayModelName(modelName)).junoMetadata()
                }
            }
            // Actions stay reserved-but-invisible until hover, so the transcript
            // is quiet at rest and the layout never shifts when they appear.
            .opacity(isHovering ? 1 : 0)
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .accessibilityHidden(false)
        }
    }

    private var copyButton: some View {
        Button {
            JunoPasteboard.copy(message.content)
            didCopy = true
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                didCopy = false
            }
        } label: {
            // `Label` + `.iconOnly` rather than a bare `Image`: an icon-only
            // button built from an Image alone reaches VoiceOver with no name
            // at all, and SwiftUI falls back to the SF Symbol id ("doc.on.doc")
            // as the accessibility identifier.
            Label(
                didCopy ? "chat.copied" : "chat.copy",
                systemImage: didCopy ? "checkmark" : "doc.on.doc"
            )
            .font(.caption)
            .labelStyle(.iconOnly)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .disabled(message.content.isEmpty)
        .opacity(isUser && !isHovering ? 0 : 1)
        .help(Text(didCopy ? "chat.copied" : "chat.copy"))
        .accessibilityIdentifier("juno.mac.message-copy")
    }
}

private struct JunoMacSourceList: View {
    let sources: [NativeChatSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("chat.sources").junoMetadata()
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                Link(destination: source.url) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpacing.compact) {
                        Text("\(index + 1)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(source.title)
                            .font(.caption)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoAccent)
            }
        }
        .padding(.top, JunoSpacing.compact)
    }
}

/// The gap between sending and the first token. Named states, not a bare
/// spinner, because "Reconnecting" and "Reasoning" mean very different things
/// to someone deciding whether to wait.
private struct JunoMacThinkingRow: View {
    let phase: NativeChatGenerationPhase

    var body: some View {
        HStack(spacing: JunoSpacing.compact) {
            JunoMacStreamingDots()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var label: LocalizedStringKey {
        switch phase {
        case .idle: "chat.phase.ready"
        case .appending: "chat.phase.saving"
        case .submitting: "chat.phase.starting"
        case .reasoning: "chat.phase.reasoning"
        case .streaming: "chat.phase.writing"
        case .stopping: "chat.phase.stopping"
        case .reconnecting: "chat.phase.reconnecting"
        case .failed: "chat.phase.interrupted"
        }
    }
}

private struct JunoMacStreamingDots: View {
    @State private var phase = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.junoAccent)
                    .frame(width: 6, height: 6)
                    .opacity(reduceMotion ? 0.7 : (phase == index ? 1 : 0.3))
            }
        }
        .accessibilityHidden(true)
        .task {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(320))
                phase = (phase + 1) % 3
            }
        }
    }
}

private struct JunoMacBanner<Actions: View>: View {
    let systemImage: String
    let message: Text
    let tint: Color
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(spacing: JunoSpacing.compact) {
            Image(systemName: systemImage).foregroundStyle(tint)
            message.font(.caption).lineLimit(2)
            Spacer(minLength: JunoSpacing.compact)
            actions().font(.caption).buttonStyle(.link)
        }
        .padding(.horizontal, JunoSpacing.content)
        .padding(.vertical, JunoSpacing.compact + 2)
        .background(.bar)
        .accessibilityElement(children: .contain)
    }
}
