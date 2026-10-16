import AppKit
import JunoCodeUI
import JunoDesignSystem
import JunoScreenControl
import Observation
import QuartzCore
import SwiftUI
import UserNotifications

/// Alevr's presence on screen while it uses other apps (CODE_AGENT_SPEC §3.7).
///
/// - A small glass caption under the menu bar of the display that holds the
///   driven window: "Alevr is using TextEdit · Esc to stop". Words, not a dot
///   or a pill, and the one place that says how to stop.
/// - In background mode, a subtle outline in the presence colour around the
///   window being driven, so the person can tell which one it is between
///   actions, not only from the transient ring.
/// - In takeover, a soft glow along the driven display's edge in the presence
///   colour. When the person takes over it crossfades to their own colour
///   (their accent) instead of vanishing, and back on Resume.
/// - A notification when Alevr starts and when it stops.
///
/// Every panel fades in and out (180 ms, the house entrance and exit curves)
/// rather than snapping, and keeps one hosting view whose root view is updated
/// in place. Under Reduce Motion nothing animates: panels appear and go, and
/// the glow's colour changes without a crossfade.
///
/// All panels are borderless, non-activating, click-through, never key and
/// never shared (`sharingType = .none`): screen control captures one other
/// app's window, or a display with every Alevr window excluded. Esc and the
/// menu bar's Stop live in the service and `DesktopMenuBarExtra`.
@MainActor
final class DesktopScreenPresence {
    static let shared = DesktopScreenPresence()

    private lazy var caption = PresencePanel(level: .statusBar, sizing: [.intrinsicContentSize], content: DesktopScreenCaption(text: ""))
    private lazy var glow = PresencePanel(level: .screenSaver, content: DesktopScreenEdgeGlow(personHasControl: false))
    private lazy var outline = PresencePanel(level: .floating, content: DesktopScreenWindowOutline(personHasControl: false))
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

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    private func render(_ center: ScreenPresenceCenter) {
        let active = center.isActive
        let reduce = reduceMotion

        if active, let text = center.caption {
            // The display holding the driven window; in takeover, the driven
            // display; else the main one.
            showCaption(text, near: center.targetWindowFrame ?? center.displayFrame, reduceMotion: reduce)
        } else {
            caption.hide(reduceMotion: reduce)
        }

        if active, center.isTakeover, let frame = center.displayFrame {
            // Paused is the person holding the Mac: the glow stays and turns
            // their colour, so the state reads as a hand-over, not a cut.
            glow.update(DesktopScreenEdgeGlow(personHasControl: center.isPaused))
            glow.place(frame)
            glow.show(reduceMotion: reduce)
        } else {
            glow.hide(reduceMotion: reduce)
        }

        if active, !center.isTakeover, let window = center.targetWindowFrame {
            outline.update(DesktopScreenWindowOutline(personHasControl: center.isPaused))
            outline.place(ScreenPresenceLayout.outlineFrame(around: window))
            outline.show(reduceMotion: reduce)
        } else {
            outline.hide(reduceMotion: reduce)
        }

        if active != wasActive || (active && center.appName != lastApp && center.appName != nil && lastApp == nil) {
            notify(active: active, app: center.appName)
        }
        wasActive = active
        lastApp = active ? center.appName : nil
    }

    // MARK: - The caption

    private func showCaption(_ text: String, near target: CGRect?, reduceMotion: Bool) {
        // The text changes in place; the hosting view stays.
        caption.update(DesktopScreenCaption(text: text))
        let size = caption.fittingSize
        let screens = NSScreen.screens
        let mainIndex = NSScreen.main.flatMap { main in screens.firstIndex { $0 == main } }
        guard let index = ScreenPresenceLayout.screenIndex(
            holding: target,
            screens: screens.map(\.frame),
            mainIndex: mainIndex
        ) else { return }
        caption.place(ScreenPresenceLayout.captionFrame(size: size, visibleFrame: screens[index].visibleFrame))
        caption.show(reduceMotion: reduceMotion)
    }

    // MARK: - Notifications

