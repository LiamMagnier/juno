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

    private var selected: NativeConversation? {
        guard let id = model.selectedConversationID else { return nil }
        return model.conversations.first { $0.id == id }
    }

    var body: some View {
        Group {
            if let selected {
                JunoMobileConversationDetail(model: model, conversation: selected)
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
    @State private var showingRename = false
    @State private var editValue = ""
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @State private var isNearBottom = true
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
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !isNearBottom && !messages.isEmpty {
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) {
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
        .accessibilityIdentifier("juno.mobile.conversation-detail")
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                if model.modelCatalog.isEmpty {
                    Label(conversation.model, systemImage: "cpu")
                        .lineLimit(1)
                } else {
                    Picker("Model", selection: $selectedModelID) {
                        ForEach(model.modelCatalog) { option in
                            Text("\(option.providerName) · \(option.displayName)")
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

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(JunoGlassBackground(cornerRadius: 20))
                    .accessibilityIdentifier("juno.mobile.chat-composer")

                if generatingHere {
                    Button {
                        model.stopGeneration()
                    } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .clipShape(Circle())
                    .accessibilityLabel("Stop generation")
                    .accessibilityIdentifier("juno.mobile.chat-stop")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Circle())
                    .disabled(sendDisabled)
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("juno.mobile.chat-send")
                }
            }

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
                Text(message.content)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let reasoning = message.reasoning, !reasoning.isEmpty {
                    DisclosureGroup {
                        Text(reasoning)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 4)
                    } label: {
                        Label("Reasoning", systemImage: "brain").junoMetadata()
                    }
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
                HStack(spacing: 8) {
                    if let model = message.model, !model.isEmpty {
                        Text(model).font(.caption2).foregroundStyle(.tertiary)
                    }
                    if message.isPending {
                        ProgressView().controlSize(.small)
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
