import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

private struct FakeDriver: ComputerUseDriving {
    var screenPermission: ComputerUsePermissionState = .granted
    var axPermission: ComputerUsePermissionState = .granted
    var bounds = CGRect(x: 0, y: 0, width: 1_000, height: 800)
    var failsActions = false

    func screenCapturePermission() -> ComputerUsePermissionState { screenPermission }
    func accessibilityPermission() -> ComputerUsePermissionState { axPermission }
    func displayBounds() async throws -> CGRect { bounds }
    func captureScreen() async throws -> Data { Data([0x89, 0x50]) }
    func perform(_ action: ComputerUseActionKind) async throws {
        if failsActions {
            throw ComputerUseError.driverUnavailable(reason: "test")
        }
    }
}

final class ComputerUseCoordinatorTests: XCTestCase {
    private let sessionID = CodeSessionID()

    func testActivationRequiresExplicitConsent() async {
        let coordinator = ComputerUseCoordinator(driver: FakeDriver())
        do {
            try await coordinator.activate(sessionID: sessionID, userConsented: false)
            XCTFail("expected consent failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .consentRequired)
        } catch {
            XCTFail("unexpected \(error)")
        }
        let state = await coordinator.currentState
        XCTAssertEqual(state, .idle)
    }

    func testActivationRequiresBothPermissions() async {
        var driver = FakeDriver()
        driver.screenPermission = .denied
        let noScreen = ComputerUseCoordinator(driver: driver)
        do {
            try await noScreen.activate(sessionID: sessionID, userConsented: true)
            XCTFail("expected screen permission failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .screenCapturePermissionMissing)
        } catch {
            XCTFail("unexpected \(error)")
        }

        var axDriver = FakeDriver()
        axDriver.axPermission = .notDetermined
        let noAX = ComputerUseCoordinator(driver: axDriver)
        do {
            try await noAX.activate(sessionID: sessionID, userConsented: true)
            XCTFail("expected accessibility failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .accessibilityPermissionMissing)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testActionsRequireActiveStateAndMatchingSession() async throws {
        let coordinator = ComputerUseCoordinator(driver: FakeDriver())
        do {
            _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
            XCTFail("expected notActive")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .notActive)
        }
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        do {
            _ = try await coordinator.perform(.screenshot, sessionID: CodeSessionID())
            XCTFail("expected session mismatch")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .activeForAnotherSession)
        }
    }

    func testRateLimitBetweenActions() async throws {
        nonisolated(unsafe) var currentTime = Date(timeIntervalSince1970: 1_000)
        let coordinator = ComputerUseCoordinator(
            driver: FakeDriver(),
            now: { currentTime }
        )
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
        do {
            _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
            XCTFail("expected rate limit")
        } catch let error as ComputerUseError {
            guard case .rateLimited = error else {
                return XCTFail("unexpected \(error)")
            }
        }
        currentTime = currentTime.addingTimeInterval(1)
        _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
    }

    func testCoordinateValidation() async throws {
        let coordinator = ComputerUseCoordinator(driver: FakeDriver())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        do {
            _ = try await coordinator.perform(
                .click(x: 5_000, y: 100),
                sessionID: sessionID
            )
            XCTFail("expected bounds failure")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .coordinatesOutOfBounds)
        }
    }

    func testJournalRecordsSuccessAndFailure() async throws {
        nonisolated(unsafe) var currentTime = Date(timeIntervalSince1970: 0)
        var driver = FakeDriver()
        driver.failsActions = true
        let coordinator = ComputerUseCoordinator(driver: driver, now: { currentTime })
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
        currentTime = currentTime.addingTimeInterval(2)
        do {
            _ = try await coordinator.perform(.click(x: 10, y: 10), sessionID: sessionID)
            XCTFail("expected driver failure")
        } catch {}
        let journal = await coordinator.actionJournal
        XCTAssertEqual(journal.count, 2)
        XCTAssertTrue(journal[0].succeeded)
        XCTAssertFalse(journal[1].succeeded)
    }

    func testEmergencyStopDeactivatesImmediately() async throws {
        let coordinator = ComputerUseCoordinator(driver: FakeDriver())
        try await coordinator.activate(sessionID: sessionID, userConsented: true)
        await coordinator.emergencyStop()
        let state = await coordinator.currentState
        XCTAssertEqual(state, .idle)
        do {
            _ = try await coordinator.perform(.screenshot, sessionID: sessionID)
            XCTFail("expected notActive after kill switch")
        } catch let error as ComputerUseError {
            XCTAssertEqual(error, .notActive)
        }
    }

    func testSystemDriverFailsClosedWithoutImplementation() async {
        let driver = SystemComputerUseDriver()
        do {
            _ = try await driver.captureScreen()
            XCTFail("expected unavailable")
        } catch let error as ComputerUseError {
            guard case .driverUnavailable = error else {
                return XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}
