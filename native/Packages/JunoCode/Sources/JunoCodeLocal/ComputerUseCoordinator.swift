import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import JunoCodeCore
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Read-only Computer Use state for presentation. It contains no driver
/// capability and cannot perform an action; the UI must still go through the
/// coordinator's consent and safety envelope.
public struct ComputerUseSnapshot: Sendable {
    public let isActive: Bool
    public let screenCapturePermission: ComputerUsePermissionState
    public let accessibilityPermission: ComputerUsePermissionState
    public let displayBounds: CGRect?
    public let journal: [ComputerUseJournalEntry]

    public init(
        isActive: Bool,
        screenCapturePermission: ComputerUsePermissionState,
        accessibilityPermission: ComputerUsePermissionState,
        displayBounds: CGRect?,
        journal: [ComputerUseJournalEntry]
    ) {
        self.isActive = isActive
        self.screenCapturePermission = screenCapturePermission
        self.accessibilityPermission = accessibilityPermission
        self.displayBounds = displayBounds
        self.journal = journal
    }
}

/// The safety envelope around Computer Use.
///
/// Guarantees: never activates without an explicit per-session consent call;
/// requires both TCC permissions up front; one session at a time; every
/// action is rate-limited, bounds-checked, journaled, and bracketed by
/// before/after captures; and the kill switch tears everything down
/// immediately. The coordinator never activates itself.
public actor ComputerUseCoordinator: ComputerUseCoordinating {
    public static let minimumActionIntervalSeconds: Double = 0.5

    public enum State: Equatable, Sendable {
        case idle
        case active(sessionID: CodeSessionID)
    }

    private let driver: any ComputerUseDriving
    private var state: State = .idle
    private var journal: [ComputerUseJournalEntry] = []
    private var lastActionAt: Date?
    private let now: @Sendable () -> Date

    public init(
        driver: any ComputerUseDriving,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.driver = driver
        self.now = now
    }

    public var currentState: State { state }
    public var actionJournal: [ComputerUseJournalEntry] { journal }

    /// Returns current TCC and session state without prompting or capturing.
    /// Preflight is safe to call when the inspector appears; permission prompts
    /// remain exclusive to an explicit activation gesture.
    public func snapshot() async -> ComputerUseSnapshot {
        let bounds = try? await driver.displayBounds()
        let isActive: Bool
        switch state {
        case .idle: isActive = false
        case .active: isActive = true
        }
        return ComputerUseSnapshot(
            isActive: isActive,
            screenCapturePermission: driver.screenCapturePermission(),
            accessibilityPermission: driver.accessibilityPermission(),
            displayBounds: bounds,
            journal: journal
        )
    }

    // MARK: - Lifecycle

    /// Activates Computer Use for one session. `userConsented` must be the
    /// result of an explicit user gesture in this session; passing false is
    /// always an error. Never called automatically.
    public func activate(sessionID: CodeSessionID, userConsented: Bool) throws {
        guard userConsented else {
            throw ComputerUseError.consentRequired
        }
        if case let .active(current) = state, current != sessionID {
            throw ComputerUseError.activeForAnotherSession
        }
        guard driver.requestScreenCapturePermission() == .granted else {
            throw ComputerUseError.screenCapturePermissionMissing
        }
        guard driver.requestAccessibilityPermission() == .granted else {
            throw ComputerUseError.accessibilityPermissionMissing
        }
        state = .active(sessionID: sessionID)
    }

    public func deactivate() {
        state = .idle
    }

    /// The kill switch: immediate, unconditional, and always available.
    public func emergencyStop() {
        state = .idle
        lastActionAt = nil
    }

    // MARK: - Actions

    /// Performs one action with the full envelope: active-state check, rate
    /// limit, coordinate validation, capture-before, action, capture-after.
    /// Returns the two captures for the session's Computer view.
    @discardableResult
    public func perform(
        _ action: ComputerUseActionKind,
        sessionID: CodeSessionID
    ) async throws -> (before: Data, after: Data) {
        guard case let .active(activeSession) = state else {
            throw ComputerUseError.notActive
        }
        guard activeSession == sessionID else {
            throw ComputerUseError.activeForAnotherSession
        }
        let currentTime = now()
        if let last = lastActionAt,
           currentTime.timeIntervalSince(last) < Self.minimumActionIntervalSeconds
        {
            throw ComputerUseError.rateLimited(
                minimumIntervalSeconds: Self.minimumActionIntervalSeconds
            )
        }
        try await validateCoordinates(of: action)
        lastActionAt = currentTime

        do {
            let before = try await driver.captureScreen()
            if case .screenshot = action {
                record(action, sessionID: sessionID, succeeded: true, note: nil)
                return (before, before)
            }
            try await driver.perform(action)
            let after = try await driver.captureScreen()
            record(action, sessionID: sessionID, succeeded: true, note: nil)
            return (before, after)
        } catch {
            record(
                action,
                sessionID: sessionID,
                succeeded: false,
                note: String(describing: error)
            )
            throw error
        }
    }

    // MARK: - Helpers

    private func validateCoordinates(of action: ComputerUseActionKind) async throws {
        let point: (Double, Double)?
        switch action {
        case let .click(x, y), let .doubleClick(x, y):
            point = (x, y)
        case let .scroll(x, y, _):
            point = (x, y)
        case .screenshot, .typeText, .pressKey:
            point = nil
        }
        guard let (x, y) = point else { return }
        let bounds = try await driver.displayBounds()
        guard bounds.contains(CGPoint(x: x, y: y)) else {
            throw ComputerUseError.coordinatesOutOfBounds
        }
    }

    private func record(
        _ action: ComputerUseActionKind,
        sessionID: CodeSessionID,
        succeeded: Bool,
        note: String?
    ) {
        journal.append(
            ComputerUseJournalEntry(
                sessionID: sessionID,
                action: action,
                timestamp: now(),
                succeeded: succeeded,
                note: note
            )
        )
        if journal.count > 1_000 {
            journal.removeFirst(journal.count - 1_000)
        }
    }
}

