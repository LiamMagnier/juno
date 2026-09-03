import AppKit
import JunoCodeUI
import JunoDesignSystem
import SwiftUI

/// The menu bar item: which runs are live, and the way to start another.
///
/// Codex and Claude Code both keep a presence in the menu bar so a run left
/// working in another Space still has a status a glance away. This is that:
/// every active session with its state, a click to open it, New task and Ask
/// Juno. It reads ``DesktopWorkbenchRegistry`` rather than any window, so it is
/// correct with no window open at all — which is exactly when it is most useful.
///
/// The glyphs are the website's Lucide marks, the same catalog every other
/// surface draws from; a menu is the one place the platform would otherwise
/// hand us a system symbol by default.
struct DesktopMenuBarExtraContent: View {
    @Environment(\.openWindow) private var openWindow
    @State private var registry = DesktopWorkbenchRegistry.shared

    var body: some View {
        let sessions = registry.activeSessions
        if registry.workbench == nil {
            Text("Sign in to Juno to see running sessions")
        } else if sessions.isEmpty {
            Text("No sessions running")
        } else {
            Section(sessions.count == 1 ? "1 session running" : "\(sessions.count) sessions running") {
                ForEach(sessions) { session in
                    Button {
                        open(session)
                    } label: {
                        JunoIconLabel(
                            verbatim: "\(session.title) — \(session.status.label)",
                            icon: Self.icon(for: session.status)
                        )
                    }
                    .help("\(session.detail) · \(session.status.label)")
                }
            }
        }

        Section {
            Button {
                registry.request(.newCodeTask(prompt: nil))
                openWindow(id: JunoDesktopWindow.mainID)
                NSApp.activate()
            } label: {
                JunoIconLabel("New task…", icon: .new)
            }
            .keyboardShortcut("n")
            .disabled(registry.workbench == nil)

            Button {
                DesktopQuickEntryController.shared.toggle()
            } label: {
                JunoIconLabel("Ask Juno…", icon: .conversation)
            }
            .keyboardShortcut(" ", modifiers: [.option])
        }

        Section {
            Button {
                openWindow(id: JunoDesktopWindow.mainID)
                NSApp.activate()
            } label: {
                JunoIconLabel("Open Juno", icon: .external)
            }
        }
    }

    /// The mark beside a running session: what state it is in, in the same
    /// vocabulary the Code column's gutter uses.
    private static func icon(for status: CodeRunStatus) -> JunoIcon {
        if status.needsApproval { return .permission }
        return .loader
    }

    private func open(_ session: DesktopWorkbenchRegistry.ActiveSession) {
        if let id = session.sessionID {
            registry.request(.openSession(id))
        }
        openWindow(id: JunoDesktopWindow.mainID)
        NSApp.activate()
    }
}

/// The menu bar item's own glyph: Juno's bracket mark, with a count when
/// something is running and the count in front when something is blocked on
/// the reader.
///
/// The status bar takes an `NSImage`, so the website's `code` mark is loaded
/// from the app's own navigation catalog as a template at menu-bar size rather
/// than through `JunoIconView`, whose SwiftUI frame the status item ignores.
struct DesktopMenuBarExtraLabel: View {
    @State private var registry = DesktopWorkbenchRegistry.shared

    private static let mark: NSImage = {
        let image = NSImage(named: JunoIcon.code.assetName) ?? NSImage()
        image.isTemplate = true
        image.size = NSSize(width: 16, height: 16)
        return image
    }()

    var body: some View {
        let sessions = registry.activeSessions
        let waiting = sessions.filter(\.status.needsApproval).count
        Image(nsImage: Self.mark)
        if waiting > 0 {
            Text("\(waiting)")
        } else if !sessions.isEmpty {
            Text("\(sessions.count)")
        }
    }
}
