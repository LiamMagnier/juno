import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoScreenControl
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
        XCTAssertEqual(notice?.message, "Juno can use the apps you grant")
        XCTAssertEqual(notice?.message(app: "Safari"), "Juno is using Safari")
        XCTAssertNil(notice?.nextPermission)
    }

    func testTakingOverPausesInWords() {
        let notice = StudioScreenControlNotice(isActive: true, startBlocked: false, permissions: status(.granted, .granted), paused: true)
        XCTAssertEqual(notice, .paused)
        XCTAssertEqual(notice?.message, "You took over. Juno is waiting.")
    }

    func testAGrantVoidedByAnUpdateSaysHowToFixIt() {
        let lost = ComputerUsePermissionStatus(screenRecording: .granted, accessibility: .denied, accessibilityTrustLostAfterUpdate: true)
        let notice = StudioScreenControlNotice(isActive: false, startBlocked: true, permissions: lost)
        XCTAssertEqual(notice, .trustLost)
        XCTAssertEqual(notice?.message, "macOS no longer trusts this build of Juno. Remove Juno from the Accessibility list and add it again.")
        XCTAssertEqual(notice?.nextPermission, .accessibility)
    }

    func testNoStateIsADotOrAPill() {
        // Every state is a sentence (CU-14): no symbol-only status.
        let states: [StudioScreenControlNotice] = [.active, .paused, .needsPermission([.accessibility]), .trustLost, .ready]
        for state in states {
            XCTAssertGreaterThan(state.message.split(separator: " ").count, 3, "\(state)")
        }
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

    // MARK: Step rows

    func testEachScreenCallIsOneStepRowWithTheToolsOwnSentence() {
        let session = CodeSessionID()
        func event(_ payload: SessionEventPayload, _ id: String) -> SessionEvent {
            SessionEvent(id: id, sessionID: session, sequence: 0, timestamp: Date(), payload: payload)
        }
        let events = [
            event(.toolProposed(ToolProposedEvent(toolCallID: "c1", toolName: "computer", input: ["action": "left_click", "app": "com.apple.TextEdit"], risk: .read, summary: "Clicking com.apple.TextEdit")), "e1"),
            event(.toolStarted(ToolStartedEvent(toolCallID: "c1")), "e2"),
            event(.toolCompleted(ToolCompletedEvent(toolCallID: "c1", status: .succeeded, resultSummary: "Clicked the “Save” button in TextEdit.", durationSeconds: 0.4)), "e3"),
            event(.toolProposed(ToolProposedEvent(toolCallID: "c2", toolName: "computer", input: ["action": "type", "text": "hello"], risk: .read, summary: "Type 5 characters")), "e4"),
        ]
        let steps = StudioScreenStep.steps(in: events)
        XCTAssertEqual(steps["e1"]?.eventID, "e1")
        XCTAssertEqual(steps["e3"]?.eventID, "e1", "every event of the call maps to its one row")
        XCTAssertEqual(steps["e1"].map(StudioScreenStepRow.caption(for:)), "Clicked the “Save” button in TextEdit.")
        XCTAssertEqual(steps["e4"].map(StudioScreenStepRow.caption(for:)), "Typing “hello” in the current app…")

        let items = StudioThreadItems.build(events: events, groups: [], pendingApprovalIDs: [], showReasoning: false)
        let rows = items.filter { if case .screenStep = $0 { return true } else { return false } }
        XCTAssertEqual(rows.map(\.id), ["e1", "e4"])
    }

    func testAFailedStepSaysWhyInWords() {
        let step = StudioScreenStep(eventID: "e", toolCallID: "c", verb: "Typed", app: "Terminal", succeeded: false,
                                    outcome: "Terminal is granted for clicks only; typing, keys, right-click and drags were not sent.")
        XCTAssertEqual(StudioScreenStepRow.caption(for: step), "Terminal is granted for clicks only; typing, keys, right-click and drags were not sent.")
    }

    func testTheModelSaysWhoIsUsingWhat() {
        let model = ScreenControlModel()
        let session = CodeSessionID()
        XCTAssertNil(model.sentence)
        model.setPreviewPresence(
            ScreenPresenceState(holder: ScreenControlHolder(id: session.value, kind: .codeSession, title: "t", appName: "Safari")),
            sessionID: session,
            latest: nil
        )
        XCTAssertEqual(model.sentence, "Juno is using Safari")
        model.setPreviewPresence(
            ScreenPresenceState(holder: ScreenControlHolder(id: "other", kind: .codeSession, title: "t", appName: "Safari")),
            sessionID: session,
            latest: nil
        )
        XCTAssertNil(model.sentence, "another session's screen control is not this session's row")
    }
}
