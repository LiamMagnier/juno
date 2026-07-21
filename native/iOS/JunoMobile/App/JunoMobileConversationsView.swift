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

    private var messages: [NativeChatMessage] {
        model.messagesByConversation[conversation.id] ?? []
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
        .accessibilityIdentifier("juno.mobile.conversation-detail")
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
                if let model = message.model, !model.isEmpty {
                    Text(model).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(12)
            .background(message.role == .user ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if message.role != .user { Spacer(minLength: 44) }
        }
    }
}
