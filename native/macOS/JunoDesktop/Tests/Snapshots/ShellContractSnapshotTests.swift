import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// The shell contract as the Mac reads it (Phase 6 B), drawn offscreen in both
/// appearances: `$JUNO_SNAPSHOT_DIR/shell/shell-contract-<light|dark>.png`.
///
/// One sheet, every generated list: each product's column (action rows,
/// destinations, More with its archive, headings, the empty lines), the `+`
/// menu's groups as the Mac titles them, the primary disc's faces drawn by the
/// production ``ComposerPrimaryDisc``, and the Settings rail. It is the check
/// that every mark the contract names resolves to a drawn symbol — a mark the
/// generator got wrong would be a blank slot here — and that the derived Title
/// Case reads as a Mac menu should.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the shell contract sheet."
    ),
    .serialized
)
struct ShellContractSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("shell", isDirectory: true)
    }

    @Test func drawsTheContractInBothAppearances() async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                ShellContractSheet(),
                name: "shell-contract",
                width: 1040,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

private struct ShellContractSheet: View {
    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.section) {
            ShellColumn(
                title: "Chat",
                actions: JunoShellChatSidebar.Action.allCases.map { ($0.label, $0.icon) },
                destinations: JunoShellChatSidebar.destinations,
                moreLabel: JunoShellChatSidebar.More.label,
                moreIcon: JunoShellChatSidebar.More.icon,
                more: JunoShellChatSidebar.More.items,
                archived: (JunoShellChatSidebar.More.archivedTitle, JunoShellChatSidebar.More.archivedIcon),
                headings: JunoShellChatSidebar.Heading.allCases.map(\.label),
                empty: JunoShellChatSidebar.emptyLines
            )
            ShellColumn(
                title: "Code",
                actions: JunoShellCodeSidebar.Action.allCases.map { ($0.label, $0.icon) },
                destinations: JunoShellCodeSidebar.destinations,
                moreLabel: JunoShellCodeSidebar.More.label,
                moreIcon: JunoShellCodeSidebar.More.icon,
                more: JunoShellCodeSidebar.More.items,
                archived: (JunoShellCodeSidebar.More.archivedTitle, JunoShellCodeSidebar.More.archivedIcon),
                headings: JunoShellCodeSidebar.Heading.allCases.map(\.label),
                empty: JunoShellCodeSidebar.emptyLines
            )
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                ShellCard(title: "+ menu · chat") { PlusGroups(groups: JunoShellPlusMenu.chat) }
                ShellCard(title: "+ menu · voice") { PlusGroups(groups: JunoShellPlusMenu.voice) }
                ShellCard(title: "Primary action") { Faces() }
            }
            .frame(width: 280)
            ShellCard(title: "Settings") {
                ForEach(JunoShellSettingsSection.allCases, id: \.self) { section in
                    ShellRow(label: section.label, icon: section.icon)
                }
            }
            .frame(width: 200)
        }
        .padding(JunoSpace.region)
    }
}

private struct ShellColumn: View {
    let title: String
    let actions: [(String, JunoIcon)]
    let destinations: [JunoShellDestination]
    let moreLabel: String
    let moreIcon: JunoIcon
    let more: [JunoShellMoreItem]
    let archived: (String, JunoIcon)
    let headings: [String]
    let empty: [String]

    var body: some View {
        ShellCard(title: title) {
            ForEach(actions.indices, id: \.self) { index in
                ShellRow(label: actions[index].0, icon: actions[index].1)
            }
            ForEach(destinations, id: \.self) { destination in
                ShellRow(label: destination.label, icon: destination.icon)
            }
            ShellRow(label: moreLabel, icon: moreIcon)
            ForEach(more, id: \.self) { item in
                ShellRow(label: "\(item.destination.title) · \(item.minPlan.rawValue.capitalized)", icon: item.destination.icon)
                    .padding(.leading, JunoSpace.regular)
            }
            ShellRow(label: archived.0, icon: archived.1)
                .padding(.leading, JunoSpace.regular)
            Divider().padding(.vertical, JunoSpace.tight)
            ForEach(headings, id: \.self) { heading in
                Text(heading)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoSecondaryInk()
                    .frame(height: 22, alignment: .leading)
            }
            Divider().padding(.vertical, JunoSpace.tight)
            ForEach(empty, id: \.self) { line in
                Text(line)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoSecondaryInk()
            }
        }
        .frame(width: 200)
    }
}

private struct PlusGroups: View {
    let groups: [[JunoShellPlusRow]]

    var body: some View {
        ForEach(groups.indices, id: \.self) { index in
            if index > 0 {
                Divider().padding(.vertical, JunoSpace.micro)
            }
            ForEach(groups[index], id: \.self) { row in
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(row.icon, size: 16)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Text(row.title)
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoForeground)
                    Spacer(minLength: 0)
                    Text(kindNote(row))
                        .junoFont(size: 11, relativeTo: .caption2)
                        .junoSecondaryInk()
                }
                .frame(height: 26)
            }
        }
    }

    private func kindNote(_ row: JunoShellPlusRow) -> String {
        let kind = switch row.kind {
        case .action: "action"
        case .toggle: "toggle"
        case .submenu: "submenu ▸"
        }
        return row.isOptional ? "\(kind), optional" : kind
    }
}

private struct Faces: View {
    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            face(.send, "send")
            face(.stop, "stop")
            face(.voice, "voice")
            face(.busy("Uploading"), "busy")
            face(.disabled("Send"), "disabled")
        }
    }

    private func face(_ face: ChatComposerFace, _ name: String) -> some View {
        VStack(spacing: JunoSpace.tight) {
            ComposerPrimaryDisc(face: face) {}
            Text(name)
                .junoFont(size: 11, relativeTo: .caption2)
                .junoSecondaryInk()
        }
    }
}

private struct ShellRow: View {
    let label: String
    let icon: JunoIcon

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(Color.junoSidebarInk)
            Text(label)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
            Spacer(minLength: 0)
        }
        .frame(height: 28)
    }
}

private struct ShellCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .padding(.bottom, JunoSpace.snug)
            content
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoHairline)
        )
    }
}
