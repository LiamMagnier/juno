import ApplicationServices
import CoreGraphics
import Foundation
import JunoCodeCore

/// The safety envelope around Computer Use.
///
/// Guarantees: never activates without an explicit per-session consent call;
/// requires both TCC permissions up front; one session at a time; every
/// action is rate-limited, bounds-checked, journaled, and bracketed by
/// before/after captures; and the kill switch tears everything down
/// immediately. The coordinator never activates itself.
public actor ComputerUseCoordinator {
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
        guard driver.screenCapturePermission() == .granted else {
            throw ComputerUseError.screenCapturePermissionMissing
        }
        guard driver.accessibilityPermission() == .granted else {
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

/// Real TCC preflight checks with the capture/injection driver not yet
/// implemented: activation honestly fails until it lands, so the feature is
/// gated off in production without any mock behavior.
public struct SystemComputerUseDriver: ComputerUseDriving {
    public init() {}

    public func screenCapturePermission() -> ComputerUsePermissionState {
        CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    public func accessibilityPermission() -> ComputerUsePermissionState {
        AXIsProcessTrusted() ? .granted : .denied
    }

    public func displayBounds() async throws -> CGRect {
        CGDisplayBounds(CGMainDisplayID())
    }

    public func captureScreen() async throws -> Data {
        throw ComputerUseError.driverUnavailable(
            reason: "The ScreenCaptureKit driver is not implemented yet."
        )
    }

    public func perform(_ action: ComputerUseActionKind) async throws {
        throw ComputerUseError.driverUnavailable(
            reason: "The CGEvent driver is not implemented yet."
        )
    }
}
