import AppKit
import JunoCodeUI
import JunoDesignSystem
import SwiftUI

/// The menu bar item (§7.10): New Chat, the chats that need you, the Code
/// sessions that are live, and the way back to the window. Chat first: the
/// chats waiting on the reader lead, because they are the reason to glance up
/// here at all.
///
/// Codex and Claude Code both keep a presence in the menu bar so a run left
/// working in another Space still has a status a glance away. This is that. It
/// reads ``DesktopWorkbenchRegistry`` rather than any window, so it is correct
/// with no window open at all — which is exactly when it is most useful.
///
/// **Every item brings the existing window forward.** They used to call
/// `openWindow(id:)`, which on a `WindowGroup` always opens a *new* window
/// (errata 12): three clicks here left three main windows. The request goes
/// through the registry to the window that is already open, and
/// ``JunoDesktopWindow/showMainWindow(using:)`` fronts it, opening one only
/// when there is none.
///
/// **Needs You** (Phase 5 C2) is one item per chat whose task has stopped for
/// the reader, newest first: its title, and the run's status as the item's
/// second line. Choosing one takes the notification's road to the chat
/// (``JunoDesktopWindow/follow(_:)``) rather than opening a window.
///
/// **What is not here.** New task and Ask Juno: a task starts in a chat, and
/// ⌥Space is its own shortcut, listed in Keyboard Shortcuts.
struct DesktopMenuBarExtraContent: View {
    @Environment(\.openWindow) private var openWindow
    @State private var registry = DesktopWorkbenchRegistry.shared
    @State private var signals = DesktopNeedsYouSignals.shared

    // Each group sits in a `Section`, which a menu draws as a separator and
    // nothing else — and which tells the targets gate these are system-drawn
    // menu items, not views laid out here.
    var body: some View {
        Section {
            Button {
                registry.request(.newChat(prompt: nil))
                JunoDesktopWindow.showMainWindow(using: openWindow)
            } label: {
                JunoIconLabel("New Chat", icon: .new)
            }
            .keyboardShortcut("n")
        }

        if !signals.menuItems.isEmpty {
            Section("Needs You") {
                ForEach(signals.menuItems) { item in
                    Button {
                        JunoDesktopWindow.follow(.conversation(id: item.conversationID))
                    } label: {
                        // Two texts: the menu draws the second as the item's
                        // subtitle.
                        Text(verbatim: item.title)
                        Text(verbatim: item.status)
                    }
                    .help("\(item.title): \(item.status)")
                }
            }
        }

        // The runs in words, "2 working, 1 waiting for you", and the way to
        // stop screen control from anywhere (CODE_AGENT_SPEC §1.11).
        if let workbench = registry.workbench {
            if let line = workbench.runSummaryLine {
                Section {
                    Text(verbatim: line)
                }
            }
            if workbench.isScreenControlActive {
                Section {
                    // No key equivalent: ⌥⌘⎋ is the system's Force Quit, so
                    // the menu would advertise a shortcut that opens a
                    // different window. The global Esc stop is §3.7's.
                    Button("Stop Screen Control") {
                        Task { await workbench.stopAllScreenControl() }
                    }
                }
            }
        }

        let sessions = registry.activeSessions
        if !sessions.isEmpty {
            Section("Live Code Sessions") {
                ForEach(sessions) { session in
                    Button {
                        open(session)
                    } label: {
                        // The Needs You pattern: the title, and the status as
                        // the item's second line, with the state's glyph.
                        JunoIconLabel(verbatim: session.title, icon: Self.icon(for: session.status))
                        Text(verbatim: session.status.label)
                    }
                    .help("\(session.detail): \(session.status.label)")
                }
            }
        }

        Section {
            Button {
                JunoDesktopWindow.showMainWindow(using: openWindow)
            } label: {
                // Juno's own mark: this brings Juno's window forward, it does
                // not leave the app (which is what the external arrow says).
                JunoIconLabel("Open Juno", icon: .home)
            }
        }
    }

    /// The mark beside a running session: what state it is in, in the same
    /// vocabulary the Code column's gutter uses. A still glyph: a menu cannot
    /// animate, and a spinner frozen mid-turn reads as a hang.
    static func icon(for status: CodeRunStatus) -> JunoIcon {
        if status.needsApproval { return .permission }
        return .circleDot
    }

    private func open(_ session: DesktopWorkbenchRegistry.ActiveSession) {
        if let id = session.sessionID {
            registry.request(.openSession(id))
        }
        JunoDesktopWindow.showMainWindow(using: openWindow)
    }
}

/// The menu bar item's own glyph: Juno's chat mark, as a template image, with
/// a count only when something needs you (§7.10).
///
/// A count of everything running would be a number that is almost always
/// non-zero and so says nothing; what earns a glance is a session blocked on
/// the reader. The status bar takes an `NSImage`, so the mark is loaded from
/// the app's icon set rather than through `JunoIconView`, whose SwiftUI frame
/// the status item ignores. The asset is a symbol, sized by a point size: 14pt
/// sets the 256 grid at 16pt, the menu bar's glyph box.
struct DesktopMenuBarExtraLabel: View {
    @State private var registry = DesktopWorkbenchRegistry.shared
    @State private var signals = DesktopNeedsYouSignals.shared

    private static let mark: NSImage = {
        let symbol = NSImage(named: JunoIcon.home.assetName)
        let image = symbol?.withSymbolConfiguration(.init(pointSize: 14, weight: .regular)) ?? symbol ?? NSImage()
        image.isTemplate = true
        return image
    }()

    var body: some View {
        let waiting = registry.activeSessions.filter(\.status.needsApproval).count
        Image(nsImage: Self.mark)
            .accessibilityLabel("Juno")
        if let count = Self.count(chats: signals.count, codeSessions: waiting) {
            Text(count)
        }
    }

    /// The number beside the mark: everything the menu lists as waiting on
    /// the reader — the chats in Needs You and the Code sessions that need an
    /// approval — and nothing at all while nothing does.
    static func count(chats: Int, codeSessions: Int) -> String? {
        let total = max(0, chats) + max(0, codeSessions)
        return total > 0 ? String(total) : nil
    }
}
