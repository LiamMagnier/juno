import JunoChatKit
import JunoStorage
import SwiftUI

struct JunoMobileConversationsView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .idle, .loading:
                    ProgressView("Loading conversations…")
                case .failed where model.conversations.isEmpty:
                    ContentUnavailableView(
                        "Conversations unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(model.lastErrorDescription ?? "Try again.")
                    )
                case .ready where model.conversations.isEmpty,
                     .offline where model.conversations.isEmpty:
                    ContentUnavailableView(
                        "No conversations",
                        systemImage: "bubble.left",
                        description: Text("Create a conversation to begin.")
                    )
                default:
                    conversationList
                }
            }
            .navigationTitle("Conversations")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.createConversation() }
                    } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                    }
                    .disabled(model.isMutating)
                    .accessibilityIdentifier("juno.mobile.conversation-new")
                }
            }
            .navigationDestination(for: String.self) { conversationID in
                if let conversation = model.conversations.first(where: { $0.id == conversationID }) {
                    JunoMobileConversationDetail(model: model, conversation: conversation)
                        .onAppear { model.selectedConversationID = conversationID }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if model.phase == .offline || model.lastErrorDescription != nil {
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
        }
    }

    private var conversationList: some View {
        List {
            let active = model.conversations.filter { !$0.isArchived }
            let archived = model.conversations.filter(\.isArchived)
            Section {
                ForEach(active) { conversationRow($0) }
            }
            if !archived.isEmpty {
                Section("Archived") {
                    ForEach(archived) { conversationRow($0) }
                }
            }
        }
        .accessibilityIdentifier("juno.mobile.conversation-list")
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        NavigationLink(value: conversation.id) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    if conversation.pinned { Image(systemName: "pin.fill").font(.caption2) }
                    Text(conversation.title).lineLimit(1)
                    Spacer()
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
        }
        .swipeActions(edge: .leading) {
            Button {
                Task { await model.setPinned(id: conversation.id, pinned: !conversation.pinned) }
            } label: {
                Label(conversation.pinned ? "Unpin" : "Pin", systemImage: "pin")
            }
            .tint(.orange)
        }
        .swipeActions(edge: .trailing) {
            Button {
                Task {
                    await model.setArchived(id: conversation.id, archived: !conversation.isArchived)
                }
            } label: {
                Label(conversation.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
            }
            .tint(.indigo)
        }
    }
}

private struct JunoMobileConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    @State private var showingRename = false
    @State private var showingModel = false
    @State private var editValue = ""
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
        ScrollView {
            if messages.isEmpty {
                ContentUnavailableView(
                    "No messages yet",
                    systemImage: "bubble.left",
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
            }
        }
        .defaultScrollAnchor(.bottom)
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Rename") {
                        editValue = conversation.title
                        showingRename = true
                    }
                    Button("Change model") {
                        editValue = conversation.model
                        showingModel = true
                    }
                    Divider()
                    Button(conversation.pinned ? "Unpin" : "Pin") {
                        Task {
                            await model.setPinned(id: conversation.id, pinned: !conversation.pinned)
                        }
                    }
                    Button(conversation.isArchived ? "Unarchive" : "Archive") {
                        Task {
                            await model.setArchived(
                                id: conversation.id,
                                archived: !conversation.isArchived
                            )
                        }
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
        .alert("Conversation model", isPresented: $showingModel) {
            TextField("provider:model", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.setModel(id: conversation.id, model: editValue) }
            }
        } message: {
            Text("Use a model identifier from your Juno model catalog.")
        }
        .safeAreaInset(edge: .bottom) { composer }
        .onAppear { configureSelections() }
        .onChange(of: selectedModelID) { _, _ in configureSelections() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
        .accessibilityIdentifier("juno.mobile.conversation-detail")
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
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
                }
                Spacer(minLength: 0)
                if model.chatPhase != .idle {
                    Image(systemName: phaseSymbol)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(phaseLabel)
                }
            }
            .font(.caption)

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(.quaternary.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityIdentifier("juno.mobile.chat-composer")
                    .onSubmit { send() }

                if generatingHere {
                    Button {
                        model.stopGeneration()
                    } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .clipShape(Circle())
                    .accessibilityLabel("Stop generation")
                    .accessibilityIdentifier("juno.mobile.chat-stop")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Circle())
                    .disabled(
                        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || model.isGenerating || conversation.isPending
                    )
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("juno.mobile.chat-send")
                }
            }

            if model.canRetrySelectedConversation && !model.isGenerating {
                HStack {
                    Text(model.chatErrorDescription ?? "The response was interrupted.")
                        .lineLimit(2)
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Retry") {
                        model.retryLastMessage(conversationID: conversation.id)
                    }
                    .accessibilityIdentifier("juno.mobile.chat-retry")
                }
                .font(.caption)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
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

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: 6) {
                Text(message.role == .user ? "You" : "Juno")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(message.content).textSelection(.enabled)
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
            if message.role != .user { Spacer(minLength: 44) }
        }
    }
}
