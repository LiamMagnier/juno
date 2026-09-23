import Foundation
import JunoCodeCore

/// Reads the two screen-control grants without ever asking for them.
///
/// Settings shows the grants whether or not a session is open, so it cannot
/// borrow a session's coordinator; and it must never prompt, because a TCC
/// dialog that appears when a settings page opens is a dialog the reader did
/// not ask for. The system probe uses the driver's preflight calls
/// (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`), which only read.
///
/// Closures rather than a driver, so a test can say "Screen Recording is on,
/// Accessibility is not" in one line instead of faking capture and input.
public struct ComputerUsePermissionProbe: Sendable {
    private let screenRecording: @Sendable () -> ComputerUsePermissionState
    private let accessibility: @Sendable () -> ComputerUsePermissionState

    public init(
        screenRecording: @escaping @Sendable () -> ComputerUsePermissionState,
        accessibility: @escaping @Sendable () -> ComputerUsePermissionState
    ) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
    }

    /// Reads through a driver's non-prompting checks. The `request…` pair is
    /// deliberately not reachable from here.
    public init(driver: any ComputerUseDriving) {
        self.init(
            screenRecording: { driver.screenCapturePermission() },
            accessibility: { driver.accessibilityPermission() }
        )
    }

    /// This Mac, as macOS reports it to this process right now.
    public static let system = ComputerUsePermissionProbe(driver: SystemComputerUseDriver())

    public func read() -> ComputerUsePermissionStatus {
        ComputerUsePermissionStatus(
            screenRecording: screenRecording(),
            accessibility: accessibility()
        )
    }
}
