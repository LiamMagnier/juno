import Foundation
import JunoCodeCore

/// Reads the two screen-control grants without ever asking for them.
///
/// Settings shows the grants whether or not a session is open, so it cannot
/// borrow a session's coordinator; and it must never prompt, because a TCC
/// dialog that appears when a settings page opens is a dialog the reader did
/// not ask for. The system probe uses the preflight calls
/// (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`), which only read.
///
/// Closures rather than a driver, so a test can say "Screen Recording is on,
/// Accessibility is not" in one line instead of faking capture and input.
public struct ComputerUsePermissionProbe: Sendable {
    private let screenRecording: @Sendable () -> ComputerUsePermissionState
    private let accessibility: @Sendable () -> ComputerUsePermissionState
    private let trustMemory: AccessibilityTrustMemory?

    public init(
        screenRecording: @escaping @Sendable () -> ComputerUsePermissionState,
        accessibility: @escaping @Sendable () -> ComputerUsePermissionState,
        trustMemory: AccessibilityTrustMemory? = nil
    ) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
        self.trustMemory = trustMemory
    }

    /// Reads through a checker's non-prompting calls. The `request…` pair is
    /// deliberately not reachable from here.
    public init(checker: any ComputerUsePermissionChecking, trustMemory: AccessibilityTrustMemory? = nil) {
        self.init(
            screenRecording: { checker.screenCapturePermission() },
            accessibility: { checker.accessibilityPermission() },
            trustMemory: trustMemory
        )
    }

    #if os(macOS)
    /// This Mac, as macOS reports it to this process right now.
    public static let system = ComputerUsePermissionProbe(
        checker: SystemComputerUsePermissions(),
        trustMemory: .standard
    )
    #endif

    public func read() -> ComputerUsePermissionStatus {
        let accessibility = accessibility()
        return ComputerUsePermissionStatus(
            screenRecording: screenRecording(),
            accessibility: accessibility,
            accessibilityTrustLostAfterUpdate: trustMemory?.observe(accessibility) ?? false
        )
    }
}

/// Remembers which build macOS last trusted for Accessibility, so a grant
/// that vanished with an update can be told apart from one never given
/// (CU-20).
///
/// macOS ties the grant to the code signature. The ad-hoc-signed
/// development feed changes it on every update, so the switch in System
/// Settings stays on while `AXIsProcessTrusted()` says no — and toggling it
/// does nothing. Only removing Juno from the list and adding it again works.
public struct AccessibilityTrustMemory: @unchecked Sendable {
    private let defaults: UserDefaults
    private let build: String
    static let key = "juno.screenControl.accessibilityTrustedBuild"

    public init(defaults: UserDefaults, build: String) {
        self.defaults = defaults
        self.build = build
    }

    /// This app's build, as its bundle states it.
    public static var standard: AccessibilityTrustMemory {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let number = info?["CFBundleVersion"] as? String ?? "?"
        return AccessibilityTrustMemory(defaults: .standard, build: "\(version) (\(number))")
    }

    /// Records a trusted build; reports whether an untrusted one follows a
    /// different trusted build.
    @discardableResult
    public func observe(_ state: ComputerUsePermissionState) -> Bool {
        if state == .granted {
            defaults.set(build, forKey: Self.key)
            return false
        }
        guard let trusted = defaults.string(forKey: Self.key) else { return false }
        return trusted != build
    }
}
