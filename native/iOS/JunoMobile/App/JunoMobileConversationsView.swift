import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// Compact synchronization indicator; tapping it forces a refresh.
struct JunoMobileSyncButton: View {
    let model: NativeSyncModel<SQLiteAccountRepository>

    var body: some View {
        Button {
            Task { await model.refresh() }
        } label: {
            switch model.phase {
            case .idle, .synchronizing:
                ProgressView().controlSize(.small)
            case .live:
                Image(systemName: "checkmark.icloud")
            case .offline:
                Image(systemName: "icloud.slash")
            }
        }
        .accessibilityLabel(model.phase == .offline ? Text("sync.offline") : Text("sync.synced"))
        .accessibilityIdentifier("juno.mobile.sync-status")
    }
}

struct JunoMobileConversationsView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
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
                if let syncModel {
                    ToolbarItem(placement: .topBarLeading) {
                        JunoMobileSyncButton(model: syncModel)
                    }
                }
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
                if model.conflictedMutationCount > 0 {
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                            Text("A conversation changed on another device.")
                                .lineLimit(2)
                            Spacer()
                        }
                        HStack {
                            Button("Keep mine") {
                                Task { await model.resolveConflicts(keepLocalChanges: true) }
                            }
                            Spacer()
                            Button("Use server version") {
                                Task { await model.resolveConflicts(keepLocalChanges: false) }
                            }
                        }
                    }
                    .font(.caption)
                    .padding(10)
                    .background(.bar)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("juno.mobile.conversation-conflict")
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
        }
        .onAppear {
            if let id = model.selectedConversationID, path.last != id {
                path = [id]
            }
        }
        .onChange(of: model.selectedConversationID) { _, id in
            guard let id, path.last != id else { return }
            path = [id]
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
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height
                    - geometry.contentOffset.y
                    - geometry.containerSize.height
                    + geometry.contentInsets.bottom
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
