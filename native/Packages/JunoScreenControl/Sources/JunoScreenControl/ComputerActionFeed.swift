import Foundation

/// What the on-screen action overlay draws (Code v2 SPEC §3.12): where the
/// next input lands and what it is, the moment it is sent, for every session,
/// Work task and connected agent alike — the service posts it, not the tools.
public struct ComputerActionCue: Hashable, Sendable {
    public enum Phase: Hashable, Sendable {
        /// About to send: the ring goes to `point`, the label reads the action.
        case acting
        /// Sent; the screen has settled.
        case settled(succeeded: Bool)
        /// Screen control ended (stop, release): the overlay goes away.
        case cleared
    }

    public var sessionID: String
    /// "Click the “Export…” button in Pages".
    public var label: String
    /// Global CoreGraphics points (top-left origin), when the action has one.
    public var point: ScreenPoint?
    public var appName: String?
    public var phase: Phase
    public var at: Date

    public init(sessionID: String, label: String, point: ScreenPoint?, appName: String?, phase: Phase, at: Date = Date()) {
        self.sessionID = sessionID
        self.label = label
        self.point = point
        self.appName = appName
        self.phase = phase
        self.at = at
    }
}

/// A many-listener broadcast of ``ComputerActionCue``s. Memory only.
public final class ComputerActionFeed: @unchecked Sendable {
    public static let shared = ComputerActionFeed()

    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<ComputerActionCue>.Continuation] = [:]
    private var latest: ComputerActionCue?

    public init() {}

    /// Cues from now on, starting with the latest one (so a window opened
    /// mid-action draws it).
    public func cues() -> AsyncStream<ComputerActionCue> {
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(8)) { continuation in
            lock.lock()
            continuations[id] = continuation
            let current = latest
            lock.unlock()
            if let current, current.phase != .cleared { continuation.yield(current) }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.continuations[id] = nil
                self.lock.unlock()
            }
        }
    }

    public func post(_ cue: ComputerActionCue) {
        lock.lock()
        latest = cue
        let targets = Array(continuations.values)
        lock.unlock()
        for continuation in targets { continuation.yield(cue) }
    }
}
