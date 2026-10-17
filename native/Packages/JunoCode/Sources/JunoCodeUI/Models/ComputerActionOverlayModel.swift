import CoreGraphics
import Foundation
import JunoScreenControl
import Observation

/// What the on-screen action overlay shows (Code v2 SPEC §3.12): a ring where
/// the next input lands and a line saying what it is, for every session, Work
/// task and connected agent, fed by the service's ``ComputerActionFeed``.
///
/// Plain values in AppKit's global coordinates (bottom-left origin), so the
/// window in the app shell needs nothing but this. The ring is coral while an
/// action is being sent — "working" — and settles to neutral; the overlay
/// stays visible until the session releases control.
@MainActor
@Observable
public final class ComputerActionOverlayModel {
    public static let shared = ComputerActionOverlayModel()

    public struct Mark: Equatable, Sendable {
        /// "Click the “Save” button in TextEdit".
        public var label: String
        public var appName: String?
        /// The target in AppKit global points; nil for keys and typing with
        /// no point (the label alone shows, near the top of the screen).
        public var point: CGPoint?
        /// Being sent now.
        public var live: Bool
        /// After it settled: whether it went through.
        public var succeeded: Bool?
        /// Bumped per action, so the view can restart its one entry motion.
        public var serial: Int
        public var paused: Bool = false
        public var capturePoint: ScreenPoint? = nil
        public var thumbnail: Data? = nil
        /// The captured window in CoreGraphics global coordinates.
        public var windowFrame: ScreenRect? = nil
    }

    public private(set) var mark: Mark?

    @ObservationIgnored private let feed: ComputerActionFeed
    @ObservationIgnored private let mainDisplayHeight: () -> CGFloat
    @ObservationIgnored private let linger: Duration?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var hide: Task<Void, Never>?
    @ObservationIgnored private var serial = 0
    @ObservationIgnored public private(set) var sessionID: String?

    public init(
        feed: ComputerActionFeed = .shared,
        linger: Duration? = nil,
        mainDisplayHeight: @escaping () -> CGFloat = { CGDisplayBounds(CGMainDisplayID()).height }
    ) {
        self.feed = feed
        self.linger = linger
        self.mainDisplayHeight = mainDisplayHeight
    }

    /// Starts following the feed. Idempotent.
    public func start() {
        guard task == nil else { return }
        let cues = feed.cues()
        task = Task { [weak self] in
            for await cue in cues {
                self?.apply(cue)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        hide?.cancel()
        mark = nil
        sessionID = nil
    }

    func apply(_ cue: ComputerActionCue) {
        switch cue.phase {
        case .observing:
            hide?.cancel()
            let sameTarget = sessionID == cue.sessionID && mark?.appName == cue.appName
            let previous = sameTarget ? mark : nil
            sessionID = cue.sessionID
            serial += 1
            mark = Mark(
                label: cue.label, appName: cue.appName,
                point: cue.point.map(flip) ?? previous?.point ?? cue.windowFrame.map { flip($0.center) },
                live: false, succeeded: nil, serial: serial,
                capturePoint: cue.point ?? previous?.capturePoint ?? cue.windowFrame?.center,
                thumbnail: cue.thumbnail ?? previous?.thumbnail,
                windowFrame: cue.windowFrame ?? previous?.windowFrame
            )
        case .acting:
            hide?.cancel()
            let previous = sessionID == cue.sessionID && mark?.appName == cue.appName ? mark : nil
            sessionID = cue.sessionID
            serial += 1
            mark = Mark(
                label: cue.label,
                appName: cue.appName,
                point: cue.point.map(flip) ?? previous?.point,
                live: true,
                succeeded: nil,
                serial: serial,
                capturePoint: cue.point ?? previous?.capturePoint,
                thumbnail: cue.thumbnail ?? previous?.thumbnail, windowFrame: cue.windowFrame ?? previous?.windowFrame
            )
        case let .settled(succeeded):
            guard sessionID == cue.sessionID, var current = mark else { return }
            current.label = cue.label
            current.thumbnail = cue.thumbnail ?? current.thumbnail
            current.windowFrame = cue.windowFrame ?? current.windowFrame
            current.live = false
            current.succeeded = succeeded
            mark = current
            scheduleHide(serial: current.serial)
        case let .paused(paused):
            guard sessionID == cue.sessionID, var current = mark else { return }
            hide?.cancel()
            current.paused = paused
            current.live = false
            mark = current
        case .cleared:
            guard cue.sessionID.isEmpty || cue.sessionID == sessionID else { return }
            hide?.cancel()
            mark = nil
            sessionID = nil
        }
    }

    private func scheduleHide(serial: Int) {
        hide?.cancel()
        guard let linger else { return }
        hide = Task { [weak self] in
            let clock = ContinuousClock()
            try? await clock.sleep(until: clock.now.advanced(by: linger))
            guard !Task.isCancelled else { return }
            self?.clearIfStill(serial)
        }
    }

    private func clearIfStill(_ serial: Int) {
        if mark?.serial == serial, mark?.live == false { mark = nil }
    }

    /// CoreGraphics' top-left global points → AppKit's bottom-left ones.
    func flip(_ point: ScreenPoint) -> CGPoint {
        CGPoint(x: point.x, y: mainDisplayHeight() - point.y)
    }
}
