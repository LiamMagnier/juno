import Foundation

public enum ComputerUsePermissionState: String, Codable, Sendable {
    case notDetermined
    case denied
    case granted
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
}

/// The low-level system driver: TCC checks, capture, and input injection.
/// The production implementation wraps ScreenCaptureKit, Accessibility and
/// CGEvent; it is injected so the coordinator's safety envelope is testable
/// and the app ships with the feature gated off until the driver lands.
public protocol ComputerUseDriving: Sendable {
    func screenCapturePermission() -> ComputerUsePermissionState
    func accessibilityPermission() -> ComputerUsePermissionState
    /// The bounds actions may address (the selected display).
    func displayBounds() async throws -> CGRect
    /// PNG screenshot of the selected display. Ephemeral: callers must not
    /// persist it into sync records or analytics.
    func captureScreen() async throws -> Data
    func perform(_ action: ComputerUseActionKind) async throws
}
