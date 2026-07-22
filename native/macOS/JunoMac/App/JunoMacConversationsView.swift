import JunoChatKit
import JunoStorage
import SwiftUI

struct JunoMacConversationsView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    @State private var showingArchived = false
    @State private var showingRename = false
    @State private var showingModel = false
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
                    editModel: beginModelEdit,
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
        .alert("Conversation model", isPresented: $showingModel) {
            TextField("provider:model", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                guard let id = model.selectedConversationID else { return }
                Task { await model.setModel(id: id, model: editValue) }
            }
        } message: {
            Text("Use a model identifier from your Juno model catalog.")
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

    private func beginModelEdit() {
        editValue = model.selectedConversation?.model ?? ""
        showingModel = true
    }
}

private struct JunoMacConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    let rename: () -> Void
    let editModel: () -> Void
    let togglePin: () -> Void
    let toggleArchive: () -> Void
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?

    private var messages: [NativeChatMessage] {
        model.messages(for: conversation.id)
    }

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                if messages.isEmpty {
                    ContentUnavailableView(
                        "No messages yet",
                        systemImage: "bubble.left",
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
                }
            }
            .defaultScrollAnchor(.bottom)
            Divider()
            composer
        }
        .navigationTitle(conversation.title)
        .toolbar {
            ToolbarItem {
                Menu {
                    Button("Rename", action: rename)
                    Button("Change model", action: editModel)
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
                    .background(.quaternary.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
                    Button {
                        let value = prompt
                        if model.sendMessage(
                            conversationID: conversation.id,
                            prompt: value,
                            modelID: selectedModelID.isEmpty
                                ? conversation.model : selectedModelID,
                            reasoningEffort: reasoningEffort
                        ) {
                            prompt = ""
                        }
                    } label: {
                        Label("Send", systemImage: "arrow.up.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || model.isGenerating || conversation.isPending
                    )
                    .accessibilityIdentifier("juno.mac.chat-send")
                }
            }

            if model.canRetrySelectedConversation && !model.isGenerating {
                HStack {
                    Text(model.chatErrorDescription ?? "The response was interrupted.")
                        .font(.caption)
                        .foregroundStyle(.red)
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

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 80) }
            VStack(alignment: .leading, spacing: 6) {
                Text(message.role == .user ? "You" : "Juno")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(message.content)
                    .textSelection(.enabled)
                if let reasoning = message.reasoning, !reasoning.isEmpty {
                    DisclosureGroup("Reasoning") {
                        Text(reasoning)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                ForEach(message.sources, id: \.url) { source in
                    Link(source.title, destination: source.url)
                        .font(.caption)
                }
                if let model = message.model, !model.isEmpty {
                    Text(model).font(.caption2).foregroundStyle(.tertiary)
                }
                if message.isPending {
                    ProgressView().controlSize(.small)
                }
                if let error = message.errorDescription {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(12)
            .background(message.role == .user ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if message.role != .user { Spacer(minLength: 80) }
        }
    }
}
