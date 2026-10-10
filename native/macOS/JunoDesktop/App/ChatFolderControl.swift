import JunoDesignSystem
import JunoWorkRuntime
import SwiftUI

/// "Work in a folder": the composer's control for the folder a chat works in.
///
/// Self-contained, so it can move: today it sits in the composer's controls
/// row after `+`; the composer tray (`native/composer-tray`) gives it a slot
/// of its own, and it drops in there unchanged — it needs only the
/// conversation it belongs to and the store in the environment.
///
/// **Before a folder is chosen** it is one quiet glyph, a capsule of the row's
/// height like `+`. **After**, it is a capsule naming the folder — a lock
/// glyph when the folder is read only, never a pill or a dot — whose menu
/// switches the access, picks another folder or stops; the × beside the name
/// stops at once.
///
/// Hidden where a chat cannot work in a folder: no store in the environment
/// (the phone, previews), and private chats, whose turns carry no tools.
struct ChatFolderControl: View {
    /// The conversation, or nil for the new-chat composer (its draft).
    let conversationID: String?

    @Environment(\.desktopChatFolders) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let store {
            Group {
                if let folder = store.folder(for: conversationID) {
                    chosen(folder, store: store)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .leading)))
                } else {
                    choose(store)
                        .transition(.opacity)
                }
            }
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: store.folder(for: conversationID))
        }
    }

    private func choose(_ store: DesktopChatFolderStore) -> some View {
        Button {
            store.choose(for: conversationID)
        } label: {
            JunoIconView(.folderPlus, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
        }
        .buttonStyle(ComposerControlStyle())
        .fixedSize()
        .help("Work in a folder on this Mac")
        .accessibilityLabel("Work in a folder")
        .accessibilityIdentifier("juno.desktop.chat.folder.choose")
    }

    private func chosen(_ folder: DesktopChatFolderStore.Folder, store: DesktopChatFolderStore) -> some View {
        HStack(spacing: 0) {
            Menu {
                Section(folder.isReachable ? "Alevr works only inside this folder" : "This folder can't be found") {
                    Picker("Access", selection: Binding(
                        get: { folder.access },
                        set: { store.setAccess($0, for: conversationID) }
                    )) {
                        Text("Read and Write").tag(ChatFolderAccess.readWrite)
                        Text("Read Only").tag(ChatFolderAccess.read)
                    }
                    .pickerStyle(.inline)
                }
                Divider()
                Button("Choose Another Folder…") { store.choose(for: conversationID, access: folder.access) }
                Button("Stop Working in \(folder.name)") { store.remove(for: conversationID) }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(folder.isReachable ? .folderOpen : .warning, size: 15)
                        .foregroundStyle(folder.isReachable ? Color.junoForeground : Color.junoWarningInk)
                    Text(folder.name)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 168, alignment: .leading)
                        .fixedSize(horizontal: true, vertical: false)
                    if folder.access == .read {
                        JunoIconView(.lock, size: 11)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .accessibilityLabel("Read only")
                    }
                }
                .padding(.leading, JunoSpace.snug)
                .padding(.trailing, JunoSpace.hairline)
                .frame(height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(folder.access == .read
                ? "\(folder.name) · read only. Alevr can look, not change."
                : "\(folder.name) · Alevr can read and change files here, and asks first before deleting, replacing, running or opening anything.")
            .accessibilityLabel("Working in \(folder.name)")
            .accessibilityValue(folder.access == .read ? "Read only" : "Read and write")
            .accessibilityIdentifier("juno.desktop.chat.folder")

            Button {
                store.remove(for: conversationID)
            } label: {
                JunoIconView(.close, size: 10, weight: .bold)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 24, height: 24)
                    .contentShape(.rect)
            }
            .buttonStyle(ComposerControlStyle())
            .help("Stop working in \(folder.name)")
            .accessibilityLabel("Stop working in \(folder.name)")
            .accessibilityIdentifier("juno.desktop.chat.folder.remove")
            .padding(.trailing, JunoSpace.hairline)
        }
        .background(
            Capsule(style: .continuous)
                .fill(Color.junoGlassHover)
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.55), lineWidth: 0.5)
        )
        .fixedSize()
    }
}
