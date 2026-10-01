import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The `@` menu (CODE_AGENT_SPEC §5.12): `@diff` and the session's running
/// shells first, then files and folders from the workspace index, ranked by
/// name. Choosing one puts its reference in the draft as plain text the
/// reader can read and edit; it is resolved when the message is sent.
struct StudioMentionPicker: View {
    let special: [ComposerMention]
    let files: [FileEntry]
    let highlighted: Int
    var isSearching = false
    let choose: (Int) -> Void

    var body: some View {
        StudioSuggestionList(
            rows: special.map(Self.row) + files.map(Self.row),
            highlighted: highlighted,
            isSearching: isSearching,
            choose: choose
        )
        .accessibilityIdentifier("juno.code.composer.mentions")
    }

    static func row(_ mention: ComposerMention) -> StudioSuggestionList.Row {
        switch mention {
        case .diff:
            .init(id: "mention.diff", title: "@diff", detail: "The uncommitted changes", isMono: true)
        case let .shell(id):
            .init(id: "mention.shell.\(id)", title: "@shell:\(id)", detail: "This shell's latest output", isMono: true)
        case let .preview(route):
            .init(id: "mention.preview.\(route)", title: "@preview:\(route)", detail: "The Preview at this route", isMono: true)
        case let .folder(path):
            .init(id: "mention.folder.\(path.value)", title: path.value, detail: "Folder, listed two levels deep", isMono: true)
        }
    }

    static func row(_ entry: FileEntry) -> StudioSuggestionList.Row {
        .init(
            id: entry.path.value,
            title: entry.path.value,
            detail: entry.isDirectory ? "Folder, listed two levels deep" : nil,
            isMono: true
        )
    }
}
