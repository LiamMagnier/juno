import Foundation
import Synchronization
import XCTest
@testable import JunoCore

/// An in-memory disk.
private final class FakeRecoveryFileSystem: JunoRecoveryFileSystem {
    private let files = Mutex<[URL: Data]>([:])
    private let writes = Mutex<[URL: Int]>([:])
    var failsWrites = false

    func contents(of url: URL) -> Data? {
        files.withLock { $0[url] }
    }

    func write(_ data: Data, to url: URL) throws {
        if failsWrites { throw CocoaError(.fileWriteNoPermission) }
        files.withLock { $0[url] = data }
        writes.withLock { $0[url, default: 0] += 1 }
    }

    func remove(_ url: URL) {
        _ = files.withLock { $0.removeValue(forKey: url) }
    }

    func exists(_ url: URL) -> Bool { contents(of: url) != nil }

    func writeCount(_ url: URL) -> Int { writes.withLock { $0[url] ?? 0 } }

    func put(_ text: String, at url: URL) {
        files.withLock { $0[url] = Data(text.utf8) }
    }
}

extension FakeRecoveryFileSystem: @unchecked Sendable {}

/// A clock the test moves by hand.
private final class FakeClock: Sendable {
    private let current = Mutex(Date(timeIntervalSince1970: 1_000_000))

    var now: Date { current.withLock { $0 } }

    func advance(_ seconds: TimeInterval) {
        current.withLock { $0 = $0.addingTimeInterval(seconds) }
    }

    var reader: @Sendable () -> Date { { [self] in now } }
}

final class JunoCrashRecoveryTests: XCTestCase {
    private let location = JunoRecoveryLocation(directory: URL(fileURLWithPath: "/fake/Recovery"))
    private var disk: FakeRecoveryFileSystem!
    private var clock: FakeClock!

    override func setUp() {
        super.setUp()
        disk = FakeRecoveryFileSystem()
        clock = FakeClock()
    }

    override func tearDown() {
        JunoSafeMode.set(active: false)
        super.tearDown()
    }

    private func recovery() -> JunoCrashRecovery {
        JunoCrashRecovery(location: location, fileSystem: disk, now: clock.reader)
    }

    private func recorder() -> JunoSessionSnapshotRecorder {
        JunoSessionSnapshotRecorder(location: location, fileSystem: disk, now: clock.reader)
    }

    // MARK: Sentinel

    func testFirstLaunchIsCleanAndWritesTheSentinel() {
        let result = recovery().beginLaunch(version: "1.13", pid: 42)
        XCTAssertEqual(result.kind, .clean)
        XCTAssertTrue(disk.exists(location.sentinel))
    }