    private func notify(active: Bool, app: String?) {
        let title = active
            ? (app.map { "Alevr is using \($0). Press Esc to stop." } ?? "Alevr can use the apps you grant. Press Esc to stop.")
            : "Alevr stopped using apps."
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

// MARK: - One panel, one hosting view

/// A click-through presence panel that fades rather than snaps.
///
/// The hosting view is made once; ``update(_:)`` swaps its root view, so a
/// changed caption or a glow changing colour is SwiftUI animating a value,
/// not a new view tree appearing.
@MainActor
private final class PresencePanel<Content: View> {
    private let fading: FadingPanel
    private let host: NSHostingView<Content>

    init(level: NSWindow.Level, sizing: NSHostingSizingOptions = [], content: Content) {
        fading = FadingPanel(level: level)
        host = NSHostingView(rootView: content)
        host.sizingOptions = sizing
        fading.panel.contentView = host
    }

    var fittingSize: CGSize { host.fittingSize }

    func update(_ content: Content) {
        host.rootView = content
    }

    func place(_ frame: CGRect) { fading.place(frame) }
    func show(reduceMotion: Bool) { fading.show(reduceMotion: reduceMotion) }
    func hide(reduceMotion: Bool) { fading.hide(reduceMotion: reduceMotion) }
}

/// The panel itself and its fade: borderless, non-activating, click-through,
/// never shared.
@MainActor
private final class FadingPanel {
    /// Entrances on `--ease-out-soft`, exits on `--ease-in`: the web's and
    /// JunoMotion's own curves, at the presence's 180 ms.
    static let fadeDuration: TimeInterval = 0.18
    static let enterCurve = curve(JunoGeneratedEasing.outSoft)
    static let exitCurve = curve(JunoGeneratedEasing.in)

    let panel: NSPanel
    /// Bumped by every show and hide, so a fade-out that finishes after the
    /// panel was shown again does not take it off screen.
    private var generation = 0
    private var shown = false

    init(level: NSWindow.Level) {
        panel = Self.makePanel(level: level)
    }

    func place(_ frame: CGRect) {
        guard panel.frame != frame else { return }
        panel.setFrame(frame, display: shown)
    }

    func show(reduceMotion: Bool) {
        generation &+= 1
        guard !shown else { return }
        shown = true
        if reduceMotion {
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            return
        }
        if !panel.isVisible { panel.alphaValue = 0 }
        panel.orderFrontRegardless()
        let panel = self.panel
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Self.fadeDuration
            context.timingFunction = Self.enterCurve
            panel.animator().alphaValue = 1
        }
    }

    func hide(reduceMotion: Bool) {
        guard shown else { return }
        shown = false
        generation &+= 1
        let ticket = generation
        if reduceMotion {
            panel.orderOut(nil)
            panel.alphaValue = 1
            return
        }
        let panel = self.panel
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = Self.fadeDuration
            context.timingFunction = Self.exitCurve
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor [weak self] in self?.finishHiding(ticket) }
        })
    }

    private func finishHiding(_ ticket: Int) {
        guard generation == ticket, !shown else { return }
        panel.orderOut(nil)
    }

    private static func curve(_ points: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat)) -> CAMediaTimingFunction {
        CAMediaTimingFunction(controlPoints: Float(points.x1), Float(points.y1), Float(points.x2), Float(points.y2))
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
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        // Belt and braces: the capture filter already leaves out every Alevr
        // window, and this asks macOS not to share it either.
        panel.sharingType = .none
        return panel
    }
}

// MARK: - Views

/// "Alevr is using TextEdit · Esc to stop", on Liquid Glass.
private struct DesktopScreenCaption: View {
    let text: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .font(.callout.weight(.medium))
            .foregroundStyle(Color.junoForeground)
            .contentTransition(reduceMotion ? .identity : .opacity)
            .animation(reduceMotion ? nil : JunoMotion.fast, value: text)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoGlass(in: RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
            .padding(JunoSpace.snug)
            .accessibilityLabel(text)
    }
}

/// A soft glow along the display's edge while Alevr holds it: the presence
/// colour while it drives, the person's own colour while they hold the Mac.
private struct DesktopScreenEdgeGlow: View {
    let personHasControl: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            layer(Color.junoPresence).opacity(personHasControl ? 0 : 1)
            layer(Color.junoAccent).opacity(personHasControl ? 1 : 0)
        }
        // A crossfade between the two, never a gap with no glow; static
        // under Reduce Motion.
        .animation(reduceMotion ? nil : .timingCurve(
            JunoGeneratedEasing.inOut.x1, JunoGeneratedEasing.inOut.y1,
            JunoGeneratedEasing.inOut.x2, JunoGeneratedEasing.inOut.y2,
            duration: JunoGeneratedDuration.base
        ), value: personHasControl)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func layer(_ tint: Color) -> some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(tint.opacity(0.55), lineWidth: 6)
            .blur(radius: 6)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(tint.opacity(0.35), lineWidth: 1.5)
            )
    }
}

/// A subtle outline around the window Alevr is driving in background mode.
private struct DesktopScreenWindowOutline: View {
    let personHasControl: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            layer(Color.junoPresence).opacity(personHasControl ? 0 : 1)
            layer(Color.junoAccent).opacity(personHasControl ? 1 : 0)
        }
        .animation(reduceMotion ? nil : .timingCurve(
            JunoGeneratedEasing.inOut.x1, JunoGeneratedEasing.inOut.y1,
            JunoGeneratedEasing.inOut.x2, JunoGeneratedEasing.inOut.y2,
            duration: JunoGeneratedDuration.base
        ), value: personHasControl)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func layer(_ tint: Color) -> some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(tint.opacity(0.28), lineWidth: 4)
            .blur(radius: 3)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(tint.opacity(0.7), lineWidth: 1.5)
            )
    }
}

/// The menu bar's way out: present only while Alevr is using apps.
struct DesktopScreenPresenceMenuSection: View {
    @State private var center = ScreenPresenceCenter.shared

    var body: some View {
        if center.isActive {
            Section {
                Button("Stop Alevr using apps") { center.stop() }
                    .help(center.caption ?? "Stop screen control everywhere")
                    .accessibilityIdentifier("juno.menubar.stop-screen-control")
            }
        }
    }
}
