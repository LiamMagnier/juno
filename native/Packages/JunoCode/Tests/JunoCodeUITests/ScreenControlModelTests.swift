import CoreGraphics
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoScreenControl
@testable import JunoCodeUI

/// The session's screen model against the real service with inert fakes:
/// the reader's grant-sheet choices and a stop reach the service and the
/// permission coordinator in the order the reader made them.
@MainActor
final class ScreenControlModelTests: XCTestCase {
    private func makeService() -> ScreenControlService {
        ScreenControlService(dependencies: .init(
            capture: InertCapture(),
            environment: InertEnvironment(),
            accessibility: InertAccessibility(),
            sink: RecordingEventSink(),
            pause: { _ in await Task.yield() },
            settleTimeout: 0.05,
            settleInterval: .milliseconds(1),
            minimumInputGap: 0
        ))
    }

    private func makeStore() throws -> CodeSessionStore {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-screen-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return CodeSessionStore(directoryURL: base.appendingPathComponent("sessions"))
    }

    func testAnAppUntickedJustBeforeAllowIsNotGranted() async throws {
        let service = makeService()
        let coordinator = ComputerUseCoordinator(service: service, permissions: AllGranted())
        let session = CodeSessionID()
        try await coordinator.activate(sessionID: session, userConsented: true, title: "Fill the form")
        let model = ScreenControlModel()
        model.bind(sessionID: session, coordinator: coordinator, store: try makeStore())
        let proposal = try await coordinator.proposeGrants(
            sessionID: session.value, apps: ["TextEdit", "Mail"], reason: nil, clipboardRead: false, clipboardWrite: false
        )
        var offers = proposal.offers
        offers[1].include = false
        // The untick and Allow, back to back, as a quick reader does them.
        model.updateGrantChoices(proposalID: proposal.id, offers: offers)
        await model.settleGrantChoices()
        let granted = try await coordinator.applyGrants(sessionID: session.value, proposalID: proposal.id)
        XCTAssertEqual(granted.map(\.displayName), ["TextEdit"], "Mail was unticked before Allow")
        model.unbind()
    }

    func testAScreenCardStillWaitingIsAnsweredNoWhenScreenControlStops() async throws {
        let service = makeService()
        let coordinator = ComputerUseCoordinator(service: service, permissions: AllGranted())
        let session = CodeSessionID()
        let permissions = PermissionCoordinator(sessionID: session, mode: .askBeforeChanges)
        let model = ScreenControlModel()
        model.bind(sessionID: session, coordinator: coordinator, store: try makeStore(), permissions: permissions)
        try await coordinator.activate(sessionID: session, userConsented: true, title: "Fill the form")
        try await waitFor { model.isThisSessionActive }
        let answer = Task {
            await permissions.authorize(
                toolName: ComputerUseToolName.computer, actionDigest: "d", risk: .critical, summary: "Click", subject: nil
            )
        }
        try await waitFor { await !permissions.pendingApprovals.isEmpty }
        await coordinator.emergencyStop()
        let outcome = await answer.value
        XCTAssertEqual(outcome, .denied(reason: "The user declined this action."))
        model.unbind()
    }

    private func waitFor(_ condition: @escaping @MainActor () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out")
    }
}

private struct AllGranted: ComputerUsePermissionChecking {
    func screenCapturePermission() -> ComputerUsePermissionState { .granted }
    func accessibilityPermission() -> ComputerUsePermissionState { .granted }
}

private struct InertCapture: ScreenCapturing {
    func capture(window: WindowInfo) async throws -> CapturedImage {
        throw ScreenControlError.windowGone(app: window.appName)
    }

    func capture(display: DisplayInfo, excluding _: OwnProcess) async throws -> CapturedImage {
        throw ScreenControlError.driverFailed("no display in tests")
    }
}

private struct InertEnvironment: ScreenEnvironment {
    let ownProcess = OwnProcess(pid: 999, bundleID: "com.liammagnier.JunoDesktop.debug")
    func runningApps() async -> [RunningApp] {
        [RunningApp(pid: 101, bundleID: "com.apple.TextEdit", name: "TextEdit"), RunningApp(pid: 104, bundleID: "com.apple.mail", name: "Mail")]
    }
    func installedApps() async -> [InstalledApp] { [] }
    func frontmostApp() async -> RunningApp? { nil }
    func windows(pid _: Int32) async -> [WindowInfo] { [] }
    func displays() async -> [DisplayInfo] { [] }
    func open(bundleID: String) async throws -> RunningApp { throw ScreenControlError.invalidInput(bundleID) }
}

private struct InertAccessibility: AccessibilityInspecting {
    func target(at _: ScreenPoint, within _: Int32?) async -> ScreenTarget? { nil }
    func focusedTarget(pid _: Int32) async -> ScreenTarget? { nil }
    func snapshot(pid _: Int32, maxDepth _: Int) async throws -> AXSnapshot { throw ScreenControlError.unsupported("none") }
    func press(at _: ScreenPoint?, elementID _: String?, pid _: Int32) async throws -> Bool { false }
    func showMenu(at _: ScreenPoint?, elementID _: String?, pid _: Int32) async throws -> Bool { false }
    func setText(_: String, elementID _: String?, pid _: Int32, replace _: Bool) async throws -> Bool { false }
    func value(elementID _: String?, pid _: Int32) async -> String? { nil }
    func pressMenu(pid _: Int32, path _: [String]) async throws -> [String] { [] }
}