/// ScreenCaptureKit capture and CGEvent input injection for the selected main
/// display. The coordinator above remains the safety boundary: this driver
/// cannot be reached until the reader explicitly activates Computer Use for one
/// session, and every action is bounded, rate-limited and journaled.
public struct SystemComputerUseDriver: ComputerUseDriving {
    public init() {}

    public func screenCapturePermission() -> ComputerUsePermissionState {
        CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    public func accessibilityPermission() -> ComputerUsePermissionState {
        AXIsProcessTrusted() ? .granted : .denied
    }

    public func requestScreenCapturePermission() -> ComputerUsePermissionState {
        if CGPreflightScreenCaptureAccess() { return .granted }
        return CGRequestScreenCaptureAccess() ? .granted : .denied
    }

    public func requestAccessibilityPermission() -> ComputerUsePermissionState {
        if AXIsProcessTrusted() { return .granted }
        let options = [
            "AXTrustedCheckOptionPrompt": true,
        ] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .denied
    }

    public func displayBounds() async throws -> CGRect {
        CGDisplayBounds(CGMainDisplayID())
    }

    public func captureScreen() async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
            ?? content.displays.first
        else {
            throw ComputerUseError.driverUnavailable(reason: "No capturable display is available.")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.showsCursor = true
        configuration.capturesAudio = false

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw ComputerUseError.driverUnavailable(reason: "Could not encode the screen image.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ComputerUseError.driverUnavailable(reason: "Could not finish the screen image.")
        }
        return data as Data
    }

    public func perform(_ action: ComputerUseActionKind) async throws {
        switch action {
        case .screenshot:
            return
        case let .click(x, y):
            try click(at: CGPoint(x: x, y: y), count: 1)
        case let .doubleClick(x, y):
            try click(at: CGPoint(x: x, y: y), count: 2)
        case .typeText(let text):
            try type(text)
        case .pressKey(let key):
            try press(key)
        case let .scroll(x, y, deltaY):
            guard let event = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .pixel,
                wheelCount: 1,
                wheel1: Int32(clamping: Int(deltaY.rounded())),
                wheel2: 0,
                wheel3: 0
            ) else {
                throw ComputerUseError.driverUnavailable(reason: "Could not create a scroll event.")
            }
            event.location = CGPoint(x: x, y: y)
            event.post(tap: .cghidEventTap)
        }
    }

    private func click(at point: CGPoint, count: Int) throws {
        for index in 1...count {
            guard let down = CGEvent(
                mouseEventSource: nil,
                mouseType: .leftMouseDown,
                mouseCursorPosition: point,
                mouseButton: .left
            ), let up = CGEvent(
                mouseEventSource: nil,
                mouseType: .leftMouseUp,
                mouseCursorPosition: point,
                mouseButton: .left
            ) else {
                throw ComputerUseError.driverUnavailable(reason: "Could not create a click event.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private func type(_ text: String) throws {
        let units = Array(text.utf16)
        guard !units.isEmpty else { return }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else {
            throw ComputerUseError.driverUnavailable(reason: "Could not create a typing event.")
        }
        units.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private func press(_ key: String) throws {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let code = Self.keyCodes[normalized] else {
            throw ComputerUseError.driverUnavailable(reason: "Unsupported key '\(key)'.")
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        else {
            throw ComputerUseError.driverUnavailable(reason: "Could not create a key event.")
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "escape": 53, "esc": 53, "command": 55, "shift": 56, "capslock": 57,
        "option": 58, "control": 59, "rightshift": 60, "rightoption": 61,
        "rightcontrol": 62, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
}
