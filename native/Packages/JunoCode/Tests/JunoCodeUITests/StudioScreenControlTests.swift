import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

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

/// What the session banner and the settings page say about screen control,
/// given the coordinator's state and the grants macOS reports.
@MainActor
final class StudioScreenControlTests: XCTestCase {
    private func status(
        _ screen: ComputerUsePermissionState,
        _ accessibility: ComputerUsePermissionState
    ) -> ComputerUsePermissionStatus {
        ComputerUsePermissionStatus(screenRecording: screen, accessibility: accessibility)
    }

    func testNothingShowsUntilScreenControlRunsOrAStartIsRefused() {
        XCTAssertNil(
            StudioScreenControlNotice(isActive: false, startBlocked: false, permissions: status(.denied, .denied)),
            "missing grants alone are not a reason to interrupt a session"
        )
        XCTAssertNil(
            StudioScreenControlNotice(isActive: false, startBlocked: false, permissions: status(.granted, .granted))
        )
    }

    func testRunningAlwaysShowsTheStop() {
        // The stop outranks everything else the banner could say.
        let notice = StudioScreenControlNotice(
            isActive: true,
            startBlocked: true,
            permissions: status(.denied, .denied)
        )
        XCTAssertEqual(notice, .active)
        XCTAssertEqual(notice?.message, "Juno is controlling the screen")
        XCTAssertNil(notice?.nextPermission)
    }

    func testARefusedStartNamesEveryMissingGrantAndOpensTheFirst() {
        let notice = StudioScreenControlNotice(
            isActive: false,
            startBlocked: true,
            permissions: status(.denied, .denied)
        )
        XCTAssertEqual(notice, .needsPermission([.screenRecording, .accessibility]))
        XCTAssertEqual(notice?.message, "Screen control needs Screen Recording and Accessibility")
        XCTAssertEqual(notice?.nextPermission, .screenRecording)
    }

    func testTheNoticeMovesOnAsGrantsAreMade() {
        // What a reader sees coming back from System Settings, one grant at
        // a time, read through the same probe the settings page uses.
        let screen = GrantSwitch(.denied)
        let accessibility = GrantSwitch(.notDetermined)
        let probe = ComputerUsePermissionProbe(
            screenRecording: { screen.value },
            accessibility: { accessibility.value }
        )
        func notice() -> StudioScreenControlNotice? {
            StudioScreenControlNotice(isActive: false, startBlocked: true, permissions: probe.read())
        }

        XCTAssertEqual(notice(), .needsPermission([.screenRecording, .accessibility]))

        screen.value = .granted
        XCTAssertEqual(notice(), .needsPermission([.accessibility]))
        XCTAssertEqual(notice()?.message, "Screen control needs Accessibility")
        XCTAssertEqual(notice()?.nextPermission, .accessibility)

        accessibility.value = .granted
        XCTAssertEqual(notice(), .ready)
        XCTAssertEqual(notice()?.message, "Screen control is ready to start")
        XCTAssertNil(notice()?.nextPermission, "Start is offered, never taken")
    }

    func testAWaitingStartLapsesWhenTheSessionCanNoLongerUseScreenControl() {
        // Switched to Plan, or to a model that cannot see: a Start offered
        // then could only fail. A running grant still shows its stop.
        XCTAssertNil(
            StudioScreenControlNotice(
                isActive: false,
                startBlocked: true,
                isAvailable: false,
                permissions: status(.granted, .granted)
            )
        )
        XCTAssertEqual(
            StudioScreenControlNotice(
                isActive: true,
                startBlocked: false,
                isAvailable: false,
                permissions: status(.granted, .granted)
            ),
            .active
        )
    }

    func testStateLabelsNeverGuessWhyAGrantIsMissing() {
        XCTAssertEqual(ComputerUsePermissionState.granted.studioLabel, "Allowed")
        XCTAssertEqual(ComputerUsePermissionState.denied.studioLabel, "Not allowed")
        XCTAssertEqual(ComputerUsePermissionState.notDetermined.studioLabel, "Not requested")
    }

    func testPermissionNamesAndPanes() {
        XCTAssertEqual(StudioScreenControlText.list([.screenRecording]), "Screen Recording")
        XCTAssertEqual(StudioScreenControlText.list([.accessibility]), "Accessibility")
        XCTAssertEqual(
            StudioScreenControlText.list([.screenRecording, .accessibility]),
            "Screen Recording and Accessibility"
        )
        XCTAssertEqual(
            ComputerUsePermission.screenRecording.studioOpenHelp,
            "Opens System Settings › Privacy & Security › Screen & System Audio Recording"
        )
    }

    func testStartInAPreviewSessionExplainsInsteadOfBlocking() async {
        // A preview controller has no coordinator, so this exercises the whole
        // start path with no chance of a TCC prompt.
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        await controller.startComputerUse()
        XCTAssertFalse(controller.computerUseActive)
        XCTAssertFalse(controller.computerUseStartBlocked)
        XCTAssertFalse(controller.session.configuration.computerUseEnabled)
        XCTAssertEqual(controller.transientError, controller.computerUseUnavailableReason)
        XCTAssertNil(controller.computerUseLatestCapture)
    }
}
