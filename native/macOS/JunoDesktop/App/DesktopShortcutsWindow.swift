import JunoDesignSystem
import SwiftUI

/// Every keyboard shortcut the app answers, behind ⌘/ (§7.9; Phase 3 brief A4).
///
/// A window rather than a sheet so it can sit beside the window the reader is
/// learning, and generated from ``JunoShortcutRegistry`` — the list the menu
/// bar is built from — so a key added to a menu is listed here by the same
/// line, and a key that is listed here is one the app really answers.
///
/// The web's `ShortcutsSheet`, as a Mac window: its groups (plus Code and the
/// Mac's own keys, P3-20) in two balanced columns, rows on hairlines, no zebra
/// striping, no table chrome and no count. The group headings are SF, not the
/// web's mono label (P3-22).
///
/// **Signature detail:** every key is its own cap. ⇧ ⌘ F is three presses,
/// three equal squares, never the code "⇧⌘F".
struct DesktopShortcutsWindow: View {
    var groups: [JunoShortcutListGroup] = JunoShortcutRegistry.groups

    var body: some View {
        let layout = DesktopShortcutsLayout(groups: groups)
        ScrollView {
            HStack(alignment: .top, spacing: DesktopShortcutsLayout.columnGap) {
                column(layout.leading)
                column(layout.trailing)
            }
            .padding(DesktopShortcutsLayout.margin)
        }
        .scrollBounceBehavior(.basedOnSize)
        // Sized to the list: the window opens exactly as tall as its groups,
        // and scrolls only if a small screen makes it shorter.
        .frame(width: DesktopShortcutsLayout.width)
        .frame(minHeight: 320, idealHeight: layout.height, maxHeight: layout.height)
        .background(Color.junoCanvas)
        .containerBackground(Color.junoCanvas, for: .window)
        .accessibilityIdentifier("juno.desktop.shortcuts")
    }

    private func column(_ groups: [JunoShortcutListGroup]) -> some View {
        VStack(alignment: .leading, spacing: DesktopShortcutsLayout.groupGap) {
            ForEach(groups) { group in
                DesktopShortcutGroupView(group: group)
            }
        }
        .frame(width: DesktopShortcutsLayout.columnWidth, alignment: .topLeading)
    }
}

/// How the groups split into two columns, and how tall the window is — read
/// from the registry, never measured, so the window opens at its final size.
struct DesktopShortcutsLayout {
    static let width: CGFloat = 640
    static let margin: CGFloat = JunoSpace.section
    static let columnGap: CGFloat = JunoSpace.region
    static let columnWidth: CGFloat = (width - margin * 2 - columnGap) / 2
    static let rowHeight: CGFloat = 32
    /// The heading's line, and the space between it and its first row.
    static let headingHeight: CGFloat = 20
    static let headingGap: CGFloat = JunoSpace.hairline
    /// Space above every group but a column's first.
    static let groupGap: CGFloat = JunoSpace.section

    let leading: [JunoShortcutListGroup]
    let trailing: [JunoShortcutListGroup]

    /// The two columns: groups in order, never split, divided where the
    /// taller column is shortest.
    init(groups: [JunoShortcutListGroup]) {
        var best = (split: groups.count, height: CGFloat.infinity)
        for split in 0...groups.count {
            let tallest = max(
                Self.columnHeight(Array(groups[..<split])),
                Self.columnHeight(Array(groups[split...]))
            )
            if tallest < best.height { best = (split, tallest) }
        }
        leading = Array(groups[..<best.split])
        trailing = Array(groups[best.split...])
    }

    /// The content's height: the taller column and the margins.
    var height: CGFloat {
        max(Self.columnHeight(leading), Self.columnHeight(trailing)) + Self.margin * 2
    }

    static func columnHeight(_ groups: [JunoShortcutListGroup]) -> CGFloat {
        guard !groups.isEmpty else { return 0 }
        let groupsHeight = groups.reduce(CGFloat(0)) { total, group in
            total + headingHeight + headingGap + CGFloat(group.rows.count) * rowHeight
        }
        return groupsHeight + CGFloat(groups.count - 1) * groupGap
    }
}

/// A group: its heading, then its rows on hairlines.
private struct DesktopShortcutGroupView: View {
    let group: JunoShortcutListGroup
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        VStack(alignment: .leading, spacing: DesktopShortcutsLayout.headingGap) {
            Text(group.title)
                .junoType(.ui.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(height: DesktopShortcutsLayout.headingHeight, alignment: .bottomLeading)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                    DesktopShortcutRowView(row: row)
                        .overlay(alignment: .top) {
                            // Between rows only, as the web's `divide-y`.
                            if index > 0 {
                                Rectangle()
                                    .fill(Color.junoBorder.opacity(hairline))
                                    .frame(height: 1)
                            }
                        }
                }
            }
        }
    }

    private var hairline: Double {
        JunoHairline.opacity(increaseContrast: contrast == .increased) * 0.75
    }
}

/// One row: the label on the left, its chord (or chords) on the right, read
/// by VoiceOver as one element — "Search, Shift Command F".
private struct DesktopShortcutRowView: View {
    let row: JunoShortcutListRow

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Text(row.label)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Spacer(minLength: 0)
            HStack(spacing: JunoSpace.snug) {
                ForEach(Array(row.chords.enumerated()), id: \.offset) { index, chord in
                    if index > 0 {
                        Text("or")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    DesktopKeycapChord(keys: chord)
                }
            }
            .fixedSize()
        }
        .frame(height: DesktopShortcutsLayout.rowHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

/// A chord as separate caps, 4pt apart.
struct DesktopKeycapChord: View {
    let keys: [String]

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                DesktopKeycap(key: key)
            }
        }
    }
}

/// One key: the web's `Kbd` — an inset well in the mono metadata voice,
/// secondary ink (never tertiary: a keycap is read), 20 tall, at least 20
/// wide, so a run of modifiers reads as a row of equal squares.
struct DesktopKeycap: View {
    let key: String
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Text(verbatim: key)
            .junoType(.micro.weight(.medium))
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, key.count > 1 ? JunoSpace.tight : 0)
            .frame(minWidth: 20, minHeight: 20, maxHeight: 20)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                    .fill(Color.junoSecondary)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(contrast == .increased ? 1 : 0.6), lineWidth: 1)
            }
            .accessibilityHidden(true)
    }
}
