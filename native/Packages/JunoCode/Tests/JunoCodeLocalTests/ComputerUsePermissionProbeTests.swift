import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// A driver that fails the test if anything asks macOS for a grant. The probe
/// backs a settings page and a notice that draw on their own; neither may
/// ever put a TCC dialog in front of the reader.
private final class PromptTrap: ComputerUsePermissionChecking, @unchecked Sendable {
    let screen: ComputerUsePermissionState
    let accessibility: ComputerUsePermissionState
    private(set) var requests = 0

    init(screen: ComputerUsePermissionState, accessibility: ComputerUsePermissionState) {
        self.screen = screen
        self.accessibility = accessibility
    }

    func screenCapturePermission() -> ComputerUsePermissionState { screen }
    func accessibilityPermission() -> ComputerUsePermissionState { accessibility }
    func requestScreenCapturePermission() -> ComputerUsePermissionState {
        requests += 1
        return screen
    }
    func requestAccessibilityPermission() -> ComputerUsePermissionState {
        requests += 1
        return accessibility
    }
}

/// A grant the test flips between reads, the way the reader does in System
/// Settings.
private final class GrantSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var state: ComputerUsePermissionState

    init(_ state: ComputerUsePermissionState) {
        self.state = state
    }

    var value: ComputerUsePermissionState {
        get { lock.withLock { state } }
        set { lock.withLock { state = newValue } }
    }
}

final class ComputerUsePermissionProbeTests: XCTestCase {
    private func probe(
        _ screen: ComputerUsePermissionState,
        _ accessibility: ComputerUsePermissionState
    ) -> ComputerUsePermissionProbe {
        ComputerUsePermissionProbe(screenRecording: { screen }, accessibility: { accessibility })
    }

    func testBothMissingAreListedScreenRecordingFirst() {
        let status = probe(.denied, .denied).read()
        XCTAssertEqual(status.missing, [.screenRecording, .accessibility])
        XCTAssertFalse(status.isReady)
    }

    func testOnlyTheGrantStillMissingIsListed() {
        XCTAssertEqual(probe(.granted, .denied).read().missing, [.accessibility])
        XCTAssertEqual(probe(.denied, .granted).read().missing, [.screenRecording])
    }

    func testNeverAskedCountsAsMissing() {
        // macOS cannot tell the reader "you refused" from "nobody asked"; both
        // mean the grant has to be made before screen control can start.
        let status = probe(.notDetermined, .granted).read()
        XCTAssertEqual(status.state(of: .screenRecording), .notDetermined)
        XCTAssertEqual(status.missing, [.screenRecording])
    }

    func testBothGrantedIsReady() {
        let status = probe(.granted, .granted).read()
        XCTAssertTrue(status.missing.isEmpty)
        XCTAssertTrue(status.isReady)
        XCTAssertEqual(status.state(of: .screenRecording), .granted)
        XCTAssertEqual(status.state(of: .accessibility), .granted)
    }

    func testEveryReadAsksAgain() {
        // The settings page re-reads when the reader comes back from System
        // Settings; a probe that cached its first answer would show a grant
        // they just made as still missing.
        let accessibility = GrantSwitch(.denied)
        let probe = ComputerUsePermissionProbe(
            screenRecording: { .granted },
            accessibility: { accessibility.value }
        )
        XCTAssertEqual(probe.read().missing, [.accessibility])
        accessibility.value = .granted
        XCTAssertTrue(probe.read().isReady)
    }

    func testDriverProbeReadsWithoutEverPrompting() {
        let trap = PromptTrap(screen: .denied, accessibility: .granted)
        let status = ComputerUsePermissionProbe(checker: trap).read()
        XCTAssertEqual(
            status,
            ComputerUsePermissionStatus(screenRecording: .denied, accessibility: .granted)
        )
        XCTAssertEqual(trap.requests, 0)
    }

    func testSystemProbeReportsAnAnswerForBoth() {
        // Preflight only: this runs on any Mac without a dialog, and macOS
        // always answers granted or not, never "not asked".
        let status = ComputerUsePermissionProbe.system.read()
        XCTAssertNotEqual(status.screenRecording, .notDetermined)
        XCTAssertNotEqual(status.accessibility, .notDetermined)
    }

    func testEachGrantOpensItsOwnPrivacyPane() {
        XCTAssertEqual(
            ComputerUsePermission.screenRecording.privacySettingsURL.absoluteString,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        )
        XCTAssertEqual(
            ComputerUsePermission.accessibility.privacySettingsURL.absoluteString,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        )
    }

    func testCoordinatorRefusalsNameTheGrant() {
        XCTAssertEqual(ComputerUseError.screenCapturePermissionMissing.missingPermission, .screenRecording)
        XCTAssertEqual(ComputerUseError.accessibilityPermissionMissing.missingPermission, .accessibility)
        XCTAssertNil(ComputerUseError.notActive.missingPermission)
        XCTAssertNil(ComputerUseError.consentRequired.missingPermission)
    }

    func testSnapshotCarriesTheSamePermissionStatus() async {
        let trap = PromptTrap(screen: .granted, accessibility: .denied)
        let snapshot = await ComputerUseCoordinator(service: makeTestScreenService(), permissions: trap).snapshot()
        XCTAssertEqual(snapshot.permissions.missing, [.accessibility])
        XCTAssertEqual(trap.requests, 0)
    }

    // MARK: CU-20

    private func trustMemory(build: String, suite: String) -> AccessibilityTrustMemory {
        AccessibilityTrustMemory(defaults: UserDefaults(suiteName: suite)!, build: build)
    }

    func testAGrantLostWithAnUpdateIsToldApartFromOneNeverGiven() {
        let suite = "juno.tests.trust.\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        // Never trusted: just missing.
        XCTAssertFalse(trustMemory(build: "1.9.3 (94)", suite: suite).observe(.denied))
        // Trusted on 1.9.3 …
        XCTAssertFalse(trustMemory(build: "1.9.3 (94)", suite: suite).observe(.granted))
        // … and the ad-hoc 1.9.4 update voided it while Settings shows it on.
        let probe = ComputerUsePermissionProbe(
            screenRecording: { .granted },
            accessibility: { .denied },
            trustMemory: trustMemory(build: "1.9.4 (95)", suite: suite)
        )
        let status = probe.read()
        XCTAssertTrue(status.accessibilityTrustLostAfterUpdate)
        XCTAssertEqual(
            ComputerUsePermissionStatus.trustLostAdvice,
            "macOS no longer trusts this build of Juno. Remove Juno from the Accessibility list and add it again."
        )
        // Re-added: trusted again, nothing to say.
        XCTAssertFalse(trustMemory(build: "1.9.4 (95)", suite: suite).observe(.granted))
        XCTAssertFalse(trustMemory(build: "1.9.4 (95)", suite: suite).observe(.denied))
    }

    func testErrorsAreSentences() {
        XCTAssertEqual(
            ComputerUseError.accessibilityPermissionMissing.errorDescription,
            "macOS has not given Juno Accessibility. Allow it in System Settings › Privacy & Security."
        )
        XCTAssertFalse(ComputerUseError.notActive.errorDescription!.contains("notActive"))
    }
}
