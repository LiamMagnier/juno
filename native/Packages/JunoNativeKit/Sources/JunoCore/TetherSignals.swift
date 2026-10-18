import Foundation
import Network
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// The apps' reconnect triggers for ``TetherLink`` (Tether, §3.1):
///
/// - the network coming back — `NWPathMonitor` reaching `.satisfied` — and
///   going away (`offline`);
/// - the app becoming active (`NSApplication.didBecomeActiveNotification`,
///   `UIApplication.didBecomeActiveNotification`);
/// - the Mac waking (`NSWorkspace.didWakeNotification`).
///
/// One monitor for the process, started on first use and shared by every
/// link, so a dozen open streams do not run a dozen path monitors.
@MainActor
public final class TetherSignals: TetherSignalSource {
    public static let shared = TetherSignals()

    public private(set) var isOnline = true
    private var listeners: [UUID: @MainActor (TetherSignal) -> Void] = [:]
    private var monitor: NWPathMonitor?
    private var observers: [any NSObjectProtocol] = []

    private init() {}

    public func subscribe(_ listener: @escaping @MainActor (TetherSignal) -> Void) -> TetherSubscription {
        start()
        let id = UUID()
        listeners[id] = listener
        return TetherSubscription { [weak self] in
            MainActor.assumeIsolated {
                _ = self?.listeners.removeValue(forKey: id)
            }
        }
    }

    /// Delivers a signal to every link. Public so the apps' own lifecycle
    /// hooks (e.g. a scene phase change) can feed it too.
    public func emit(_ signal: TetherSignal) {
        for listener in Array(listeners.values) { listener(signal) }
    }

    private func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                TetherSignals.shared.pathChanged(satisfied: satisfied)
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.alevr.tether.path", qos: .utility))

        #if canImport(AppKit)
        observers.append(
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
            ) { _ in
                MainActor.assumeIsolated { TetherSignals.shared.emit(.trigger(.wake)) }
            }
        )
        observers.append(
            NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { _ in
                MainActor.assumeIsolated { TetherSignals.shared.emit(.trigger(.foreground)) }
            }
        )
        #endif
        #if canImport(UIKit) && !os(watchOS)
        observers.append(
            NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { _ in
                MainActor.assumeIsolated { TetherSignals.shared.emit(.trigger(.foreground)) }
            }
        )
        #endif
    }

    private func pathChanged(satisfied: Bool) {
        let was = isOnline
        isOnline = satisfied
        if satisfied, !was {
            emit(.trigger(.network))
        } else if !satisfied, was {
            emit(.offline)
        }
    }
}
