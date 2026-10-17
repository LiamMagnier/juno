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
    private var previewPanel: NSPanel?
    private var activationObserver: NSObjectProtocol?

    init(model: ComputerActionOverlayModel) {
        self.model = model
    }

    func start() {
        model.start()
        ScreenPresenceCenter.shared.start()
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.render(self.model.mark)
            }
        }
        observe()
    }

    func stop() {
        model.stop()
        panel?.orderOut(nil)
        previewPanel?.orderOut(nil)
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
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
            previewPanel?.orderOut(nil)
            // Release decoded image state as well as the feed's Data.
            previewPanel?.contentView = nil
            previewPanel = nil
            return
        }
        showPreview()
        // Background input never moves the reader's pointer. Draw over the app
        // only while it is actually in front; its preview always shows the target.
        guard !mark.paused, NSWorkspace.shared.frontmostApplication?.localizedName == mark.appName else {
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

    private func showPreview() {
        guard model.mark?.thumbnail != nil else { previewPanel?.orderOut(nil); return }
        if previewPanel == nil {
            let panel = NSPanel(
                contentRect: CGRect(x: 0, y: 0, width: 336, height: 282),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true
            )
            panel.level = .floating
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.isMovableByWindowBackground = true
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.sharingType = .none
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.contentView = NSHostingView(rootView: ComputerUsePreviewView(model: model, presence: .shared))
            panel.contentView?.wantsLayer = true
            panel.contentView?.layer?.cornerRadius = 16
            panel.contentView?.layer?.masksToBounds = true
            if let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
                panel.setFrameOrigin(CGPoint(x: frame.maxX - 356, y: frame.minY + 20))
            }
            previewPanel = panel
        }
        previewPanel?.orderFrontRegardless()
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

    private static let ring: CGFloat = 22
    private static let labelWidth: CGFloat = 66

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
            Circle()
                .fill(Color.white.opacity(mark.live ? 0.12 : 0))
                .overlay(Circle().strokeBorder(Color.white.opacity(mark.live ? 0.7 : 0), lineWidth: 1))
                .frame(width: 22, height: 22)
                .animation(reduceMotion ? nil : JunoMotion.fast, value: mark.live)
            AgentCursorGlyph()
                .frame(width: 22, height: 30)
                .offset(x: 11, y: 15)
        }
        .accessibilityHidden(true)
    }

    private func label(_ mark: ComputerActionOverlayModel.Mark) -> some View {
        Text("Alevr")
            .font(.caption2.weight(.semibold))
            .fontDesign(.rounded)
            .tracking(0.1)
            .foregroundStyle(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Color.black.opacity(0.9), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.16), radius: 3, y: 2)
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

/// A familiar arrow silhouette with a real stem and a precise top-left tip.
/// The double edge stays legible over both bright and dark target content.
struct AgentPointer: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            let points: [CGPoint] = [
                CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 0.77),
                CGPoint(x: 0.28, y: 0.59), CGPoint(x: 0.52, y: 1),
                CGPoint(x: 0.73, y: 0.89), CGPoint(x: 0.49, y: 0.49),
                CGPoint(x: 0.94, y: 0.49)
            ]
            path.addLines(points.map { CGPoint(x: rect.minX + $0.x * rect.width, y: rect.minY + $0.y * rect.height) })
            path.closeSubpath()
        }
    }
}

struct AgentCursorGlyph: View {
    var body: some View {
        AgentPointer()
            .fill(.white)
            .overlay(AgentPointer().stroke(Color.black.opacity(0.85), style: StrokeStyle(lineWidth: 1.2, lineJoin: .round)))
            .shadow(color: .black.opacity(0.24), radius: 1.5, y: 1)
    }
}

/// A movable, nonactivating view of the actual captured app. Images remain
/// memory-only and the panel is excluded from the agent's own captures.
struct ComputerUsePreviewView: View {
    let model: ComputerActionOverlayModel
    let presence: ScreenPresenceCenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: NSImage?
    private var isPaused: Bool { model.mark?.paused == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                JunoIconView(.monitorUp, size: 14)
                    .foregroundStyle(Color.junoAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.mark?.appName ?? "Computer use")
                        .font(.caption.weight(.semibold))
                    Text(isPaused ? "Paused · you're in control" : "Alevr is working")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .help("Drag this preview to move it")
                Spacer(minLength: 4)
                Button { presence.togglePause(sessionID: model.sessionID) } label: {
                    Text(isPaused ? "Resume" : "Pause")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(minWidth: JunoLayout.pointerTarget, minHeight: JunoLayout.pointerTarget)
                        .contentShape(.rect)
                }
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
                    .accessibilityLabel(isPaused ? "Resume computer use" : "Pause computer use")
                Button { presence.stop() } label: {
                    JunoIconView(.stop, size: 11)
                        .frame(minWidth: JunoLayout.pointerTarget, minHeight: JunoLayout.pointerTarget)
                        .contentShape(.rect)
                }
                .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
                .accessibilityLabel("Stop computer use")
                .help("Stop computer use · Esc")
            }
            .buttonStyle(StudioQuietButtonStyle())
            .controlSize(.small)
            .padding(12)
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    Color.black.opacity(0.12)
                    if let image {
                        Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                        if let point = previewPoint(in: geometry.size, image: image) {
                            AgentCursorGlyph()
                                .frame(width: 16, height: 22)
                                .position(x: point.x + 8, y: point.y + 11)
                                .animation(reduceMotion ? nil : JunoMotion.standard, value: point)
                                .accessibilityHidden(true)
                        }
                    } else {
                        Text("Waiting for the first view…")
                            .font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .clipped()
            }
            .frame(height: 180)
            HStack(alignment: .top, spacing: 7) {
                JunoIconView(isPaused ? .pause : (model.mark?.live == true ? .scan : .eye), size: 11)
                    .foregroundStyle(Color.junoAccent)
                Text(isPaused ? "Resume when you're ready." : (model.mark?.label ?? "Observing the app"))
                    .font(.caption).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .frame(width: 336, height: 282)
        .background(Color(nsColor: .windowBackgroundColor))
        .onChange(of: model.mark?.thumbnail, initial: true) { _, data in
            image = data.flatMap { NSImage(data: $0) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Alevr computer use preview")
    }

    private func previewPoint(in size: CGSize, image: NSImage) -> CGPoint? {
        guard let mark = model.mark, let point = mark.capturePoint, let bounds = mark.windowFrame else { return nil }
        return Self.previewPoint(point, bounds: bounds, imageSize: image.size, viewport: size)
    }

    static func previewPoint(_ point: ScreenPoint, bounds: ScreenRect, imageSize: CGSize, viewport: CGSize) -> CGPoint? {
        guard bounds.width > 0, bounds.height > 0, imageSize.width > 0, imageSize.height > 0 else { return nil }
        let x = (point.x - bounds.x) / bounds.width
        let y = (point.y - bounds.y) / bounds.height
        guard (0...1).contains(x), (0...1).contains(y) else { return nil }
        let scale = min(viewport.width / imageSize.width, viewport.height / imageSize.height)
        let width = imageSize.width * scale
        let height = imageSize.height * scale
        return CGPoint(x: (viewport.width - width) / 2 + x * width, y: (viewport.height - height) / 2 + y * height)
    }
}

// MARK: - The reader's say for connected agents

// Connected agents' requests are Studio approval cards
// (`StudioComputerBridgeApprover`, `CodeV2ConnectedApprovals`): in the
// thread's composer when it is on screen, else one card over the window.
