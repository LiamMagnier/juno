import Foundation

public enum ComputerUsePermissionState: String, Codable, Sendable {
    case notDetermined
    case denied
    case granted
}

/// The two macOS privacy grants screen control cannot start without.
///
/// Named here, beside the state they are read into, so the coordinator's
/// refusal, the session's notice and the settings page all point at the same
/// System Settings pane for the same grant.
public enum ComputerUsePermission: String, CaseIterable, Sendable {
    /// ScreenCaptureKit, for the screenshots the agent looks at.
    case screenRecording
    /// Posting CGEvents into other apps: clicks, typing, keys and scrolls.
    case accessibility

    public var title: String {
        switch self {
        case .screenRecording: "Screen Recording"
        case .accessibility: "Accessibility"
        }
    }

    /// The Privacy & Security pane that lists Juno for this grant. macOS has
    /// no API that grants either one; the reader flips the switch there.
    public var privacySettingsURL: URL {
        let anchor = switch self {
        case .screenRecording: "Privacy_ScreenCapture"
        case .accessibility: "Privacy_Accessibility"
        }
        // Force-unwrapped because both strings are constants that parse; a
        // failure here is a typo, not a runtime condition.
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }
}

/// Both grants, as macOS reported them at one moment.
///
/// macOS answers only "does this process hold the grant". A refusal and a
/// question never asked both read as not granted, so nothing downstream may
/// tell the reader which of the two happened.
public struct ComputerUsePermissionStatus: Equatable, Sendable {
    public var screenRecording: ComputerUsePermissionState
    public var accessibility: ComputerUsePermissionState

    public init(
        screenRecording: ComputerUsePermissionState,
        accessibility: ComputerUsePermissionState
    ) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
    }

    /// Before anything has been read.
    public static let unknown = ComputerUsePermissionStatus(
        screenRecording: .notDetermined,
        accessibility: .notDetermined
    )

    public func state(of permission: ComputerUsePermission) -> ComputerUsePermissionState {
        switch permission {
        case .screenRecording: screenRecording
        case .accessibility: accessibility
        }
    }

    /// Every grant still missing, in the order the coordinator asks for them:
    /// Screen Recording first. A notice with room for one button opens the
    /// first, which is also the one macOS will prompt for on the next start.
    public var missing: [ComputerUsePermission] {
        ComputerUsePermission.allCases.filter { state(of: $0) != .granted }
    }

    public var isReady: Bool { missing.isEmpty }
}

/// The last screenshot the agent took in a session.
///
/// Only a screenshot, never the captures that bracket a click or a
/// keystroke: those tell the coordinator the action landed, but no tool hands
/// them to the model, and the reader is shown this as what the agent saw.
///
/// Memory only. It exists so the reader can see what the agent last looked
/// at while screen control runs, and is dropped the moment it stops; it is
/// never written to the transcript, the session store or sync.
public struct ComputerUseCapture: Equatable, Sendable {
    public let sessionID: CodeSessionID
    /// JPEG, in display points: the same bytes the screenshot tool sent the
    /// model.
    public let imageData: Data
    public let capturedAt: Date

    public init(sessionID: CodeSessionID, imageData: Data, capturedAt: Date) {
        self.sessionID = sessionID
        self.imageData = imageData
        self.capturedAt = capturedAt
    }
}

/// The agent's screen-control tools, by the names the model calls them.
///
/// In Core rather than beside the tools because the settings layer needs
/// them too: which file may allow a tool without asking depends on whether
/// the tool drives the mouse and keyboard.
public enum ComputerUseToolName {
    public static let screenshot = "computer_screenshot"
    public static let click = "computer_click"
    public static let type = "computer_type"
    public static let pressKey = "computer_press_key"
    public static let scroll = "computer_scroll"

    /// The tools that act on the reader's Mac. A screenshot is not one of
    /// them: looking is a read, and never asks.
    public static let input: Set<String> = [click, type, pressKey, scroll]
}

public enum ComputerUseActionKind: Hashable, Codable, Sendable {
    case screenshot
    case click(x: Double, y: Double)
    case doubleClick(x: Double, y: Double)
    case typeText(String)
    case pressKey(String)
    case scroll(x: Double, y: Double, deltaY: Double)
}

public struct ComputerUseJournalEntry: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let action: ComputerUseActionKind
    public let timestamp: Date
    public let succeeded: Bool
    public let note: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        action: ComputerUseActionKind,
        timestamp: Date,
        succeeded: Bool,
        note: String?
    ) {
        self.id = id
        self.sessionID = sessionID
        self.action = action
        self.timestamp = timestamp
        self.succeeded = succeeded
        self.note = note
    }
}

public enum ComputerUseError: Error, Equatable, Sendable {
    case consentRequired
    case screenCapturePermissionMissing
    case accessibilityPermissionMissing
    case notActive
    case activeForAnotherSession
    case rateLimited(minimumIntervalSeconds: Double)
    case coordinatesOutOfBounds
    case driverUnavailable(reason: String)

    /// The grant this refusal is about, when it is about one.
    public var missingPermission: ComputerUsePermission? {
        switch self {
        case .screenCapturePermissionMissing: .screenRecording
        case .accessibilityPermissionMissing: .accessibility
        default: nil
        }
    }
}

/// The low-level system driver: TCC checks, capture, and input injection.
/// The production implementation wraps ScreenCaptureKit, Accessibility and
/// CGEvent; it is injected so the coordinator's safety envelope is testable
/// and the app ships with the feature gated off until the driver lands.
public protocol ComputerUseDriving: Sendable {
    func screenCapturePermission() -> ComputerUsePermissionState
    func accessibilityPermission() -> ComputerUsePermissionState
    /// Requests the two macOS TCC grants. Production calls these only after an
    /// explicit Computer Use gesture; test drivers can inherit the defaults.
    func requestScreenCapturePermission() -> ComputerUsePermissionState
    func requestAccessibilityPermission() -> ComputerUsePermissionState
    /// The bounds actions may address (the selected display).
    func displayBounds() async throws -> CGRect
    /// Compressed screenshot of the selected display. Ephemeral: callers must not
    /// persist it into sync records or analytics.
    func captureScreen() async throws -> Data
    func perform(_ action: ComputerUseActionKind) async throws
}

public extension ComputerUseDriving {
    func requestScreenCapturePermission() -> ComputerUsePermissionState {
        screenCapturePermission()
    }

    func requestAccessibilityPermission() -> ComputerUsePermissionState {
        accessibilityPermission()
    }
}

/// The safe, session-scoped surface exposed to agent tools and UI. Implemented
/// by the macOS coordinator, not by the low-level driver, so callers cannot
/// bypass consent, permission checks, rate limits, bounds checks or journaling.
public protocol ComputerUseCoordinating: Sendable {
    func activate(sessionID: CodeSessionID, userConsented: Bool) async throws
    func deactivate(sessionID: CodeSessionID) async
    func emergencyStop() async
    func displayBounds() async throws -> CGRect
    func perform(
        _ action: ComputerUseActionKind,
        sessionID: CodeSessionID
    ) async throws -> (before: Data, after: Data)
}
