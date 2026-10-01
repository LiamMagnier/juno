import Foundation
#if os(macOS)
import CoreGraphics
#endif

/// What the tap does with one event.
public enum EmergencyTapVerdict: Equatable, Sendable {
    /// Let it through untouched.
    case pass
    /// Swallow it and stop screen control: the reader pressed Esc.
    case consumeAndStop
    /// Swallow it: the release of an Esc that already stopped everything.
    case consume
    /// Let it through and tell the service the reader is using the Mac
    /// (takeover mode pauses on it).
    case readerInput
}

/// The decision, as a pure function, so it is tested without a tap.
///
/// Esc pressed on the keyboard stops screen control anywhere, and the key
/// press is consumed so content on screen cannot use it — an injected page
/// cannot "press Esc" to dismiss a dialog Juno is about to see, and the
/// reader's Esc is never delivered to the app being driven (CODE_AGENT_SPEC
/// §3.7, CU-10). Juno's own synthetic events carry ``syntheticMarker`` in
/// `eventSourceUserData`, so an Esc the model asked for reaches the app and
/// does not stop anything.
public enum EmergencyStopTapLogic {
    /// "JUNO" in ASCII.
    public static let syntheticMarker: Int64 = 0x4A55_4E4F
    public static let escapeKeyCode: Int64 = 53

    public enum EventKind: Sendable {
        case keyDown, keyUp, flagsChanged, mouse, scroll, other
    }

    public static func verdict(
        kind: EventKind,
        keyCode: Int64,
        sourceUserData: Int64,
        escapeIsDown: Bool,
        watchesForReaderInput: Bool
    ) -> EmergencyTapVerdict {
        if sourceUserData == syntheticMarker { return .pass }
        switch kind {
        case .keyDown where keyCode == escapeKeyCode:
            return .consumeAndStop
        case .keyUp where keyCode == escapeKeyCode && escapeIsDown:
            return .consume
        case .keyDown, .keyUp, .mouse, .scroll:
            return watchesForReaderInput ? .readerInput : .pass
        case .flagsChanged, .other:
            return .pass
        }
    }
}

/// The global Esc and the take-over watch.
public protocol EmergencyStopTapping: Sendable {
    /// Starts listening. False when macOS refused the tap (no
    /// Accessibility): screen control still works and the in-app and menu
    /// bar Stops still stop it.
    func start(
        watchReaderInput: Bool,
        onEscape: @escaping @Sendable () -> Void,
        onReaderInput: @escaping @Sendable () -> Void
    ) -> Bool
    func setWatchesReaderInput(_ watches: Bool)
    func stop()
}

#if os(macOS)

/// A listen-and-consume `CGEventTap` at the session level, installed while
/// screen control runs and removed when it stops.
public final class SystemEmergencyStopTap: EmergencyStopTapping, @unchecked Sendable {
    private let lock = NSLock()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var box: Box?

    final class Box: @unchecked Sendable {
        let onEscape: @Sendable () -> Void
        let onReaderInput: @Sendable () -> Void
        var watchesReaderInput: Bool
        var escapeIsDown = false
        weak var owner: SystemEmergencyStopTap?
        var lastReaderInputReport = Date.distantPast

        init(
            watchesReaderInput: Bool,
            onEscape: @escaping @Sendable () -> Void,
            onReaderInput: @escaping @Sendable () -> Void
        ) {
            self.watchesReaderInput = watchesReaderInput
            self.onEscape = onEscape
            self.onReaderInput = onReaderInput
        }
    }

    public init() {}

    deinit { stop() }

    public func start(
        watchReaderInput: Bool,
        onEscape: @escaping @Sendable () -> Void,
        onReaderInput: @escaping @Sendable () -> Void
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if tap != nil {
            box?.watchesReaderInput = watchReaderInput
            return true
        }
        let box = Box(watchesReaderInput: watchReaderInput, onEscape: onEscape, onReaderInput: onReaderInput)
        box.owner = self
        let types: [CGEventType] = [
            .keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved,
            .leftMouseDragged, .scrollWheel,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        let pointer = Unmanaged.passRetained(box).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: systemEmergencyTapCallback,
            userInfo: pointer
        ) else {
            Unmanaged<Box>.fromOpaque(pointer).release()
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        self.box = box
        return true
    }

    public func setWatchesReaderInput(_ watches: Bool) {
        lock.lock()
        box?.watchesReaderInput = watches
        lock.unlock()
    }

    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let box {
            // The callback runs on the main run loop and takes the box from
            // a raw pointer. Stop is called from the service's executor, so
            // the release waits for main: a callback already running there
            // finishes before the box can go away.
            let unmanaged = Unmanaged.passUnretained(box)
            DispatchQueue.main.async { unmanaged.release() }
        }
        tap = nil
        source = nil
        box = nil
    }

    fileprivate func reenable() {
        lock.lock()
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        lock.unlock()
    }
}

private func systemEmergencyTapCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let box = Unmanaged<SystemEmergencyStopTap.Box>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        box.owner?.reenable()
        return Unmanaged.passUnretained(event)
    }
    let kind: EmergencyStopTapLogic.EventKind = switch type {
    case .keyDown: .keyDown
    case .keyUp: .keyUp
    case .flagsChanged: .flagsChanged
    case .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged: .mouse
    case .scrollWheel: .scroll
    default: .other
    }
    let verdict = EmergencyStopTapLogic.verdict(
        kind: kind,
        keyCode: event.getIntegerValueField(.keyboardEventKeycode),
        sourceUserData: event.getIntegerValueField(.eventSourceUserData),
        escapeIsDown: box.escapeIsDown,
        watchesForReaderInput: box.watchesReaderInput
    )
    switch verdict {
    case .pass:
        return Unmanaged.passUnretained(event)
    case .consumeAndStop:
        box.escapeIsDown = true
        box.onEscape()
        return nil
    case .consume:
        box.escapeIsDown = false
        return nil
    case .readerInput:
        // Pointer moves arrive by the hundred; one report a second is plenty
        // to pause on.
        let now = Date()
        if now.timeIntervalSince(box.lastReaderInputReport) > 1 {
            box.lastReaderInputReport = now
            box.onReaderInput()
        }
        return Unmanaged.passUnretained(event)
    }
}

#endif
