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
    public let activeSessionID: CodeSessionID?
    public let screenCapturePermission: ComputerUsePermissionState
    public let accessibilityPermission: ComputerUsePermissionState
    public let displayBounds: CGRect?
    public let journal: [ComputerUseJournalEntry]

    public init(
        isActive: Bool,
        activeSessionID: CodeSessionID?,
        screenCapturePermission: ComputerUsePermissionState,
        accessibilityPermission: ComputerUsePermissionState,
        displayBounds: CGRect?,
        journal: [ComputerUseJournalEntry]
    ) {
        self.isActive = isActive
        self.activeSessionID = activeSessionID
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
    /// Changes whenever an active grant is revoked or replaced.
    ///
    /// Actor isolation alone is not a cancellation boundary: `perform` yields
    /// while it asks the driver for bounds and screenshots, so a deactivate or
    /// emergency stop can run while that action is suspended. Capturing this
    /// generation lets the resumed action prove that it still owns the same
    /// consent grant before it reaches input injection.
    private var activationGeneration: UInt64 = 0
    /// Only one driver operation may be in flight. The token, rather than a
    /// Boolean, prevents an older action's `defer` from clearing a newer one.
    private var inFlightActionID: UUID?
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
        let activeSessionID: CodeSessionID?
        switch state {
        case .idle:
            isActive = false
            activeSessionID = nil
        case .active(let sessionID):
            isActive = true
            activeSessionID = sessionID
        }
        return ComputerUseSnapshot(
            isActive: isActive,
            activeSessionID: activeSessionID,
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
        if case .idle = state {
            activationGeneration &+= 1
        }
        state = .active(sessionID: sessionID)
    }

    public func deactivate(sessionID: CodeSessionID) {
        guard case .active(sessionID) = state else { return }
        state = .idle
        activationGeneration &+= 1
        lastActionAt = nil
    }

    /// The kill switch: immediate, unconditional, and always available.
    public func emergencyStop() {
        state = .idle
        activationGeneration &+= 1
        lastActionAt = nil
    }

    public func displayBounds() async throws -> CGRect {
        try await driver.displayBounds()
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
        guard inFlightActionID == nil else {
            throw ComputerUseError.rateLimited(
                minimumIntervalSeconds: Self.minimumActionIntervalSeconds
            )
        }
        let currentTime = now()
        if let last = lastActionAt,
           currentTime.timeIntervalSince(last) < Self.minimumActionIntervalSeconds
        {
            throw ComputerUseError.rateLimited(
                minimumIntervalSeconds: Self.minimumActionIntervalSeconds
            )
        }
        let generation = activationGeneration
        let actionID = UUID()
        inFlightActionID = actionID
        defer {
            if inFlightActionID == actionID {
                inFlightActionID = nil
            }
        }

        do {
            try await validateCoordinates(of: action)
            try requireActiveGrant(sessionID: sessionID, generation: generation)
        } catch {
            record(
                action,
                sessionID: sessionID,
                succeeded: false,
                note: String(describing: error)
            )
            throw error
        }
        lastActionAt = currentTime

        do {
            let before = try await driver.captureScreen()
            try requireActiveGrant(sessionID: sessionID, generation: generation)
            if case .screenshot = action {
                record(action, sessionID: sessionID, succeeded: true, note: nil)
                return (before, before)
            }
            // This is the final suspension boundary before input injection. A
            // stop that ran during coordinate validation or capture invalidates
            // the generation and cannot fall through to the driver.
            try requireActiveGrant(sessionID: sessionID, generation: generation)
            try await driver.perform(action)
            try requireActiveGrant(sessionID: sessionID, generation: generation)
            let after = try await driver.captureScreen()
            try requireActiveGrant(sessionID: sessionID, generation: generation)
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

    private func requireActiveGrant(
        sessionID: CodeSessionID,
        generation: UInt64
    ) throws {
        guard generation == activationGeneration else {
            throw ComputerUseError.notActive
        }
        guard case let .active(activeSession) = state else {
            throw ComputerUseError.notActive
        }
        guard activeSession == sessionID else {
            throw ComputerUseError.activeForAnotherSession
        }
    }

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
        // Capture in the same logical-point coordinate space CGEvent uses.
        // Using SCDisplay's physical pixel dimensions on Retina displays made
        // model-selected screenshot coordinates land at half their intended
        // location.
        let actionBounds = CGDisplayBounds(display.displayID)
        configuration.width = max(1, Int(actionBounds.width.rounded()))
        configuration.height = max(1, Int(actionBounds.height.rounded()))
        configuration.showsCursor = true
        configuration.capturesAudio = false

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ComputerUseError.driverUnavailable(reason: "Could not encode the screen image.")
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [
                kCGImageDestinationLossyCompressionQuality: 0.82,
            ] as CFDictionary
        )
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
        let (code, flags) = try Self.resolveChord(key)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        else {
            throw ComputerUseError.driverUnavailable(reason: "Could not create a key event.")
        }
        // The flags have to be set on both events. Posting a key-down carrying
        // `.maskCommand` and a key-up without it leaves the receiving app believing
        // Command is still held, which turns the *next* ordinary keystroke into
        // another shortcut.
        if !flags.isEmpty {
            down.flags = flags
            up.flags = flags
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    /// Resolves `"cmd+shift+p"`, `"return"` or `"a"` to a key code and modifiers.
    ///
    /// Chords are the point. The table below has always had `command` and `shift`
    /// in it, but only as *standalone* keys — there was no way to express a
    /// combination, and no letters or digits at all, so an agent driving the screen
    /// could not press ⌘S to save, ⌘C to copy, or the letter `a`. Every real
    /// keyboard interaction in a Mac app is a chord or a character, which made
    /// `computer_press_key` close to useless: it could send Tab, Escape and the
    /// arrow keys and nothing else.
    ///
    /// Pressing a bare modifier still works (`"shift"` alone resolves to its own key
    /// code) because holding one is occasionally the whole gesture.
    static func resolveChord(_ key: String) throws -> (CGKeyCode, CGEventFlags) {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            throw ComputerUseError.driverUnavailable(reason: "No key was given.")
        }
        // Split on + and -, so both "cmd+s" and "cmd-s" parse. A lone "+" or "-" is
        // a key in its own right, hence the empty-component filter and the
        // single-token fast path.
        let parts = normalized
            .split(whereSeparator: { $0 == "+" || $0 == "-" })
            .map(String.init)
        guard parts.count > 1 else {
            guard let code = keyCodes[normalized] else {
                throw ComputerUseError.driverUnavailable(reason: "Unsupported key '\(key)'.")
            }
            return (code, [])
        }

        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            guard let mask = modifierFlags[modifier] else {
                throw ComputerUseError.driverUnavailable(
                    reason: "Unsupported modifier '\(modifier)' in '\(key)'."
                )
            }
            flags.insert(mask)
        }
        guard let base = parts.last, let code = keyCodes[base] else {
            throw ComputerUseError.driverUnavailable(reason: "Unsupported key '\(key)'.")
        }
        return (code, flags)
    }

    private static let modifierFlags: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
        "super": .maskCommand,
        "shift": .maskShift,
        "opt": .maskAlternate, "option": .maskAlternate, "alt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
        "fn": .maskSecondaryFn,
    ]

    /// US ANSI virtual key codes. The layout-independent `kVK_ANSI_*` values, which
    /// is what `CGEvent(keyboardEventSource:virtualKey:keyDown:)` takes.
    private static let keyCodes: [String: CGKeyCode] = [
        // Editing and navigation
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "backspace": 51, "forwarddelete": 117,
        "escape": 53, "esc": 53, "capslock": 57,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        // Bare modifiers, for when holding one is the gesture itself
        "command": 55, "shift": 56, "option": 58, "control": 59,
        "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
        // Function row
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        // Letters
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6,
        // Digits
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
        "7": 26, "8": 28, "9": 25,
        // Punctuation an editor actually needs
        "-": 27, "minus": 27, "=": 24, "equal": 24,
        "[": 33, "leftbracket": 33, "]": 30, "rightbracket": 30,
        ";": 41, "semicolon": 41, "'": 39, "quote": 39,
        "\\": 42, "backslash": 42, ",": 43, "comma": 43,
        ".": 47, "period": 47, "/": 44, "slash": 44,
        "`": 50, "grave": 50,
    ]
}
