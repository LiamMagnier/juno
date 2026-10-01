import CoreGraphics
import Foundation
import JunoScreenControl
import Observation

/// What the app's on-screen presence shows while Juno uses other apps: the
/// caption under the menu bar, the glow, the menu bar's Stop (CODE_AGENT_SPEC
/// §3.7). One for the app, fed by the shared service, in plain values so the
/// window shell needs nothing but this module.
@MainActor
@Observable
public final class ScreenPresenceCenter {
    public static let shared = ScreenPresenceCenter()

    /// "Juno is using TextEdit · Esc to stop"; nil when nothing is driven.
    public private(set) var caption: String?
    /// Whether any session or Work task is using the screen.
    public private(set) var isActive = false
    /// The whole display, with the real pointer.
    public private(set) var isTakeover = false
    /// The reader took over; Juno waits.
    public private(set) var isPaused = false
    /// The driven window, in AppKit screen coordinates (bottom-left origin),
    /// for the outline glow in background mode.
    public private(set) var targetWindowFrame: CGRect?
    /// The driven display, in AppKit coordinates, for the edge glow.
    public private(set) var displayFrame: CGRect?
    /// The app Juno is using, for notifications.
    public private(set) var appName: String?

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let service: ScreenControlService
    /// The height of the main display in points, for flipping CoreGraphics'
    /// top-left frames into AppKit's bottom-left ones.
    @ObservationIgnored private let mainDisplayHeight: () -> CGFloat

    init(service: ScreenControlService = .shared, mainDisplayHeight: @escaping () -> CGFloat = { CGDisplayBounds(CGMainDisplayID()).height }) {
        self.service = service
        self.mainDisplayHeight = mainDisplayHeight
    }

    /// Starts following the service. Idempotent.
    public func start() {
        guard task == nil else { return }
        let service = self.service
        task = Task { [weak self] in
            for await state in await service.presence() {
                self?.apply(state)
            }
        }
    }

    func apply(_ state: ScreenPresenceState) {
        caption = state.caption
        isActive = state.holder != nil
        isTakeover = state.mode == .takeover && isActive
        isPaused = state.paused
        appName = state.holder?.appName
        targetWindowFrame = state.targetWindowFrame.map(flip)
        displayFrame = state.displayFrame.map(flip)
    }

    private func flip(_ rect: ScreenRect) -> CGRect {
        CGRect(x: rect.x, y: mainDisplayHeight() - rect.y - rect.height, width: rect.width, height: rect.height)
    }

    /// The menu bar's "Stop Juno using apps".
    public func stop() {
        let service = self.service
        Task { await service.stopAll(reason: .menuBar) }
    }
}