    func testCleanExitRemovesTheSentinelAndTheNextLaunchIsClean() {
        let first = recovery()
        _ = first.beginLaunch(version: "1.13")
        first.endCleanly()
        XCTAssertFalse(disk.exists(location.sentinel))

        clock.advance(30)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .clean)
    }

    func testASentinelLeftBehindMeansAnUncleanExitAndRestoresTheSnapshot() {
        _ = recovery().beginLaunch(version: "1.13", pid: 7)
        recorder().update {
            $0.conversationID = "c1"
            $0.draft = .init(conversationID: "c1", text: "half a thought")
        }
        // kill -9: no endCleanly.
        clock.advance(60)
        let result = recovery().beginLaunch(version: "1.13")

        XCTAssertEqual(result.kind, .recovered)
        XCTAssertEqual(result.previousRun?.pid, 7)
        XCTAssertEqual(result.recentUncleanExits, 1)
        XCTAssertEqual(result.snapshot?.conversationID, "c1")
        XCTAssertEqual(result.snapshot?.draftText(for: "c1"), "half a thought")
        XCTAssertNil(result.snapshot?.draftText(for: nil))
    }

    func testAnUnreadableSentinelStillCountsAsUnclean() {
        disk.put("not json", at: location.sentinel)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .recovered)
    }

    func testAnEmptySnapshotRestoresNothing() {
        _ = recovery().beginLaunch(version: "1.13")
        recorder().update { $0.draft = .init(conversationID: nil, text: "   \n") }
        clock.advance(5)
        let result = recovery().beginLaunch(version: "1.13")
        XCTAssertEqual(result.kind, .recovered)
        XCTAssertNil(result.snapshot)
    }

    // MARK: Crash-loop guard

    func testTwoUncleanExitsWithinTenMinutesStartSafeMode() {
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(120)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .recovered)
        clock.advance(120)
        let third = recovery().beginLaunch(version: "1.13")
        XCTAssertEqual(third.kind, .safeMode)
        XCTAssertEqual(third.recentUncleanExits, 2)
    }

    func testUncleanExitsFurtherApartThanTheWindowDoNotStartSafeMode() {
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(60)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .recovered)
        clock.advance(601)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .recovered)
    }

    func testACleanLaunchBetweenCrashesDoesNotStartSafeModeButKeepsTheCount() {
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(30)
        let second = recovery()
        XCTAssertEqual(second.beginLaunch(version: "1.13").kind, .recovered)
        second.endCleanly()
        clock.advance(30)
        let third = recovery()
        XCTAssertEqual(third.beginLaunch(version: "1.13").kind, .clean)
        // Crashes again soon after: the earlier unclean exit still counts.
        clock.advance(30)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .safeMode)
    }

    func testAStableSessionResetsTheCount() {
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(30)
        let stable = recovery()
        XCTAssertEqual(stable.beginLaunch(version: "1.13").kind, .recovered)
        clock.advance(100)
        XCTAssertFalse(stable.markStable(), "too early to call it stable")
        clock.advance(200)
        XCTAssertTrue(stable.markStable())
        // Dies after the stable mark: one unclean exit, not two.
        clock.advance(10)
        let next = recovery().beginLaunch(version: "1.13")
        XCTAssertEqual(next.kind, .recovered)
        XCTAssertEqual(next.recentUncleanExits, 1)
    }

    func testRestartNormallyClearsTheCount() {
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(30)
        _ = recovery().beginLaunch(version: "1.13")
        clock.advance(30)
        let safe = recovery()
        XCTAssertEqual(safe.beginLaunch(version: "1.13").kind, .safeMode)
        safe.resetCrashLoop()
        safe.endCleanly()
        clock.advance(5)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .clean)
    }

    // MARK: iOS scene lifecycle

    func testAnAppEndedInTheBackgroundIsNotUnclean() {
        let phone = recovery()
        _ = phone.beginLaunch(version: "1.13")
        phone.didEnterBackground()
        // The system ends the suspended app; no endCleanly.
        clock.advance(3_600)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .clean)
    }

    func testAnAppThatCameBackToTheForegroundAndDiedIsUnclean() {
        let phone = recovery()
        _ = phone.beginLaunch(version: "1.13")
        phone.didEnterBackground()
        clock.advance(60)
        phone.willEnterForeground()
        clock.advance(60)
        XCTAssertEqual(recovery().beginLaunch(version: "1.13").kind, .recovered)
    }

    func testPlantedSentinelStandsInForAKill() {
        let planted = recovery()
        planted.plantSentinel(version: "1.13")
        XCTAssertEqual(planted.beginLaunch(version: "1.13").kind, .recovered)
    }

    // MARK: Snapshot recorder

    func testNavigationWritesAtOnceAndDraftsAreThrottled() {
        let recorder = recorder()
        XCTAssertTrue(recorder.update { $0.conversationID = "c1" })
        XCTAssertEqual(disk.writeCount(location.snapshot), 1)

        clock.advance(1)
        XCTAssertFalse(recorder.update { $0.draft = .init(conversationID: "c1", text: "h") })
        XCTAssertTrue(recorder.isDirty)
        clock.advance(1)
        XCTAssertFalse(recorder.update { $0.draft = .init(conversationID: "c1", text: "he") })
        XCTAssertEqual(disk.writeCount(location.snapshot), 1)

        clock.advance(2)
        XCTAssertTrue(recorder.update { $0.draft = .init(conversationID: "c1", text: "hel") })
        XCTAssertFalse(recorder.isDirty)

        clock.advance(0.5)
        recorder.update { $0.draft = .init(conversationID: "c1", text: "hello") }
        XCTAssertTrue(recorder.flushIfDirty())
        XCTAssertFalse(recorder.flushIfDirty(), "nothing left to write")
        XCTAssertEqual(disk.writeCount(location.snapshot), 3)

        // A switch to Code is a navigation: written however soon it comes.
        clock.advance(0.1)
        XCTAssertTrue(recorder.update { $0.product = .code; $0.codeSessionID = "s1" })
    }

    func testAnUnchangedStateIsNotRewritten() {
        let recorder = recorder()
        recorder.update { $0.conversationID = "c1" }
        clock.advance(60)
        XCTAssertFalse(recorder.update { $0.conversationID = "c1" })
        XCTAssertEqual(disk.writeCount(location.snapshot), 1)
    }

    func testAFailedWriteStaysDirty() {
        let recorder = recorder()
        disk.failsWrites = true
        XCTAssertFalse(recorder.update { $0.conversationID = "c1" })
        XCTAssertTrue(recorder.isDirty)
        disk.failsWrites = false
        XCTAssertTrue(recorder.flushIfDirty())
    }

    func testASeededRecorderKeepsTheRestoredDraftWhenTheRestoreLands() {
        let restored = JunoSessionSnapshot(
            conversationID: "c1",
            draft: .init(conversationID: "c1", text: "kept")
        )
        let recorder = recorder()
        recorder.seed(restored)
        XCTAssertFalse(recorder.isDirty, "the seed is what is on disk")
        // The window lands on the restored conversation: nothing changed.
        XCTAssertFalse(recorder.update { $0.conversationID = "c1" })
        // Moving to another conversation drops the old draft from the next write.
        XCTAssertTrue(recorder.update { $0.conversationID = "c2"; $0.draft = nil })
        XCTAssertNil(recorder.current.draft)
    }

    func testADisabledRecorderWritesNothing() {
        let recorder = recorder()
        recorder.isEnabled = false
        recorder.update { $0.conversationID = "c1" }
        XCTAssertFalse(disk.exists(location.snapshot))
    }

    func testLongDraftsAreCutNotDropped() {
        let draft = JunoSessionSnapshot.Draft(
            conversationID: nil,
            text: String(repeating: "a", count: JunoSessionSnapshot.draftLimit + 50)
        )
        XCTAssertEqual(draft.text.count, JunoSessionSnapshot.draftLimit)
    }

    func testASnapshotFromAnotherVersionIsIgnored() {
        _ = recovery().beginLaunch(version: "1.13")
        disk.put(#"{"version":99,"savedAt":0,"product":"chat","conversationID":"c1"}"#, at: location.snapshot)
        clock.advance(5)
        XCTAssertNil(recovery().beginLaunch(version: "1.13").snapshot)
    }

    // MARK: Safe mode

    func testSafeModeTurnsEveryOptionalSubsystemOffAndBackOn() {
        XCTAssertFalse(JunoSafeMode.isActive)
        XCTAssertTrue(JunoSafeMode.allows(.computerUse))
        JunoSafeMode.set(active: true)
        XCTAssertTrue(JunoSafeMode.isActive)
        for subsystem: JunoSafeModeSubsystems in [
            .computerUse, .extensions, .quickEntryHotkey, .backgroundAgents, .customMotion,
        ] {
            XCTAssertFalse(JunoSafeMode.allows(subsystem))
        }
        JunoSafeMode.set(active: false)
        XCTAssertTrue(JunoSafeMode.allows(.quickEntryHotkey))
    }
}
