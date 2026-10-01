import XCTest
import JunoCodeCore
import JunoScreenControl
@testable import JunoCodeLocal

/// The Code adapter onto the app-wide service: consent, the shared lock and
/// stop, and the snapshot the window reads. Nothing here captures the screen.
final class ComputerUseCoordinatorTests: XCTestCase {
    private let sessionID = CodeSessionID()

    func testActivationRequiresExplicitConsent() async {
        let coordinator = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions())
        do {
            try await coordinator.activate(sessionID: sessionID, userConsented: false)
            XCTFail("expected consent failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .consentRequired)
        } catch {
            XCTFail("unexpected \(error)")
        }
        let active = await coordinator.isActive(sessionID: sessionID)
        XCTAssertFalse(active)
    }

    func testActivationRequiresBothPermissions() async {
        let noScreen = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions(screen: .denied))
        do {
            try await noScreen.activate(sessionID: sessionID, userConsented: true)
            XCTFail("expected screen permission failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .screenCapturePermissionMissing)
            XCTAssertEqual(error.missingPermission, .screenRecording)
        } catch {
            XCTFail("unexpected \(error)")
        }
        let noAX = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions(accessibility: .notDetermined))
        do {
            try await noAX.activate(sessionID: sessionID, userConsented: true)
            XCTFail("expected accessibility failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .accessibilityPermissionMissing)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// Two workspaces have two coordinators and one service: one lock.
    func testASecondWorkspaceIsRefusedNamingTheFirst() async throws {
        let service = makeTestScreenService()
        let first = ComputerUseCoordinator(service: service, permissions: FakePermissions())
        let second = ComputerUseCoordinator(service: service, permissions: FakePermissions())
        try await first.activate(sessionID: sessionID, userConsented: true, title: "Fix the export sheet")
        do {
            try await second.activate(sessionID: CodeSessionID(), userConsented: true, title: "Other")
            XCTFail("two sessions held the screen")
        } catch let error as ComputerUseError {
            guard case let .heldElsewhere(sentence) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(sentence.contains("Fix the export sheet"))
            XCTAssertTrue(error.errorDescription!.hasSuffix("Stop it there first."))
        }
    }

    /// A deny saved in Settings holds after a relaunch: the service starts
    /// empty, and the coordinator hands it the saved narrowing at every start.
    func testTheSavedNarrowingIsAppliedWhenScreenControlStarts() async throws {
        let service = makeTestScreenService()
        let coordinator = ComputerUseCoordinator(
            service: service,
            permissions: FakePermissions(),
            preferences: { ScreenControlPreferences(denied: ["com.apple.textedit"]) }
        )
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        let proposal = try await coordinator.proposeGrants(
            sessionID: sessionID.value, apps: ["TextEdit"], reason: nil, clipboardRead: false, clipboardWrite: false
        )
        XCTAssertFalse(proposal.hasOffer)
        XCTAssertEqual(proposal.offers.first?.outcome, .refused("you denied it in Settings"))
    }

    func testEmergencyStopEndsEverySession() async throws {
        let service = makeTestScreenService()
        let coordinator = ComputerUseCoordinator(service: service, permissions: FakePermissions())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        await coordinator.emergencyStop()
        let active = await coordinator.isActive(sessionID: sessionID)
        XCTAssertFalse(active)
        let state = await coordinator.state(sessionID: sessionID.value)
        XCTAssertEqual(state, .stopped(.stopButton))
        // Anyone may start again after a stop, with the reader's Start.
        try await coordinator.activate(sessionID: CodeSessionID(), userConsented: true)
    }

    func testScopedDeactivationCannotStopAnotherSession() async throws {
        let coordinator = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        await coordinator.deactivate(sessionID: CodeSessionID())
        let active = await coordinator.isActive(sessionID: sessionID)
        XCTAssertTrue(active)
        await coordinator.deactivate(sessionID: sessionID)
        let after = await coordinator.isActive(sessionID: sessionID)
        XCTAssertFalse(after)
    }

    func testSnapshotNeverPromptsAndReflectsTheHolder() async throws {
        let permissions = FakePermissions(screen: .granted, accessibility: .denied)
        let coordinator = ComputerUseCoordinator(service: makeTestScreenService(), permissions: permissions)
        let snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.permissions.missing, [.accessibility])
        XCTAssertFalse(snapshot.isActive)
        XCTAssertEqual(permissions.requests, 0, "reading state never prompts")
    }

    func testTheLatestCaptureFollowsTheAgentAndEndsWithTheGrant() async throws {
        let service = makeTestScreenService()
        let coordinator = ComputerUseCoordinator(service: service, permissions: FakePermissions())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        let none = await coordinator.snapshot().latestCapture
        XCTAssertNil(none)
        let proposal = try await coordinator.proposeGrants(
            sessionID: sessionID.value, apps: ["TextEdit"], reason: nil, clipboardRead: false, clipboardWrite: false
        )
        _ = try await coordinator.applyGrants(sessionID: sessionID.value, proposalID: proposal.id)
        let prepared = try await coordinator.prepare(sessionID: sessionID.value, action: ScreenAction(kind: .screenshot))
        _ = try await coordinator.perform(sessionID: sessionID.value, prepared: prepared, toolCallID: "c", attachFrame: true)
        let snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.activeSessionID, sessionID)
        XCTAssertEqual(snapshot.latestCapture?.appName, "TextEdit")
        XCTAssertFalse(snapshot.latestCapture?.imageData.isEmpty ?? true)
        await coordinator.emergencyStop()
        let gone = await coordinator.snapshot().latestCapture
        XCTAssertNil(gone, "a frame never outlives the grant that took it")
    }

    func testModelChangeLapsesGrantsButKeepsScreenControlOn() async throws {
        let coordinator = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        let proposal = try await coordinator.proposeGrants(
            sessionID: sessionID.value, apps: ["TextEdit"], reason: nil, clipboardRead: false, clipboardWrite: false
        )
        _ = try await coordinator.applyGrants(sessionID: sessionID.value, proposalID: proposal.id)
        await coordinator.revokeGrants(sessionID: sessionID)
        let grants = await coordinator.grants(sessionID: sessionID.value)
        XCTAssertTrue(grants.isEmpty)
        let active = await coordinator.isActive(sessionID: sessionID)
        XCTAssertTrue(active)
    }

    func testTheJournalRecordsSteps() async throws {
        let coordinator = ComputerUseCoordinator(service: makeTestScreenService(), permissions: FakePermissions())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        let proposal = try await coordinator.proposeGrants(
            sessionID: sessionID.value, apps: ["TextEdit"], reason: nil, clipboardRead: false, clipboardWrite: false
        )
        _ = try await coordinator.applyGrants(sessionID: sessionID.value, proposalID: proposal.id)
        // Let the journal subscribe before the step.
        try await Task.sleep(for: .milliseconds(50))
        let prepared = try await coordinator.prepare(sessionID: sessionID.value, action: ScreenAction(kind: .screenshot))
        _ = try await coordinator.perform(sessionID: sessionID.value, prepared: prepared, toolCallID: "c", attachFrame: true)
        for _ in 0..<100 {
            if await !coordinator.actionJournal.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let journal = await coordinator.actionJournal
        XCTAssertEqual(journal.last?.summary, "Screenshot of TextEdit.")
        XCTAssertEqual(journal.last?.succeeded, true)
    }
}
