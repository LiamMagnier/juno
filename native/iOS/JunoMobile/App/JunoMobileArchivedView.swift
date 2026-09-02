import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Settings › Archived chats: everything the reader put away, with a way back.
///
/// Archive used to be a one-way door on the phone — the store had the field
/// and the sync carried it, but no screen listed archived conversations, so
/// archiving one was indistinguishable from losing it. This is the other side
/// of that door: a plain list, newest first, where a swipe restores or deletes.
struct JunoMobileArchivedView: View {
  @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
  let openConversation: (String) -> Void

  @State private var deleteTarget: NativeConversation?
  @State private var restoreHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @State private var query = ""

  private var archived: [NativeConversation] {
    let all = model.conversations
      .filter(\.isArchived)
      .sorted { ($0.archivedAt ?? .distantPast) > ($1.archivedAt ?? .distantPast) }
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return all }
    return all.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
  }

  var body: some View {
    Group {
      if archived.isEmpty, query.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No archived chats")
          } icon: {
            Image(systemName: "archivebox")
          }
        } description: {
          Text("Swipe a chat in the sidebar to archive it. It stays here until you restore or delete it.")
        }
      } else {
        List {
          ForEach(archived) { conversation in
            Button {
              openConversation(conversation.id)
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                  .junoRowLabel()
                  .foregroundStyle(.primary)
                  .lineLimit(2)
                if let archivedAt = conversation.archivedAt {
                  Text("Archived \(archivedAt.formatted(.relative(presentation: .named)))")
                    .junoCaption()
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
              Button {
                restoreHaptic.fire()
                Task { await model.setArchived(id: conversation.id, archived: false) }
              } label: {
                Label("Restore", systemImage: "arrow.uturn.backward")
              }
              .tint(Color.junoAccent)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              Button(role: .destructive) {
                deleteTarget = conversation
              } label: {
                Label("Delete", systemImage: "trash")
              }
            }
            .contextMenu {
              Button {
                restoreHaptic.fire()
                Task { await model.setArchived(id: conversation.id, archived: false) }
              } label: {
                Label("Restore", systemImage: "arrow.uturn.backward")
              }
              Button(role: .destructive) {
                deleteTarget = conversation
              } label: {
                Label { Text("Delete") } icon: { JunoIconView(.trash, size: 15) }
              }
            }
            .disabled(conversation.isPending)
          }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .searchable(text: $query, prompt: "Search archived chats")
        .overlay {
          if archived.isEmpty {
            ContentUnavailableView.search(text: query)
          }
        }
      }
    }
    .junoScreenCanvas()
    .navigationTitle("Archived chats")
    .navigationBarTitleDisplayMode(.inline)
    .junoHaptic(JunoMobileHaptic.pin, trigger: restoreHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
    .confirmationDialog(
      deleteTarget.map { "Delete “\($0.title)”?" } ?? "",
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        deleteHaptic.fire()
        Task { await model.deleteConversation(id: target.id) }
      }
      Button("Cancel", role: .cancel) { deleteTarget = nil }
    } message: {
      Text("chat.delete.warning")
    }
    .accessibilityIdentifier("juno.mobile.archived")
  }
}
