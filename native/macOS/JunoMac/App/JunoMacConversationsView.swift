import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

struct JunoMacConversationsView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    @State private var showingArchived = false
    @State private var showingRename = false
    @State private var editValue = ""

    private var active: [NativeConversation] {
        model.conversations.filter { !$0.isArchived }
    }

    private var archived: [NativeConversation] {
        model.conversations.filter(\.isArchived)
    }

    var body: some View {
        NavigationSplitView {
            conversationList
                .navigationTitle("Conversations")
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
                .toolbar {
                    ToolbarItem {
                        Button {
                            Task { await model.createConversation() }
                        } label: {
                            Label("New conversation", systemImage: "square.and.pencil")
                        }
                        .disabled(model.isMutating)
                        .accessibilityIdentifier("juno.mac.conversation-new")
                    }
                }
        } detail: {
            if let conversation = model.selectedConversation {
                JunoMacConversationDetail(
                    model: model,
                    conversation: conversation,
                    rename: beginRename,
                    togglePin: {
                        Task {
                            await model.setPinned(
                                id: conversation.id,
                                pinned: !conversation.pinned
                            )
                        }
                    },
                    toggleArchive: {
                        Task {
                            await model.setArchived(
                                id: conversation.id,
                                archived: !conversation.isArchived
                            )
                        }
                    }
                )
            } else {
                ContentUnavailableView(
                    "Choose a conversation",
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
        }
        .alert("Rename conversation", isPresented: $showingRename) {
            TextField("Title", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                guard let id = model.selectedConversationID else { return }
                Task { await model.renameConversation(id: id, title: editValue) }
            }
        }
    }

    private var conversationList: some View {
        List(selection: $model.selectedConversationID) {
            if !active.isEmpty {
                Section {
                    ForEach(active) { conversationRow($0) }
                }
            }
            if !archived.isEmpty {
                Section {
                    DisclosureGroup("Archived", isExpanded: $showingArchived) {
                        ForEach(archived) { conversationRow($0) }
                    }
                }
            }
        }
        .overlay {
            switch model.phase {
            case .idle, .loading:
                ProgressView("Loading conversations…")
            case .ready where model.conversations.isEmpty,
                 .offline where model.conversations.isEmpty:
                ContentUnavailableView(
                    "No conversations",
                    systemImage: "bubble.left",
                    description: Text("Create a conversation to begin.")
                )
            case .failed where model.conversations.isEmpty:
                ContentUnavailableView(
                    "Conversations unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(model.lastErrorDescription ?? "Try again.")
                )
            default:
                EmptyView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if model.conflictedMutationCount > 0 {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                    Text("A conversation changed on another device.")
                        .lineLimit(2)
                    Spacer()
                    Button("Keep mine") {
                        Task { await model.resolveConflicts(keepLocalChanges: true) }
                    }
                    Button("Use server") {
                        Task { await model.resolveConflicts(keepLocalChanges: false) }
                    }
                }
                .font(.caption)
                .padding(10)
                .background(.bar)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("juno.mac.conversation-conflict")
            } else if model.phase == .offline || model.lastErrorDescription != nil {
                HStack(spacing: 8) {
                    Image(systemName: model.phase == .offline ? "wifi.slash" : "exclamationmark.circle")
                    Text(model.lastErrorDescription ?? "Offline — showing saved conversations.")
                        .lineLimit(2)
                    Spacer()
                    Button("Retry") { Task { await model.reload() } }
                }
                .font(.caption)
                .padding(10)
                .background(.bar)
            }
        }
        .accessibilityIdentifier("juno.mac.conversation-list")
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if conversation.pinned {
                    Image(systemName: "pin.fill").font(.caption2)
                }
                Text(conversation.title).lineLimit(1)
                Spacer(minLength: 4)
                if conversation.isPending {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Waiting to sync")
                }
            }
            HStack {
                Text(conversation.model).lineLimit(1)
                Spacer()
                Text(conversation.lastMessageAt, style: .relative)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .tag(conversation.id)
        .contextMenu {
            Button(conversation.pinned ? "Unpin" : "Pin") {
                Task { await model.setPinned(id: conversation.id, pinned: !conversation.pinned) }
            }
            Button(conversation.isArchived ? "Unarchive" : "Archive") {
                Task {
                    await model.setArchived(id: conversation.id, archived: !conversation.isArchived)
                }
            }
        }
    }

    private func beginRename() {
        editValue = model.selectedConversation?.title ?? ""
        showingRename = true
    }
}

private struct JunoMacConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    let rename: () -> Void
    let togglePin: () -> Void
    let toggleArchive: () -> Void
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @State private var isNearBottom = true

    private let bottomAnchor = "juno.chat.bottom"

    private var messages: [NativeChatMessage] {
        model.messages(for: conversation.id)
    }

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    /// Changes whenever streamed content grows or a message is added, driving
    /// the follow-the-stream auto-scroll.
    private var streamSignature: Int {
        let last = messages.last
        return messages.count
            + (last?.content.count ?? 0)
            + (last?.reasoning?.count ?? 0)
    }

    var body: some View {
        VStack(spacing: 0) {
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
                        LazyVStack(spacing: 18) {
                            ForEach(messages) { message in
                                JunoMacMessageRow(message: message)
                            }
                        }
                        .padding(24)
                        .frame(maxWidth: 900, alignment: .center)
                        .frame(maxWidth: .infinity)
                        Color.clear.frame(height: 1).id(bottomAnchor)
                    }
                }
                .background(Color.junoCanvas)
                .defaultScrollAnchor(.bottom)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.contentSize.height
                        - geometry.contentOffset.y
                        - geometry.containerSize.height
                } action: { _, distanceFromBottom in
                    isNearBottom = distanceFromBottom < 120
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
                                .padding(10)
                        }
                        .buttonStyle(.borderless)
                        .background(.regularMaterial, in: Circle())
                        .overlay(Circle().strokeBorder(.separator))
                        .padding(20)
                        .transition(.scale.combined(with: .opacity))
                        .help("Scroll to latest")
                        .accessibilityLabel("Scroll to latest")
                    }
                }
            }
            Divider()
            composer
        }
        .navigationTitle(conversation.title)
        .toolbar {
            ToolbarItem {
                Menu {
                    Button("Rename", action: rename)
                    Divider()
                    Button(conversation.pinned ? "Unpin" : "Pin", action: togglePin)
                    Button(conversation.isArchived ? "Unarchive" : "Archive", action: toggleArchive)
                } label: {
                    Label("Conversation actions", systemImage: "ellipsis.circle")
                }
                .disabled(model.isMutating || conversation.isPending)
            }
        }
        .onAppear { configureSelections() }
        .onChange(of: conversation.id) { _, _ in configureSelections() }
        .onChange(of: selectedModelID) { _, _ in configureSelections() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
        .accessibilityIdentifier("juno.mac.conversation-detail")
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
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
                    .labelsHidden()
                    .frame(maxWidth: 300)
                }
                if let selectedModel, !selectedModel.supportedReasoningEfforts.isEmpty {
                    Picker("Reasoning", selection: $reasoningEffort) {
                        if selectedModel.canDisableReasoning {
                            Text("Instant").tag(nil as NativeReasoningEffort?)
                        }
                        ForEach(selectedModel.supportedReasoningEfforts) { effort in
                            Text(effort.rawValue.capitalized)
                                .tag(effort as NativeReasoningEffort?)
                        }
                    }
                    .frame(maxWidth: 150)
                }
                Spacer()
                if model.chatPhase != .idle {
                    Label(chatPhaseLabel, systemImage: chatPhaseSymbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $prompt)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 54, maxHeight: 140)
                    .padding(8)
                    .background(JunoGlassBackground(cornerRadius: 14))
                    .accessibilityLabel("Message")
                    .accessibilityIdentifier("juno.mac.chat-composer")

                if generatingHere {
                    Button {
                        model.stopGeneration()
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .accessibilityIdentifier("juno.mac.chat-stop")
                } else {
                    Button(action: send) {
                        Label("Send", systemImage: "arrow.up.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(sendDisabled)
                    .accessibilityIdentifier("juno.mac.chat-send")
                }
            }

            if model.canRetrySelectedConversation && !model.isGenerating {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(model.chatErrorDescription ?? "The response was interrupted.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry response") {
                        model.retryLastMessage(conversationID: conversation.id)
                    }
                    .accessibilityIdentifier("juno.mac.chat-retry")
                }
            }
        }
        .padding(14)
        .background(.bar)
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || conversation.isPending
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

    private var chatPhaseLabel: String {
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

    private var chatPhaseSymbol: String {
        switch model.chatPhase {
        case .reconnecting: "wifi.exclamationmark"
        case .failed: "exclamationmark.circle"
        case .stopping: "stop.circle"
        default: "sparkles"
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

private struct JunoMacMessageRow: View {
    let message: NativeChatMessage

    private var isUser: Bool { message.role == .user }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if isUser { Spacer(minLength: 72) }
            if !isUser {
                Image(systemName: "sparkle")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 22, height: 22)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 8) {
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
                        Label("Reasoning", systemImage: "brain")
                            .junoMetadata()
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
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contextMenu {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.content, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .disabled(message.content.isEmpty)
            }
            if !isUser { Spacer(minLength: 72) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isUser ? "You said" : "Juno replied")
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if isUser {
            Color.junoAccent.opacity(0.14)
        } else {
            Color.junoSurface
        }
    }
}
