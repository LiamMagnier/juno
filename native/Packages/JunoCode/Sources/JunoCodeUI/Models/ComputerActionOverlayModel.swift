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
/// lingers a moment after the last step, then goes. No dots, no pills.
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
    }

    public private(set) var mark: Mark?

    @ObservationIgnored private let feed: ComputerActionFeed
    @ObservationIgnored private let mainDisplayHeight: () -> CGFloat
    @ObservationIgnored private let linger: Duration
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var hide: Task<Void, Never>?
    @ObservationIgnored private var serial = 0

    public init(
        feed: ComputerActionFeed = .shared,
        linger: Duration = .milliseconds(1_200),
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
    }

    func apply(_ cue: ComputerActionCue) {
        switch cue.phase {
        case .acting:
            hide?.cancel()
            serial += 1
            mark = Mark(
                label: cue.label,
                appName: cue.appName,
                point: cue.point.map(flip),
                live: true,
                succeeded: nil,
                serial: serial
            )
        case let .settled(succeeded):
            guard var current = mark else { return }
            current.live = false
            current.succeeded = succeeded
            mark = current
            scheduleHide(serial: current.serial)
        case .cleared:
            hide?.cancel()
            mark = nil
        }
    }

    private func scheduleHide(serial: Int) {
        hide?.cancel()
        let linger = self.linger
        hide = Task { [weak self] in
            try? await Task.sleep(for: linger)
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
