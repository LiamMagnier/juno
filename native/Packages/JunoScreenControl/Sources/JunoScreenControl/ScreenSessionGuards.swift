import Foundation
#if os(macOS)
import AppKit
import CoreGraphics
import IOKit.pwr_mgt
#endif

// The lock policy's seams (docs/rea/designs/computer-use.md §3.1, "Lock and
// sleep policy"). A locked Mac pauses every run; the display is kept awake
// only while a run is actually working; and nothing here, or anywhere in
// screen control, unlocks a Mac or types its password. That is a deliberate
// line: an agent that could reach a logged-out Mac would turn a stolen phone
// or an injected instruction into a session on the reader's desktop.
// `ScreenLockPolicyTests` scans the sources for unlock symbols.

/// Watches whether the Mac's login session can be used: unlocked, and the
/// one on the console (fast user switching moves it to the background).
public protocol ScreenSessionLockMonitoring: Sendable {
    /// A live read, for the check before every action.
    func isLocked() async -> Bool
    /// `true` when the session locks or leaves the console, `false` when it
    /// comes back. One consumer: the service.
    func changes() -> AsyncStream<Bool>
}

/// Keeps the display from sleeping while a run works. Idempotent both ways.
public protocol DisplayAwakeAsserting: Sendable {
    func hold(reason: String)
    func release()
}

/// Runs the display assertion's idle check later. One wake at a time and
/// never cancelled; the service re-checks on waking and asks again for what
/// is left of the idle span. Injected so tests fire it by hand and never
/// sleep or cancel a real task.
public protocol IdleTimerScheduling: Sendable {
    func schedule(after seconds: TimeInterval, _ fire: @escaping @Sendable () async -> Void)
}

/// Real time. `Task.sleep(nanoseconds:)`, not the generic `Task.sleep(for:)`,
/// which Xcode 26 mishandles (#98), and the task is never cancelled.
public struct SystemIdleTimer: IdleTimerScheduling {
    public init() {}

    public func schedule(after seconds: TimeInterval, _ fire: @escaping @Sendable () async -> Void) {
        let nanoseconds = UInt64(max(0, seconds) * 1_000_000_000)
        Task.detached {
            try? await Task.sleep(nanoseconds: nanoseconds)
            await fire()
        }
    }
}

/// The rules for a run nobody is watching (docs/rea/designs/computer-use.md
/// §3.1, "Unattended runs").
public enum ScreenUnattendedPolicy {
    /// How long an unattended run may use the screen unless its host says
    /// otherwise.
    public static let defaultLimit: TimeInterval = 30 * 60

    /// What the model is told when a step that needs approval is skipped.
    public static let skipSentence =
        "Skipped: nobody is watching this run, and this step needs the reader's approval. It was not done and is recorded for the reader; carry on with what you can do without it, and list it in your report."

    /// Why the skip was recorded, for the reader's list.
    public static let skipReason = "It needed your approval and nobody was watching the run."
}

/// What the app tells the reader, and their phone, when a run pauses because
/// the Mac locked, and again when it can carry on.
public struct ScreenLockNotice: Hashable, Sendable {
    public var sessionID: String
    public var kind: ScreenControlHolder.Kind
    public var title: String
    /// The conversation a connected agent's session belongs to.
    public var threadID: String?
    public var appName: String?
    /// True when the Mac locked; false once it is unlocked again.
    public var locked: Bool
    /// Whether the run waits for the reader's Resume after the unlock (it had
    /// the whole display) rather than carrying on in the background.
    public var waitsForResume: Bool
    public var at: Date

    public init(
        sessionID: String,
        kind: ScreenControlHolder.Kind,
        title: String,
        threadID: String? = nil,
        appName: String? = nil,
        locked: Bool,
        waitsForResume: Bool = false,
        at: Date
    ) {
        self.sessionID = sessionID
        self.kind = kind
        self.title = title
        self.threadID = threadID
        self.appName = appName
        self.locked = locked
        self.waitsForResume = waitsForResume
        self.at = at
    }

    /// The notification's title.
    public var headline: String {
        locked ? "Your Mac locked" : "Your Mac is unlocked"
    }

    /// One sentence for the notification and the thread.
    public var sentence: String {
        let product = ScreenControlBrand.productName
        let task = title.isEmpty ? "its task" : "“\(title)”"
        if locked {
            return "\(product) paused \(task). It never unlocks your Mac; unlock it to let \(product) carry on."
        }
        return waitsForResume
            ? "\(product) is still paused on \(task). Press Resume when you want it to carry on."
            : "\(product) is carrying on with \(task)."
    }
}

#if os(macOS)

/// The real session state: `CGSessionCopyCurrentDictionary` for the live
/// read, and the screen-lock and session-switch notifications for changes.
/// Public API only; it never asks the system to change the lock state.
public struct SystemSessionLockMonitor: ScreenSessionLockMonitoring {
    public init() {}

    public func isLocked() async -> Bool {
        Self.readLocked()
    }

    static func readLocked() -> Bool {
        guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if (info["CGSSessionScreenIsLocked"] as? Bool) == true { return true }
        if let onConsole = info[kCGSessionOnConsoleKey as String] as? Bool, !onConsole { return true }
        return false
    }

    public func changes() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let tokens = ObserverTokens()
            let distributed = DistributedNotificationCenter.default()
            tokens.add(distributed, distributed.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in
                continuation.yield(true)
            })
            tokens.add(distributed, distributed.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: nil) { _ in
                // A session that is unlocked but not on the console is still
                // not the reader's: read the live state rather than trust it.
                continuation.yield(Self.readLocked())
            })
            let workspace = NSWorkspace.shared.notificationCenter
            tokens.add(workspace, workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: nil) { _ in
                continuation.yield(true)
            })
            tokens.add(workspace, workspace.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: nil) { _ in
                continuation.yield(Self.readLocked())
            })
            continuation.onTermination = { _ in tokens.removeAll() }
        }
    }

    /// Observer tokens, removed when the stream ends.
    private final class ObserverTokens: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [(NotificationCenter, NSObjectProtocol)] = []

        func add(_ center: NotificationCenter, _ token: NSObjectProtocol) {
            lock.withLock { entries.append((center, token)) }
        }

        func removeAll() {
            let all = lock.withLock { () -> [(NotificationCenter, NSObjectProtocol)] in
                defer { entries = [] }
                return entries
            }
            for (center, token) in all { center.removeObserver(token) }
        }
    }
}

/// An IOKit power assertion that stops the display sleeping on idle. It never
/// wakes a sleeping display and never touches the lock.
public final class SystemDisplayAwakeAssertion: DisplayAwakeAsserting, @unchecked Sendable {
    private let lock = NSLock()
    private var assertionID: IOPMAssertionID?

    public init() {}

    deinit { release() }

    public func hold(reason: String) {
        lock.withLock {
            guard assertionID == nil else { return }
            var id = IOPMAssertionID(0)
            let status = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                reason as CFString,
                &id
            )
            if status == kIOReturnSuccess { assertionID = id }
        }
    }

    public func release() {
        lock.withLock {
            guard let id = assertionID else { return }
            IOPMAssertionRelease(id)
            assertionID = nil
        }
    }
}

#endif
