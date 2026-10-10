import JunoChatKit
import JunoDesignSystem
import JunoWorkRuntime
import SwiftUI

/// "Work in a folder": the composer tray's control for the folder a chat
/// works in. It sits first on the tray's line (`ChatComposer.trayLeading`),
/// on a new chat and in a thread alike, in the tray's own pill language
/// (`NativeComposerTrayPillStyle`), so it reads as one of Project · Apps ·
/// Skills rather than a control of its own kind.
///
/// **Before a folder is chosen** it is a pill that says what it does — the
/// folder-plus mark and "Work in a folder" — so in a thread, where it is the
/// tray's only item, the line still reads as a deliberate choice, not a stray
/// glyph. **After**, the pill names the folder (a lock glyph when it is read
/// only, never a status dot) and opens a menu that switches the access, picks
/// another folder or stops; the × beside it stops at once.
///
/// Hidden where a chat cannot work in a folder: no store in the environment
/// (the phone, previews), and private chats, whose turns carry no tools (the
/// tray itself is not drawn there).
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
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.folderPlus, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text("Work in a folder")
            }
        }
        .buttonStyle(NativeComposerTrayPillStyle())
        .fixedSize()
        .help("Work in a folder on this Mac")
        .accessibilityLabel("Work in a folder")
        .accessibilityIdentifier("juno.desktop.chat.folder.choose")
    }

    private func chosen(_ folder: DesktopChatFolderStore.Folder, store: DesktopChatFolderStore) -> some View {
        HStack(spacing: 0) {
            NativeTrayPopoverChip(
                accessibilityLabel: "Working in \(folder.name)",
                identifier: "juno.desktop.chat.folder",
                help: folder.access == .read
                    ? "\(folder.name) \u{00B7} read only. Alevr can look, not change."
                    : "\(folder.name) \u{00B7} Alevr can read and change files here, and asks first before deleting, replacing, running or opening anything."
            ) { close in
                Self.accessList(
                    folder,
                    setAccess: { store.setAccess($0, for: conversationID) },
                    chooseAnother: { store.choose(for: conversationID, access: folder.access) },
                    stop: { store.remove(for: conversationID) },
                    close: close
                )
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(folder.isReachable ? .folderOpen : .warning, size: 16)
                        .foregroundStyle(folder.isReachable ? Color.junoSecondaryInk : Color.junoWarningInk)
                    Text(folder.name)
                        .truncationMode(.middle)
                        .frame(maxWidth: 168, alignment: .leading)
                        .fixedSize(horizontal: true, vertical: false)
                    if folder.access == .read {
                        JunoIconView(.lock, size: 11)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .accessibilityLabel("Read only")
                    }
                }
            }
            .accessibilityValue(folder.access == .read ? "Read only" : "Read and write")

            Button {
                store.remove(for: conversationID)
            } label: {
                // The tray's own pill, square: the same hover tone as the
                // folder pill beside it, tucked in so the two read as one.
                JunoIconView(.close, size: 10, weight: .bold)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 10)
            }
            .buttonStyle(NativeComposerTrayPillStyle())
            .padding(.leading, -JunoSpace.hairline)
            .help("Stop working in \(folder.name)")
            .accessibilityLabel("Stop working in \(folder.name)")
            .accessibilityIdentifier("juno.desktop.chat.folder.remove")
        }
        .fixedSize()
    }

    /// The folder's list: how far Alevr may go in it, another folder, or stop.
    static func accessList(
        _ folder: DesktopChatFolderStore.Folder,
        setAccess: @escaping (ChatFolderAccess) -> Void,
        chooseAnother: @escaping () -> Void,
        stop: @escaping () -> Void,
        cursor: String? = nil,
        close: @escaping () -> Void
    ) -> NativeTrayPicker {
        let rows: [(ChatFolderAccess, String, String, JunoIcon)] = [
            (.readWrite, "Read and write", "Edits files, asks before deleting", .pencil),
            (.read, "Read only", "Looks, never changes anything", .eye),
        ]
        return NativeTrayPicker(
            identifier: "juno.desktop.chat.folder.list",
            header: folder.isReachable ? "Alevr works only inside \(folder.name)" : "\(folder.name) can\u{2019}t be found",
            searchPrompt: "Search…",
            sections: [NativeTrayPickerSection(id: "access", items: rows.map { access, title, subtitle, icon in
                NativeTrayPickerItem(
                    id: access == .read ? "read" : "readWrite",
                    title: title,
                    subtitle: subtitle,
                    accessory: .check(folder.access == access),
                    action: { if folder.access != access { setAccess(access) } }
                ) {
                    NativeTrayPickerTile(icon, isOn: folder.access == access)
                }
            })],
            actions: [
                NativeTrayPickerAction(id: "choose", title: "Choose another folder…", icon: .folderOpen, action: chooseAnother),
                NativeTrayPickerAction(id: "stop", title: "Stop working in \(folder.name)", icon: .close, action: stop),
            ],
            emptyMessage: "",
            cursor: cursor,
            close: close
        )
    }
}
