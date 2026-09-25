import JunoDesignSystem
import SwiftUI

/// Every keyboard shortcut the app answers, in one native table, behind ⌘/.
///
/// A window rather than a sheet so it can sit beside the window the reader is
/// learning — and rather than a link to the website's help page, which is
/// where this used to point: a list of the keys an app answers belongs in the
/// app, offline, and in the same words the menu bar uses.
///
/// A `Table`, not a hand-drawn list of cards. The platform's table brings the
/// alternating rows, the column headers, the resizable columns and the
/// selection the reader already knows from every other Mac app, and it costs
/// nothing to keep right when the platform moves.
///
/// The rows are data, so a shortcut added to a menu can be added here on the
/// same line and a test can check the page is not empty.
struct DesktopShortcutsWindow: View {
    struct Shortcut: Identifiable {
        let keys: String
        let action: String
        /// Where the shortcut answers: everywhere, or one product.
        let scope: String
        var id: String { scope + keys + action }
    }

    struct Group: Identifiable {
        let title: String
        let shortcuts: [Shortcut]
        var id: String { title }

        init(title: String, shortcuts: [(String, String)]) {
            self.title = title
            self.shortcuts = shortcuts.map { Shortcut(keys: $0.0, action: $0.1, scope: title) }
        }
    }

    static let groups: [Group] = [
        Group(title: "Everywhere", shortcuts: [
            ("⌘1 · ⌘2", "Chat · Code"),
            ("⌘N", "New chat in Chat, new task in Code"),
            ("⇧⌘O", "New chat"),
            ("⇧⌘N", "New private chat"),
            ("⇧⌘F", "Find in Juno"),
            ("⌥Space", "Ask Juno from anywhere"),
            ("⌘,", "Settings"),
            ("⌃⌘S", "Show or hide the sidebar"),
            ("⌘/", "This list"),
        ]),
        // The composer's keys (§5.9): Return sends — the old "⌘↩" row was never
        // true of this composer — and ↑ in an empty field reopens the last
        // message.
        Group(title: "Chat", shortcuts: [
            ("↩", "Send"),
            ("⇧↩", "New line"),
            ("↑", "Edit your last message"),
            ("⌘.", "Stop"),
            ("⌘U", "Attach files"),
            ("⇧⌘U", "Attach a screenshot"),
        ]),
        Group(title: "Code", shortcuts: [
            ("⌘K", "Command palette"),
            ("⌘O", "Open folder"),
            ("⇧⌘[ · ⇧⌘]", "Previous · next session"),
            ("⌘↩", "Send, steer or queue"),
            ("⌘.", "Stop the run"),
            ("↩ · ⌘↩ · ⎋", "Allow · always allow · decline the focused request"),
            ("⌥⌘R", "Changes"),
            ("⌥⌘C", "Terminal"),
            ("⌥⌘I", "Side panel"),
            ("⌥⌘P", "Preview"),
            ("⌥⇧⌘O", "Open file"),
            ("⇧⌘↩", "Send review comments to Juno"),
            ("/", "Slash commands · /compact folds the context"),
            ("@", "Mention a file"),
        ]),
    ]

    // No Work group: Work is not a product any more (§1.6); tasks live in
    // the chats that started them.

    /// Every row, in group order, for the one table.
    static let shortcuts: [Shortcut] = groups.flatMap(\.shortcuts)

    @State private var selection: Shortcut.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Keyboard shortcuts")
                    .junoPageHeading()
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Text("\(Self.shortcuts.count) shortcuts")
                    .junoCaption()
                    .monospacedDigit()
            }
            .padding(.horizontal, JunoSpace.section)
            .padding(.top, JunoSpace.section)
            .padding(.bottom, JunoSpace.cozy)

            Table(Self.shortcuts, selection: $selection) {
                TableColumn("Shortcut") { shortcut in
                    Text(shortcut.keys)
                        .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                        .junoInk()
                }
                .width(min: 120, ideal: 140, max: 180)
                TableColumn("Action") { shortcut in
                    Text(shortcut.action)
                        .junoRowLabel()
                }
                TableColumn("Where") { shortcut in
                    Text(shortcut.scope)
                        .junoCaption()
                }
                .width(min: 80, ideal: 96, max: 120)
            }
            .tableStyle(.inset(alternatesRowBackgrounds: true))
            .scrollContentBackground(.hidden)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.regular)
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 520, idealHeight: 720)
        .junoReadingCanvas()
        .accessibilityIdentifier("juno.desktop.shortcuts")
    }
}
