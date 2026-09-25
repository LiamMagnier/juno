import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 3 Stage A, drawn offscreen in both appearances into
/// `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`:
///
/// - `shortcuts-window` — the Keyboard Shortcuts window at its 640pt width.
/// - `conversation-menu-rows` — the Chat menu and a chat's row menu as plain
///   rows. A real menu cannot be photographed (`ImageRenderer` draws a `Menu`
///   as a placeholder), so the words and glyphs the menus are generated from
///   are drawn here in the system menu's metrics to be looked at.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Stage A snapshots."
    ),
    .serialized
)
struct ShortcutsSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!, isDirectory: true)
    }

    @Test(arguments: ["shortcuts-window", "conversation-menu-rows"])
    func drawsInBothAppearances(_ name: String) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url: URL
            switch name {
            case "shortcuts-window":
                url = try await TranscriptSnapshotRenderer.render(
                    DesktopShortcutsWindow(),
                    name: name,
                    width: DesktopShortcutsLayout.width,
                    appearance: appearance,
                    into: directory
                )
            default:
                url = try await TranscriptSnapshotRenderer.render(
                    MenuRowsSheet(),
                    name: name,
                    width: 640,
                    appearance: appearance,
                    into: directory
                )
            }
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

/// The Chat menu (menu bar) beside a pinned chat's row menu, as rows in the
/// system menu's own metrics: a 16pt glyph, the 13pt title, the chord.
private struct MenuRowsSheet: View {
    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.section) {
            panel("Chat menu, a saved chat on screen") {
                ForEach(Array(JunoShortcutRegistry.sections(in: .chat).enumerated()), id: \.offset) { index, section in
                    if index > 0 { MenuDivider() }
                    ForEach(section) { entry in
                        MenuRow(
                            title: entry.menuTitle ?? "",
                            glyph: entry.glyph,
                            keys: entry.keys
                        )
                    }
                }
                MenuDivider()
                conversationRows(DesktopConversationMenu.rows(pinned: false, renameTitle: "Rename…"))
            }
            panel("Row menu, a pinned chat in a project") {
                conversationRows(DesktopConversationMenu.rows(pinned: true, showsOpenProject: true))
            }
        }
        .padding(JunoSpace.section)
    }

    @ViewBuilder
    private func conversationRows(_ rows: [DesktopConversationMenu.Row]) -> some View {
        ForEach(rows) { row in
            if row.isDestructive { MenuDivider() }
            MenuRow(
                title: row.title,
                glyph: row.glyph,
                isNested: row.isNested,
                isSubmenu: row.kind == .addToProject,
                isDestructive: row.isDestructive
            )
        }
    }

    private func panel<Content: View>(_ caption: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(caption)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: 0) {
                content()
            }
            .padding(5)
            .frame(width: 280, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                    .fill(Color(nsColor: .windowBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
        }
    }
}

private struct MenuRow: View {
    let title: String
    let glyph: JunoIcon?
    var keys: [String] = []
    /// Drawn inside the row above's submenu.
    var isNested = false
    /// Opens a submenu: the system's trailing chevron.
    var isSubmenu = false
    var isDestructive = false

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            if let glyph {
                Image(glyph.assetName)
                    .font(.system(.body))
                    .frame(width: 18)
            }
            Text(title)
                .junoType(.ui)
            Spacer(minLength: JunoSpace.regular)
            if !keys.isEmpty {
                // As the menu bar draws a chord: glyphs run together, and the
                // escape key as ⎋.
                Text(keys.map { $0 == "esc" ? "⎋" : $0 }.joined())
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            if isSubmenu {
                Image(JunoIcon.chevronRight.assetName)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .foregroundStyle(isDestructive ? Color.junoDestructive : Color.junoForeground)
        .padding(.horizontal, 9)
        .frame(height: 24)
        .padding(.leading, isNested ? 20 : 0)
    }
}

private struct MenuDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.junoBorder)
            .frame(height: 1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
    }
}
