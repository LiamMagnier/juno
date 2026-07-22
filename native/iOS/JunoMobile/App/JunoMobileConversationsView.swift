import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// The chat destination: the selected conversation's transcript + composer, or
/// an empty state that starts a new chat. The conversation list lives in the
/// sidebar; this screen never owns a NavigationStack (the root provides one).
struct JunoMobileChatDetailScreen: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var projects: [NativeProject] = []

    private var selected: NativeConversation? {
        guard let id = model.selectedConversationID else { return nil }
        return model.conversations.first { $0.id == id }
    }

    var body: some View {
        Group {
            if let selected {
                JunoMobileConversationDetail(model: model, conversation: selected, projects: projects)
            } else {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("chat.empty.title", systemImage: "bubble.left.and.text.bubble.right")
        } description: {
            Text("chat.empty.description")
        } actions: {
            Button {
                Task {
                    if let id = await model.createConversation() {
                        model.selectedConversationID = id
                    }
                }
            } label: {
                Label("chat.new", systemImage: "square.and.pencil")
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isMutating)
        }
        .navigationTitle("navigation.chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct JunoMobileConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    var projects: [NativeProject] = []
    @State private var showingRename = false
    @State private var editValue = ""
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @State private var isNearBottom = true
    @State private var showingActions = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool

    private let bottomAnchor = "juno.chat.bottom"

    private var messages: [NativeChatMessage] {
        model.messages(for: conversation.id)
    }

    /// Changes whenever streamed content grows or a message is added, driving
    /// the follow-the-stream auto-scroll.
    private var streamSignature: Int {
        let last = messages.last
        return messages.count
            + (last?.content.count ?? 0)
            + (last?.reasoning?.count ?? 0)
    }

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if messages.isEmpty {
                    ContentUnavailableView(
                        "No messages yet",
                        systemImage: "bubble.left.and.text.bubble.right",
                        description: Text("This conversation is ready for its first message.")
                    )
                    .frame(maxWidth: .infinity, minHeight: 360)
                } else {
                    LazyVStack(spacing: 14) {
                        ForEach(messages) { message in
                            JunoMobileMessageRow(message: message)
                        }
                    }
                    .padding()
                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchor)
                }
            }
            .background(Color.junoCanvas)
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let distance = geometry.contentSize.height
                    - geometry.contentOffset.y
                    - geometry.containerSize.height
                // Non-scrollable (content fits) counts as "at bottom" so the
                // jump-to-latest control never shows when there is nothing to
                // scroll to.
                return geometry.contentSize.height <= geometry.containerSize.height
                    || distance < 120
            } action: { _, nearBottom in
                isNearBottom = nearBottom
            }
            .onChange(of: streamSignature) { _, _ in
                guard isNearBottom else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !isNearBottom && !messages.isEmpty {
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                            proxy.scrollTo(bottomAnchor, anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.body.weight(.semibold))
                            .padding(12)
                    }
                    .background(.regularMaterial, in: Circle())
                    .padding(.trailing, 16)
                    .padding(.bottom, 8)
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("Scroll to latest")
                    .accessibilityIdentifier("juno.mobile.chat-scroll-bottom")
                }
            }
        }
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        editValue = conversation.title
                        showingRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Divider()
                    Button {
                        Task {
                            await model.setPinned(id: conversation.id, pinned: !conversation.pinned)
                        }
                    } label: {
                        Label(
                            conversation.pinned ? "Unpin" : "Pin",
                            systemImage: conversation.pinned ? "pin.slash" : "pin"
                        )
                    }
                    Button {
                        Task {
                            await model.setArchived(
                                id: conversation.id,
                                archived: !conversation.isArchived
                            )
                        }
                    } label: {
                        Label(
                            conversation.isArchived ? "Unarchive" : "Archive",
                            systemImage: conversation.isArchived ? "tray.and.arrow.up" : "archivebox"
                        )
                    }
                } label: {
                    Label("Conversation actions", systemImage: "ellipsis.circle")
                }
                .disabled(model.isMutating || conversation.isPending)
            }
        }
        .alert("Rename conversation", isPresented: $showingRename) {
            TextField("Title", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.renameConversation(id: conversation.id, title: editValue) }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .onAppear { configureSelections() }
        .onChange(of: selectedModelID) { _, _ in configureSelections() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
        .task {
            #if DEBUG
            if CommandLine.arguments.contains("--juno-preview-composer-actions") {
                try? await Task.sleep(nanoseconds: 400_000_000)
                showingActions = true
            }
            #endif
        }
        .accessibilityIdentifier("juno.mobile.conversation-detail")
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                if model.modelCatalog.isEmpty {
                    Label(junoDisplayModelName(conversation.model), systemImage: "cpu")
                        .lineLimit(1)
                } else {
                    Picker("Model", selection: $selectedModelID) {
                        ForEach(model.modelCatalog) { option in
                            Text(option.displayName)
                                .tag(option.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("juno.mobile.chat-model")
                }
                if let selectedModel, !selectedModel.supportedReasoningEfforts.isEmpty {
                    Picker("Effort", selection: $reasoningEffort) {
                        if selectedModel.canDisableReasoning {
                            Text("Instant").tag(nil as NativeReasoningEffort?)
                        }
                        ForEach(selectedModel.supportedReasoningEfforts) { effort in
                            Text(effort.rawValue.capitalized)
                                .tag(effort as NativeReasoningEffort?)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("juno.mobile.chat-effort")
                }
                Spacer(minLength: 0)
                if model.chatPhase != .idle {
                    HStack(spacing: 5) {
                        if isStreamingPhase {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: phaseSymbol)
                        }
                        Text(phaseLabel)
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(phaseLabel)
                }
            }
            .font(.caption)

            TextField("Message Juno", text: $prompt, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($composerFocused)
                .padding(.leading, 48)
                .padding(.trailing, 48)
                .padding(.vertical, 11)
                .background(JunoGlassBackground(cornerRadius: 22))
                .overlay(alignment: .bottomLeading) {
                    composerPlusButton.padding(5)
                }
                .overlay(alignment: .bottomTrailing) {
                    composerActionButton.padding(5)
                }
                .accessibilityIdentifier("juno.mobile.chat-composer")
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)

            if model.canRetrySelectedConversation && !model.isGenerating {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(model.chatErrorDescription ?? "The response was interrupted.")
                        .lineLimit(2)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Retry") {
                        model.retryLastMessage(conversationID: conversation.id)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("juno.mobile.chat-retry")
                }
                .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || conversation.isPending
    }

    private var isStreamingPhase: Bool {
        switch model.chatPhase {
        case .appending, .submitting, .reasoning, .streaming, .reconnecting: true
        case .idle, .stopping, .failed: false
        }
    }

    private var phaseLabel: String {
        switch model.chatPhase {
        case .idle: "Ready"
        case .appending: "Saving message"
        case .submitting: "Starting"
        case .reasoning: "Reasoning"
        case .streaming: "Writing"
        case .stopping: "Stopping"
        case .reconnecting: "Reconnecting"
        case .failed: "Interrupted"
        }
    }

    private var phaseSymbol: String {
        switch model.chatPhase {
        case .reconnecting: "wifi.exclamationmark"
        case .failed: "exclamationmark.circle"
        case .stopping: "stop.circle"
        default: "sparkles"
        }
    }

    /// The "+" control, docked inside the composer's leading edge. A neutral
    /// glass circle (never accent — that stays reserved for Send) that morphs to
    /// an "×" and presents a compact anchored actions panel.
    private var composerPlusButton: some View {
        Button {
            showingActions = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 34, height: 34)
                .rotationEffect(.degrees(showingActions ? 45 : 0))
                .modifier(JunoComposerGlassCircle())
        }
        .buttonStyle(.plain)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: showingActions)
        .accessibilityLabel("Add content or tools")
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .popover(isPresented: $showingActions) {
            composerActionsPanel
                .presentationCompactAdaptation(.popover)
        }
    }

    /// A compact popover anchored to the "+" button. Only genuinely wired
    /// actions appear here — today that is associating the current conversation
    /// with a project (server-validated), so the panel is the project picker
    /// with the current association checked and a "No project" row to clear it.
    private var composerActionsPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Add to project")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 11)
                .padding(.bottom, 5)

            ScrollView {
                VStack(spacing: 1) {
                    projectOptionRow(
                        id: nil, name: "No project", icon: "tray",
                        selected: conversation.projectId == nil
                    )
                    ForEach(projects) { project in
                        projectOptionRow(
                            id: project.id, name: project.name, icon: "folder",
                            selected: conversation.projectId == project.id
                        )
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 244)
        }
        .frame(width: 268)
        .padding(.bottom, 6)
        .accessibilityIdentifier("juno.mobile.composer-actions")
    }

    private func projectOptionRow(id: String?, name: String, icon: String, selected: Bool) -> some View {
        Button {
            Task {
                await model.setProject(id: conversation.id, projectID: id)
                showingActions = false
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(width: 24)
                    .foregroundStyle(selected ? Color.junoAccent : .primary)
                Text(name)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "\(name), selected" : name)
    }

    /// The send / stop control, docked inside the composer's trailing edge as a
    /// circular coral Liquid Glass button. It fades to a discreet disabled state
    /// when there is nothing to send and swaps to a Stop button while streaming.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .modifier(JunoComposerSendBackground(active: true))
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Stop generation")
            .accessibilityIdentifier("juno.mobile.chat-stop")
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .modifier(JunoComposerSendBackground(active: !sendDisabled))
                    .scaleEffect(sendDisabled ? 0.92 : 1)
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    private func send() {
        let value = prompt
        if model.sendMessage(
            conversationID: conversation.id,
            prompt: value,
            modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
            reasoningEffort: reasoningEffort
        ) {
            prompt = ""
        }
    }

    private func configureSelections() {
        if selectedModelID.isEmpty
            || !model.modelCatalog.contains(where: { $0.id == selectedModelID })
        {
            selectedModelID = model.modelCatalog.contains(where: { $0.id == conversation.model })
                ? conversation.model : model.modelCatalog.first?.id ?? conversation.model
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

private struct JunoMobileMessageRow: View {
    let message: NativeChatMessage

    private var isUser: Bool { message.role == .user }

    /// The assistant is working but has not started writing the answer yet — the
    /// moment to show the inline "Thinking about your request" status.
    private var showThinking: Bool {
        !isUser && message.isPending && message.content.isEmpty
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 40) }
            if !isUser {
                Image(systemName: "sparkle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 20, height: 20)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(isUser ? "You" : "Juno").junoMetadata()

                // Reasoning sits above the answer as a collapsible control, not
                // as a forgotten note beneath it.
                if !isUser, let reasoning = message.reasoning, !reasoning.isEmpty {
                    JunoReasoningDisclosure(text: reasoning)
                }

                if showThinking {
                    JunoThinkingIndicator()
                } else if !message.content.isEmpty {
                    Text(message.content)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if !message.sources.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sources").junoMetadata()
                        ForEach(message.sources, id: \.url) { source in
                            Link(destination: source.url) {
                                Label(source.title, systemImage: "link")
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                        }
                    }
                }

                if (message.model?.isEmpty == false) || (message.isPending && !showThinking) {
                    HStack(spacing: 8) {
                        if let model = message.model, !model.isEmpty {
                            Text(junoDisplayModelName(model)).font(.caption2).foregroundStyle(.tertiary)
                        }
                        if message.isPending && !showThinking {
                            ProgressView().controlSize(.mini)
                        }
                    }
                }

                if let error = message.errorDescription {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(isUser ? Color.junoAccent.opacity(0.14) : Color.junoSurface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contextMenu {
                Button {
                    UIPasteboard.general.string = message.content
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .disabled(message.content.isEmpty)
            }
            if !isUser { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isUser ? "You said" : "Juno replied")
    }
}

/// The inline "Thinking about your request" status shown before the assistant's
/// answer begins. Uses a subtle, self-limiting symbol pulse that is suppressed
/// under Reduce Motion.
private struct JunoThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "sparkles")
                .font(.callout)
                .foregroundStyle(Color.junoAccent)
                .symbolEffect(.pulse, isActive: !reduceMotion)
            Text("Thinking about your request")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Thinking about your request")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The post-completion reasoning trace, presented as a compact expandable
/// control (chevron, coral label) rather than a metadata footnote. VoiceOver
/// announces the expanded/collapsed state via `DisclosureGroup`.
private struct JunoReasoningDisclosure: View {
    let text: String
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain")
                    .font(.caption)
                Text("Reasoning")
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Color.junoAccent)
        }
        .tint(Color.junoAccent)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: expanded)
    }
}

/// A circular coral Liquid Glass background for the composer's send/stop button,
/// with a material fallback below OS 26. When inactive the coral tint fades to a
/// discreet level so the disabled state stays legible without shouting.
private struct JunoComposerSendBackground: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(Color.junoAccent.opacity(active ? 0.95 : 0.32)).interactive(),
                    in: Circle()
                )
        } else {
            content
                .background(Color.junoAccent.opacity(active ? 1 : 0.35), in: Circle())
        }
    }
}

/// A neutral (non-accent) circular Liquid Glass background for the composer's
/// "+" button, with a material fallback below OS 26.
private struct JunoComposerGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

/// Turns a raw model identifier such as `anthropic:claude-sonnet-4-6` into a
/// human-friendly label like `Claude Sonnet 4.6`. The technical id is never
/// shown directly in the chat surface.
func junoDisplayModelName(_ raw: String) -> String {
    let slug = raw.split(separator: ":").last.map(String.init) ?? raw
    let tokens = slug.split(separator: "-").map(String.init)
    guard !tokens.isEmpty else { return raw }
    let acronyms: Set<String> = ["gpt", "llm", "ai", "xai"]
    var parts: [String] = []
    for token in tokens {
        if token.allSatisfy(\.isNumber) {
            if let last = parts.last, last.allSatisfy({ $0.isNumber || $0 == "." }) {
                parts[parts.count - 1] = last + "." + token
            } else {
                parts.append(token)
            }
        } else if acronyms.contains(token.lowercased()) {
            parts.append(token.uppercased())
        } else {
            parts.append(token.prefix(1).uppercased() + token.dropFirst())
        }
    }
    return parts.joined(separator: " ")
}
