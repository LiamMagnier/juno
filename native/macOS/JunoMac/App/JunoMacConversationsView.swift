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
                    conversation: conversation,
                    messages: model.selectedMessages,
                    isBusy: model.isMutating,
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
    let conversation: NativeConversation
    let messages: [NativeChatMessage]
    let isBusy: Bool
    let rename: () -> Void
    let editModel: () -> Void
    let togglePin: () -> Void
    let toggleArchive: () -> Void

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
                LazyVStack(spacing: 18) {
                    ForEach(messages) { message in
                        JunoMacMessageRow(message: message)
                    }
                }
                .padding(24)
            }
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
                .disabled(isBusy || conversation.isPending)
            }
        }
        .accessibilityIdentifier("juno.mac.conversation-detail")
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
                if let model = message.model, !model.isEmpty {
                    Text(model).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(12)
            .background(message.role == .user ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if message.role != .user { Spacer(minLength: 80) }
        }
    }
}
