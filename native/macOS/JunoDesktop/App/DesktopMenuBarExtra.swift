import JunoCodeUI
import JunoDesignSystem
import SwiftUI

/// The menu bar item: which runs are live, and the way to start another.
///
/// Codex and Claude Code both keep a presence in the menu bar so a run left
/// working in another Space still has a status a glance away. This is that:
/// every active session with its state, a click to open it, and New task. It
/// reads ``DesktopWorkbenchRegistry`` rather than any window, so it is correct
/// with no window open at all — which is exactly when it is most useful.
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
                        Label {
                            Text("\(session.title) — \(session.status.label)")
                        } icon: {
                            Image(systemName: session.status.symbol)
                        }
                    }
                    .help("\(session.detail) · \(session.status.label)")
                }
            }
        }

        Section {
            Button("New task…") {
                registry.request(.newCodeTask(prompt: nil))
                openWindow(id: JunoDesktopWindow.mainID)
                NSApp.activate()
            }
            .keyboardShortcut("n")
            .disabled(registry.workbench == nil)

            Button("Ask Juno…") {
                DesktopQuickEntryController.shared.toggle()
            }
            .keyboardShortcut(" ", modifiers: [.option])
        }

        Section {
            Button("Open Juno") {
                openWindow(id: JunoDesktopWindow.mainID)
                NSApp.activate()
            }
        }
    }

    private func open(_ session: DesktopWorkbenchRegistry.ActiveSession) {
        if let id = session.sessionID {
            registry.request(.openSession(id))
        }
        openWindow(id: JunoDesktopWindow.mainID)
        NSApp.activate()
    }
}

/// The menu bar item's own glyph: Juno's bracket mark, with a badge when
/// something is blocked on the reader.
struct DesktopMenuBarExtraLabel: View {
    @State private var registry = DesktopWorkbenchRegistry.shared

    var body: some View {
        let sessions = registry.activeSessions
        let waiting = sessions.filter(\.status.needsApproval).count
        if waiting > 0 {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .symbolVariant(.none)
            Text("\(waiting)")
        } else if !sessions.isEmpty {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
            Text("\(sessions.count)")
        } else {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
        }
    }
}
