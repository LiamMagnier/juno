import JunoDesignSystem
import SwiftUI

/// Every keyboard shortcut the app answers, on one page, behind ⌘/.
///
/// A window rather than a sheet so it can sit beside the window the reader is
/// learning — and rather than a link to the website's help page, which is
/// where this used to point: a list of the keys an app answers belongs in the
/// app, offline, and in the same words the menu bar uses.
///
/// The table is data, not views, so a shortcut added to a menu can be added
/// here on the same line and a test can check the page is not empty.
struct DesktopShortcutsWindow: View {
    struct Shortcut: Identifiable {
        let keys: String
        let action: String
        var id: String { keys + action }
    }

    struct Group: Identifiable {
        let title: String
        let shortcuts: [Shortcut]
        var id: String { title }
    }

    static let groups: [Group] = [
        Group(title: "Everywhere", shortcuts: [
            Shortcut(keys: "⌘1 · ⌘2 · ⌘3", action: "Chat · Code · Work"),
            Shortcut(keys: "⌘N", action: "New chat, task or run — whichever the window is showing"),
            Shortcut(keys: "⇧⌘O", action: "New chat"),
            Shortcut(keys: "⇧⌘N", action: "New incognito window"),
            Shortcut(keys: "⇧⌘F", action: "Find in Juno"),
            Shortcut(keys: "⌥Space", action: "Ask Juno from anywhere"),
            Shortcut(keys: "⌘,", action: "Settings"),
            Shortcut(keys: "⌘/", action: "This list"),
        ]),
        Group(title: "Chat", shortcuts: [
            Shortcut(keys: "⌘↩", action: "Send"),
            Shortcut(keys: "⇧↩", action: "New line"),
            Shortcut(keys: "⌘.", action: "Stop"),
            Shortcut(keys: "⇧⌘1", action: "Attach a screenshot"),
        ]),
        Group(title: "Code", shortcuts: [
            Shortcut(keys: "⌘K", action: "Command palette"),
            Shortcut(keys: "⌘O", action: "Open folder"),
            Shortcut(keys: "⇧⌘[ · ⇧⌘]", action: "Previous · next session"),
            Shortcut(keys: "⌘↩", action: "Send, steer or queue"),
            Shortcut(keys: "⌘.", action: "Stop the run"),
            Shortcut(keys: "⇧↩ · ⇧⎋", action: "Approve · deny the focused request"),
            Shortcut(keys: "⌥⌘R", action: "Review pane"),
            Shortcut(keys: "⌥⌘C", action: "Console"),
            Shortcut(keys: "⌥⌘I", action: "Context rail"),
            Shortcut(keys: "⌥⌘P", action: "Preview"),
            Shortcut(keys: "⌥⇧⌘O", action: "Open file"),
            Shortcut(keys: "⇧⌘↩", action: "Send review comments to Juno"),
            Shortcut(keys: "/", action: "Slash commands · /compact folds the context"),
            Shortcut(keys: "@", action: "Mention a file"),
        ]),
    ]

    var body: some View {
        JunoDetailPage(maxWidth: JunoReadingMeasure.reading) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                Text("Keyboard shortcuts")
                    .junoPageHeading()
                    .accessibilityAddTraits(.isHeader)
                ForEach(Self.groups) { group in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Text(group.title)
                            .junoSidebarSection()
                        VStack(spacing: 0) {
                            ForEach(Array(group.shortcuts.enumerated()), id: \.element.id) { index, shortcut in
                                if index > 0 {
                                    Divider().overlay(Color.junoSeparator)
                                }
                                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
                                    Text(shortcut.keys)
                                        .junoFont(size: 12, relativeTo: .caption, weight: .medium, design: .rounded)
                                        .junoInk()
                                        .frame(width: 150, alignment: .leading)
                                    Text(shortcut.action)
                                        .junoRowLabel()
                                        .junoSecondaryInk()
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, JunoSpace.regular)
                                .padding(.vertical, JunoSpace.snug)
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .junoCard(cornerRadius: JunoRadius.card)
                    }
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 520, idealHeight: 720)
        .junoReadingCanvas()
        .accessibilityIdentifier("juno.desktop.shortcuts")
    }
}
