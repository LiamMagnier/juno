// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Something that says whether a window (macOS) or scene (iOS) can be seen.
///
/// The gates that need it: the Mac poll makes 0 requests while occluded, and
/// galaxies pause when the window is not visible or the scene is not active.
/// The app's real source reads `NSWindow.occlusionState` or `scenePhase`; a
/// test hands the code under test a `Wave2OcclusionMock` instead.
protocol Wave2VisibilitySource: AnyObject, Sendable {
    var isVisible: Bool { get }
    /// The current value first, then every change.
    func visibilityChanges() -> AsyncStream<Bool>
}

final class Wave2OcclusionMock: Wave2VisibilitySource, @unchecked Sendable {
    private let lock = NSLock()
    private var visible: Bool
    private var continuations: [UInt64: AsyncStream<Bool>.Continuation] = [:]
    private var nextID: UInt64 = 0
    private var history: [Bool] = []

    init(visible: Bool = true) {
        self.visible = visible
    }

    var isVisible: Bool { lock.withLock { visible } }

    /// Every value set since creation, in order (repeats included).
    var transitions: [Bool] { lock.withLock { history } }

    func setVisible(_ value: Bool) {
        let targets: [AsyncStream<Bool>.Continuation] = lock.withLock {
            visible = value
            history.append(value)
            return Array(continuations.values)
        }
        for continuation in targets { continuation.yield(value) }
    }

    func setOccluded(_ occluded: Bool) { setVisible(!occluded) }

    func visibilityChanges() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let id: UInt64 = lock.withLock {
                nextID += 1
                continuations[nextID] = continuation
                return nextID
            }
            continuation.yield(isVisible)
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                _ = self.lock.withLock { self.continuations.removeValue(forKey: id) }
            }
        }
    }

    /// Ends every stream, so a consumer's `for await` finishes.
    func finish() {
        let targets: [AsyncStream<Bool>.Continuation] = lock.withLock {
            defer { continuations.removeAll() }
            return Array(continuations.values)
        }
        for continuation in targets { continuation.finish() }
    }
}

#if os(macOS)
extension Wave2OcclusionMock {
    /// Posts the notification AppKit sends when a window's occlusion changes,
    /// for code that observes it directly rather than through a source.
    @MainActor
    static func postOcclusionChange(for window: NSWindow) {
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
    }
}
#elseif os(iOS)
extension Wave2OcclusionMock {
    /// Posts the notifications UIKit sends when a scene leaves or returns to
    /// the foreground, for code that observes them directly.
    @MainActor
    static func postSceneActivity(active: Bool, scene: UIScene? = nil) {
        let name = active ? UIScene.didActivateNotification : UIScene.willDeactivateNotification
        NotificationCenter.default.post(name: name, object: scene)
    }
}
#endif
