import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl
import SwiftUI

/// The app-wide pieces of computer use for every model (Code v2 SPEC §3.12):
/// the action overlay over whatever Alevr is driving, and the bridge that
/// lets connected agents (Claude through your own `claude`, Codex, ACP
/// agents) drive it through the env server. The app shell calls
/// ``install()`` once at launch; the caption, the takeover glow and the menu
/// bar's Stop stay in `DesktopScreenPresence`.
@MainActor
public final class ComputerUseDesktopHost {
    public static let shared = ComputerUseDesktopHost()

    private var overlay: ComputerActionOverlayWindow?
    private var bridge: ComputerBridgeServer?

    /// - Parameter summon: brings a window forward when a connected agent
    ///   asks for something and no window can show the card.
    public func install(summon: (@MainActor () -> Void)? = nil) {
        guard overlay == nil else { return }
        CodeV2ConnectedApprovals.shared.summon = summon
        let window = ComputerActionOverlayWindow(model: .shared)
        overlay = window
        window.start()

        let executor = ComputerBridgeExecutor(
            service: ScreenControlService.shared,
            approver: StudioComputerBridgeApprover(),
            permissions: { ComputerUsePermissionProbe.system.read() }
        )
        // Bound to the env server this app launched: another process of this
        // user (an agent's shell command that read bridge.token) is refused.
        // A debug build may let a hand-started `npm run dev` env server in.
        var anyPeer = false
        #if DEBUG
        anyPeer = ProcessInfo.processInfo.environment["ALEVR_COMPUTER_BRIDGE_ANY_PEER"] == "1"
        #endif
        let server = ComputerBridgeServer(handler: executor, bindToRegisteredPeers: !anyPeer)
        do {
            try server.start()
            bridge = server
            EnvServerHub.onLaunch = { [weak server] launch in
                if let pid = launch.pid { server?.allowPeer(pid) }
            }
        } catch {
            // Without the bridge connected agents get "open the Alevr app"
            // from the env server; the app's own sessions are unaffected.
            NSLog("Alevr computer bridge did not start: \(error.localizedDescription)")
        }
    }

    /// On quit: no stale socket or token is left for an env server to find.
    public func uninstall() {
        EnvServerHub.onLaunch = nil
        CodeV2ConnectedApprovals.shared.declineAll()
        bridge?.stop()
        bridge = nil
        overlay?.stop()
        overlay = nil
    }
}

// MARK: - The overlay window

/// One click-through, never-key, never-captured panel over the display the
/// action is on, drawing ``ComputerActionOverlayView``.
@MainActor
final class ComputerActionOverlayWindow {
    private let model: ComputerActionOverlayModel
    private var panel: NSPanel?

    init(model: ComputerActionOverlayModel) {
        self.model = model
    }

    func start() {
        model.start()
        observe()
    }

    func stop() {
        model.stop()
        panel?.orderOut(nil)
    }

    private func observe() {
        withObservationTracking {
            render(model.mark)
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
    }

    private func render(_ mark: ComputerActionOverlayModel.Mark?) {
        guard let mark else {
            panel?.orderOut(nil)
            return
        }
        let screen = mark.point.flatMap { point in NSScreen.screens.first { $0.frame.contains(point) } }
            ?? NSScreen.main ?? NSScreen.screens.first
        guard let screen else { return }
        let panel = self.panel ?? Self.makePanel()
        self.panel = panel
        if panel.frame != screen.frame { panel.setFrame(screen.frame, display: false) }
        if panel.contentView == nil {
            let host = NSHostingView(rootView: ComputerActionOverlayView(model: model, screenFrame: screen.frame))
            panel.contentView = host
        } else if let host = panel.contentView as? NSHostingView<ComputerActionOverlayView> {
            host.rootView = ComputerActionOverlayView(model: model, screenFrame: screen.frame)
        }
        panel.orderFrontRegardless()
    }

    static func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        // Never in a screenshot the agent is sent: the capture filter leaves
        // Alevr's windows out, and this asks macOS not to share it either.
        panel.sharingType = .none
        return panel
    }
}

/// The ring where the action lands and the line that says what it is.
///
/// Coral while the action is being sent (the one "working" signal), neutral
/// once it settles. One entry motion per action, the ring gliding between
/// targets on the standard spring; under Reduce Motion it simply appears.
struct ComputerActionOverlayView: View {
    let model: ComputerActionOverlayModel
    let screenFrame: CGRect

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let ring: CGFloat = 30
    private static let labelWidth: CGFloat = 340

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let mark = model.mark {
                if let local = local(mark.point) {
                    ring(mark)
                        .position(local)
                        .animation(reduceMotion ? nil : JunoMotion.standard, value: local)
                    label(mark)
                        .frame(width: Self.labelWidth, alignment: .leading)
                        .position(labelPosition(for: local))
                        .animation(reduceMotion ? nil : JunoMotion.standard, value: local)
                } else {
                    label(mark)
                        .frame(width: Self.labelWidth, alignment: .leading)
                        .position(x: screenFrame.width / 2, y: 64)
                }
            }
        }
        .frame(width: screenFrame.width, height: screenFrame.height)
        .allowsHitTesting(false)
    }

    private func ring(_ mark: ComputerActionOverlayModel.Mark) -> some View {
        ZStack {
            // A dark hairline under the stroke keeps it legible on white.
            Circle()
                .strokeBorder(Color.black.opacity(0.28), lineWidth: 1)
                .frame(width: Self.ring + 3, height: Self.ring + 3)
            Circle()
                .strokeBorder(mark.live ? Color.junoAccent : Color.white.opacity(0.92), lineWidth: 2)
                .frame(width: Self.ring, height: Self.ring)
        }
        .id(mark.serial)
        .transition(reduceMotion ? .opacity : .scale(scale: 1.6).combined(with: .opacity))
        .accessibilityHidden(true)
    }

    private func label(_ mark: ComputerActionOverlayModel.Mark) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(mark.label)
                .font(.callout.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .lineLimit(2)
            Text(mark.succeeded == false ? "Didn't go through · Esc to stop" : "Esc to stop")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .fixedSize(horizontal: false, vertical: true)
        // Opaque, not glass: this label is read over whatever app is on screen,
        // and text through a blur has no fixed contrast (glass gate, §0.1).
        .junoCard(cornerRadius: JunoRadius.control)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Alevr: \(mark.label)")
    }

    /// AppKit global (bottom-left) → this panel's SwiftUI space (top-left).
    private func local(_ point: CGPoint?) -> CGPoint? {
        guard let point else { return nil }
        return CGPoint(x: point.x - screenFrame.minX, y: screenFrame.maxY - point.y)
    }

    /// Below and to the right of the ring, kept on screen.
    private func labelPosition(for ring: CGPoint) -> CGPoint {
        let half = Self.labelWidth / 2
        var x = ring.x + Self.ring / 2 + 8 + half
        if x + half > screenFrame.width - 12 { x = ring.x - Self.ring / 2 - 8 - half }
        x = min(max(x, half + 12), screenFrame.width - half - 12)
        var y = ring.y + Self.ring / 2 + 26
        if y > screenFrame.height - 40 { y = ring.y - Self.ring / 2 - 26 }
        return CGPoint(x: x, y: y)
    }
}

// MARK: - The reader's say for connected agents

// Connected agents' requests are Studio approval cards
// (`StudioComputerBridgeApprover`, `CodeV2ConnectedApprovals`): in the
// thread's composer when it is on screen, else one card over the window.
