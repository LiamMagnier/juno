import AppKit
import JunoCodeUI
import JunoDesignSystem
import Observation
import SwiftUI
import UserNotifications

/// Juno's presence on screen while it uses other apps (CODE_AGENT_SPEC §3.7).
///
/// - A small glass caption under the menu bar: "Juno is using TextEdit · Esc
///   to stop". Words, not a dot or a pill.
/// - In takeover, a soft glow along the driven display's edge — glow is the
///   one ambient state signal the owner allows. In background mode the
///   caption alone: following another app's window as it moves is not
///   something the public APIs make reliable (UNVERIFIED in the spec), and a
///   glow left behind on the wrong rectangle is worse than none.
/// - A notification when Juno starts and when it stops.
///
/// Both windows are click-through, never key and never in Juno's own frames:
/// screen control captures one other app's window, or a display with every
/// Juno window excluded. Esc and the menu bar's Stop live in the service and
/// `DesktopMenuBarExtra`.
@MainActor
final class DesktopScreenPresence {
    static let shared = DesktopScreenPresence()

    private var captionPanel: NSPanel?
    private var glowPanel: NSPanel?
    private var installed = false
    private var wasActive = false
    private var lastApp: String?

    func install() {
        guard !installed else { return }
        installed = true
        ScreenPresenceCenter.shared.start()
        observe()
    }

    private func observe() {
        withObservationTracking {
            render(ScreenPresenceCenter.shared)
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
    }

    private func render(_ center: ScreenPresenceCenter) {
        let active = center.isActive
        if active, let caption = center.caption {
            showCaption(caption)
        } else {
            captionPanel?.orderOut(nil)
        }
        if active, center.isTakeover, !center.isPaused, let frame = center.displayFrame {
            showGlow(over: frame)
        } else {
            glowPanel?.orderOut(nil)
        }
        if active != wasActive || (active && center.appName != lastApp && center.appName != nil && lastApp == nil) {
            notify(active: active, app: center.appName)
        }
        wasActive = active
        lastApp = active ? center.appName : nil
    }

    // MARK: - The caption

    private func showCaption(_ text: String) {
        let panel = captionPanel ?? Self.makePanel(level: .statusBar)
        captionPanel = panel
        let host = NSHostingView(rootView: DesktopScreenCaption(text: text))
        host.sizingOptions = [.intrinsicContentSize]
        panel.contentView = host
        let size = host.fittingSize
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        panel.setFrame(
            CGRect(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 8, width: size.width, height: size.height),
            display: true
        )
        panel.orderFrontRegardless()
    }

    // MARK: - The glow

    private func showGlow(over frame: CGRect) {
        let panel = glowPanel ?? Self.makePanel(level: .screenSaver)
        glowPanel = panel
        panel.contentView = NSHostingView(rootView: DesktopScreenEdgeGlow())
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
    }

    private static func makePanel(level: NSWindow.Level) -> NSPanel {
        let panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.level = level
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        // Belt and braces: the capture filter already leaves out every Juno
        // window, and this asks macOS not to share it either.
        panel.sharingType = .none
        return panel
    }

    // MARK: - Notifications

    private func notify(active: Bool, app: String?) {
        let title = active
            ? (app.map { "Juno is using \($0). Press Esc to stop." } ?? "Juno can use the apps you grant. Press Esc to stop.")
            : "Juno stopped using apps."
        Task {
            let center = UNUserNotificationCenter.current()
            let status = await center.notificationSettings().authorizationStatus
            guard status == .authorized || status == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.threadIdentifier = "juno-screen-control"
            // One replaceable notification: the stop replaces the start.
            let request = UNNotificationRequest(identifier: "juno-screen-control", content: content, trigger: nil)
            try? await center.add(request)
        }
    }
}

/// "Juno is using TextEdit · Esc to stop", on Liquid Glass.
private struct DesktopScreenCaption: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout.weight(.medium))
            .foregroundStyle(Color.junoForeground)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoGlass(in: RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
            .padding(JunoSpace.snug)
            .accessibilityLabel(text)
    }
}

/// A soft accent glow along the display's edge, while Juno holds it.
private struct DesktopScreenEdgeGlow: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.junoAccent.opacity(0.55), lineWidth: 6)
            .blur(radius: 6)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.junoAccent.opacity(0.35), lineWidth: 1.5)
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The menu bar's way out: present only while Juno is using apps.
struct DesktopScreenPresenceMenuSection: View {
    @State private var center = ScreenPresenceCenter.shared

    var body: some View {
        if center.isActive {
            Section {
                Button("Stop Juno using apps") { center.stop() }
                    .help(center.caption ?? "Stop screen control everywhere")
                    .accessibilityIdentifier("juno.menubar.stop-screen-control")
            }
        }
    }
}
