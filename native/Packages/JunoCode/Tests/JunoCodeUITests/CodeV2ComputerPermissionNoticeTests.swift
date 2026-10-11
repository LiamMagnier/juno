import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// The notice a connected agent's refused computer-use call puts above its
/// thread's composer: the grant, the page, the stale-switch fix, and a live
/// turn to "ready" with no relaunch.
@MainActor
final class CodeV2ComputerPermissionNoticeTests: XCTestCase {
    func testAccessibilityMissingNamesThePageAndTheFix() throws {
        let content = CodeV2ComputerPermissionNoticeContent(
            status: .init(screenRecording: .granted, accessibility: .denied), macOSMajor: 27
        )
        XCTAssertEqual(content.title, "Alevr needs Accessibility to use apps")
        XCTAssertEqual(content.openPermission, .accessibility)
        let steps = try XCTUnwrap(content.steps)
        XCTAssertTrue(steps.hasPrefix("Open Settings goes to System Settings › Privacy & Security › Device Control and Data Access."), steps)
        XCTAssertTrue(steps.contains(ComputerUsePermissionStatus.staleGrantSteps))
        XCTAssertTrue(steps.contains("does not need to reopen"))
        XCTAssertFalse(steps.contains("—"))
    }

    func testScreenRecordingFirstAndItMayNeedAReopen() {
        let content = CodeV2ComputerPermissionNoticeContent(
            status: .init(screenRecording: .denied, accessibility: .denied), macOSMajor: 26
        )
        XCTAssertEqual(content.title, "Alevr needs Screen Recording and Accessibility to use apps")
        XCTAssertEqual(content.openPermission, .screenRecording)
        XCTAssertTrue(content.steps?.contains("quit and reopen") == true)
        XCTAssertTrue(content.steps?.contains("Then do the same in System Settings › Privacy & Security › Accessibility.") == true)
    }

    func testOnceGrantedItSaysReadyAndOffersNoSettings() {
        let content = CodeV2ComputerPermissionNoticeContent(status: .init(screenRecording: .granted, accessibility: .granted))
        XCTAssertEqual(content.title, "Computer use is ready. Ask the agent to try again.")
        XCTAssertNil(content.openPermission)
        XCTAssertNil(content.steps)
    }

    func testTheNoticeBelongsToTheThreadWhoseCallWasRefused() {
        let approvals = CodeV2ConnectedApprovals()
        approvals.showPermissionNotice(.init(screenRecording: .granted, accessibility: .denied), sessionID: "s1")
        XCTAssertNotNil(approvals.permissionNotice(forSession: "s1"))
        XCTAssertNil(approvals.permissionNotice(forSession: "s2"))
        approvals.dismissPermissionNotice()
        XCTAssertNil(approvals.permissionNotice(forSession: "s1"))
    }

    func testTheBridgeApproverRaisesTheSharedNotice() async {
        CodeV2ConnectedApprovals.shared.dismissPermissionNotice()
        await StudioComputerBridgeApprover { _, _, _ in .decline }
            .permissionsMissing(.init(screenRecording: .granted, accessibility: .denied), sessionID: "thread-9")
        XCTAssertEqual(CodeV2ConnectedApprovals.shared.permissionNotice(forSession: "thread-9")?.status.missing, [.accessibility])
        CodeV2ConnectedApprovals.shared.dismissPermissionNotice()
    }
}
