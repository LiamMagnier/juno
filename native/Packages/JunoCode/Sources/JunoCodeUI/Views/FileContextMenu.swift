import Foundation
import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// File-name suggestions anchored above the composer while an `@name` token is
/// active.
///
/// Like the slash-command menu, this stays a bounded overlay rather than a
/// popover and never becomes focusable. The text field owns Up, Down, Return
/// and Escape for the entire interaction.
@available(macOS 26.0, *)
struct FileContextMenu: View {
    let entries: [FileEntry]
    let highlighted: Int
    let isSearching: Bool
    let choose: (FileEntry) -> Void

    private static let maximumVisibleRows = 7
    private static let rowHeight: CGFloat = 50

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.tight) {
            VStack(spacing: 0) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconLabel("Workspace files", icon: .search)
                        .font(.caption.weight(.medium))
                        .junoSecondaryInk()
                    Spacer(minLength: JunoSpace.snug)
                    if isSearching {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityLabel("Searching workspace files")
                            .accessibilityIdentifier("juno.code.composer.file-searching")
                    }
                }
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.tight)

                if !entries.isEmpty {
                    Divider().overlay(Color.junoSeparator)
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(entries.enumerated()), id: \.element.id) {
                                    index,
                                    entry in
                                    row(entry, isHighlighted: index == highlighted)
                                        .id(index)
                                }
                            }
                            .padding(JunoSpace.hairline)
                        }
                        .scrollIndicators(.hidden)
                        .frame(
                            maxHeight: Self.rowHeight
                                * CGFloat(min(entries.count, Self.maximumVisibleRows))
                        )
                        .onChange(of: highlighted) { _, index in
                            withAnimation(JunoMotion.fast) {
                                proxy.scrollTo(index, anchor: .center)
                            }
                        }
                    }
                }
            }
            .junoFloatingChrome(cornerRadius: JunoRadius.well)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Workspace file suggestions")
        .accessibilityIdentifier("juno.code.composer.file-menu")
    }

    private func row(_ entry: FileEntry, isHighlighted: Bool) -> some View {
        Button {
            choose(entry)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(systemImage: entry.isDirectory ? "folder" : "doc")
                    .foregroundStyle(entry.isDirectory ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.path.lastComponent)
                        .junoMono()
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    HStack(spacing: JunoSpace.tight) {
                        Text(parentPath(for: entry))
                            .lineLimit(1)
                            .truncationMode(.head)
                        Text("·")
                            .accessibilityHidden(true)
                        Text(metadata(for: entry))
                            .fixedSize()
                    }
                    .junoCaption()
                    .junoSecondaryInk()
                }

                Spacer(minLength: JunoSpace.snug)
                if isHighlighted {
                    JunoIconView(.chevronRight, size: 13)
                        .junoMetaInk()
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isHighlighted ? Color.junoRowSelected : .clear)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(entry.path.lastComponent), \(metadata(for: entry)), \(parentPath(for: entry))"
        )
        .accessibilityValue(isHighlighted ? "Selected" : "")
        .accessibilityIdentifier("juno.code.composer.file-result.\(entry.path.value)")
    }

    private func parentPath(for entry: FileEntry) -> String {
        let parent = (entry.path.value as NSString).deletingLastPathComponent
        return parent.isEmpty || parent == "." ? "Workspace root" : parent
    }

    private func metadata(for entry: FileEntry) -> String {
        if entry.isDirectory { return "Folder" }

        let pathExtension = (entry.path.lastComponent as NSString).pathExtension
        let kind = pathExtension.isEmpty
            ? "File"
            : "\(pathExtension.uppercased()) file"
        guard let byteCount = entry.byteCount else { return kind }
        let size = ByteCountFormatter.string(
            fromByteCount: Int64(byteCount),
            countStyle: .file
        )
        return "\(kind), \(size)"
    }
}
