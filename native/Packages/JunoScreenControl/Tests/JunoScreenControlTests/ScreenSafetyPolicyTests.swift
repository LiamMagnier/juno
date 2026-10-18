import Foundation
import XCTest
@testable import JunoScreenControl

// The REA "Baton" safety items (docs/rea/designs/computer-use.md §3.1, §4):
// granted-only take-over frames with a "whole display" tick, the lock policy
// (pause, notify, display awake, never unlock) and unattended-run rules.

/// A lock the test flips, with the live read and the notification stream.
final class FakeSessionLock: ScreenSessionLockMonitoring, @unchecked Sendable {
    private let lock = NSLock()
    private var locked = false
    private var continuation: AsyncStream<Bool>.Continuation?

    func isLocked() async -> Bool { lock.withLock { locked } }

    func changes() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            lock.withLock { self.continuation = continuation }
        }
    }

    /// Changes the live state without a notification, as when the lock
    /// lands before its notification arrives.
    func setSilently(_ value: Bool) { lock.withLock { locked = value } }

    func set(_ value: Bool) {
        let continuation = lock.withLock { () -> AsyncStream<Bool>.Continuation? in
            locked = value
            return self.continuation
        }
        continuation?.yield(value)
    }
}

/// Counts holds and releases of the display assertion.
final class FakeDisplayAwake: DisplayAwakeAsserting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var holds = 0
    private(set) var releases = 0
    private(set) var held = false

    func hold(reason _: String) {
        lock.withLock {
            holds += 1
            held = true
        }
    }

    func release() {
        lock.withLock {
            releases += 1
            held = false
        }
    }

    var isHeld: Bool { lock.withLock { held } }
}

/// An idle timer the test fires by hand: nothing sleeps, nothing is cancelled.
final class ManualIdleTimer: IdleTimerScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [(seconds: TimeInterval, fire: @Sendable () async -> Void)] = []

    func schedule(after seconds: TimeInterval, _ fire: @escaping @Sendable () async -> Void) {
        lock.withLock { pending.append((seconds, fire)) }
    }

    var waiting: [TimeInterval] { lock.withLock { pending.map(\.seconds) } }

    /// Runs every wake scheduled so far (the ones they schedule wait for the next call).
    func fire() async {
        let due = lock.withLock { () -> [(seconds: TimeInterval, fire: @Sendable () async -> Void)] in
            defer { pending = [] }
            return pending
        }
        for entry in due { await entry.fire() }
    }
}

final class GrantedOnlyFrameTests: XCTestCase {
    private func screenshot(_ fixture: ScreenFixture) async throws {
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
        _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: nil, attachFrame: true)
    }

    private func withNotesAndOnePassword() -> ScreenFixture {
        let fixture = ScreenFixture()
        fixture.environment.apps += [
            RunningApp(pid: 201, bundleID: "com.1password.1password", name: "1Password"),
            RunningApp(pid: 203, bundleID: "com.apple.Notes", name: "Notes"),
        ]
        return fixture
    }

    func testATakeoverFrameShowsOnlyGrantedAppsByDefault() async throws {
        let fixture = withNotesAndOnePassword()
        try await fixture.start(grant: ["com.apple.TextEdit"])
        _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        try await screenshot(fixture)

        XCTAssertEqual(fixture.capture.includedApps.last, ["com.apple.textedit"], "only TextEdit's windows are composited")
        XCTAssertTrue(fixture.capture.excludedApps.isEmpty, "the exclude-list capture is not used without the tick")
        XCTAssertEqual(fixture.capture.excludedOwn.last?.pid, 999, "Juno is still left out")
    }

    func testATakeoverWithoutACardIsGrantedOnlyToo() async throws {
        let fixture = withNotesAndOnePassword()
        try await fixture.start(grant: ["com.apple.TextEdit"])
        // No card was opened, so there is no tick to read.
        await fixture.service.setTakeoverScope(sessionID: "s1", wholeDisplay: true)
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        try await screenshot(fixture)
        XCTAssertEqual(fixture.capture.includedApps.last, ["com.apple.textedit"])
    }

    func testTheWholeDisplayTickWidensTheFrameButNeverToRefusedApps() async throws {
        let fixture = withNotesAndOnePassword()
        try await fixture.start(grant: ["com.apple.TextEdit"])
        _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
        await fixture.service.setTakeoverScope(sessionID: "s1", wholeDisplay: true)
        let sentence = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        try await screenshot(fixture)

        XCTAssertTrue(fixture.capture.includedApps.isEmpty)
        let excluded = try XCTUnwrap(fixture.capture.excludedApps.last)
        XCTAssertTrue(excluded.contains("com.1password.1password"), "a password manager stays out of a whole-display frame")
        XCTAssertFalse(excluded.contains("com.apple.notes"), "Notes is visible with the tick")
        XCTAssertTrue(sentence.contains("whole display"), sentence)
    }

    func testTheTickLastsOneTakeover() async throws {
        let fixture = withNotesAndOnePassword()
        try await fixture.start(grant: ["com.apple.TextEdit"])
        _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
        await fixture.service.setTakeoverScope(sessionID: "s1", wholeDisplay: true)
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        _ = await fixture.service.endTakeover(sessionID: "s1")
        _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        try await screenshot(fixture)
        XCTAssertEqual(fixture.capture.includedApps.last, ["com.apple.textedit"], "a new card starts unticked")
    }

    func testDeniedAndRefusedGrantsAreNotInTheIncludeList() async throws {
        let fixture = withNotesAndOnePassword()
        try await fixture.start(grant: ["com.apple.TextEdit", "com.apple.Notes"])
        await fixture.service.setPreferences(ScreenControlPreferences(denied: ["com.apple.notes"]))
        _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        try await screenshot(fixture)
        XCTAssertEqual(fixture.capture.includedApps.last, ["com.apple.textedit"], "an app denied in Settings drops out of the frame")
    }

    func testACapturerThatCannotFilterGivesNoFrame() async throws {
        struct Unfiltered: ScreenCapturing {
            func capture(window _: WindowInfo) async throws -> CapturedImage { throw ScreenControlError.noFrameYet }
            func capture(display: DisplayInfo, excluding _: OwnProcess) async throws -> CapturedImage {
                CapturedImage(image: makeImage(width: 8, height: 8), origin: ScreenPoint(x: 0, y: 0), pointWidth: 4, pointHeight: 4, backingScale: 2, displayID: display.id)
            }
        }
        do {
            _ = try await Unfiltered().capture(
                display: DisplayInfo(id: 1, name: "d", frame: ScreenRect(x: 0, y: 0, width: 4, height: 4), backingScale: 2, isMain: true),
                excluding: OwnProcess(pid: 1, bundleID: "x"), showingOnly: ["com.apple.textedit"]
            )
            XCTFail("a whole-display frame stood in for a granted-only one")
        } catch let error as ScreenControlError {
            XCTAssertTrue(error.errorDescription!.contains("granted apps"))
        }
    }
}

final class ScreenLockPolicyTests: XCTestCase {
    private func waitUntil(_ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<20_000 {
            if await condition() { return }
            await Task.yield()
        }
        XCTFail("timed out", file: file, line: line)
    }

    func testALockPausesTheRunAndNotifiesWithoutPostingInput() async throws {
        let lock = FakeSessionLock()
        let fixture = ScreenFixture(sessionLock: lock)
        let notices = await fixture.service.lockNotices()
        try await fixture.start()
        let shot = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
        _ = try await fixture.service.perform(sessionID: "s1", prepared: shot, toolCallID: nil, attachFrame: true)

        lock.set(true)
        var iterator = notices.makeAsyncIterator()
        let notice = await iterator.next()
        XCTAssertEqual(notice?.locked, true)
        XCTAssertEqual(notice?.sessionID, "s1")
        XCTAssertEqual(notice?.title, "Fix the export sheet")
        XCTAssertTrue(notice?.sentence.contains("never unlocks") == true, notice?.sentence ?? "")

        let state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .paused)
        let presence = await fixture.service.presenceState()
        XCTAssertTrue(presence.lockedPause)
        XCTAssertEqual(presence.caption, "Paused: your Mac is locked")

        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .leftClick, coordinate: [10, 10]))
            XCTFail("acted on a locked Mac")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .screenLocked)
            XCTAssertTrue(error.errorDescription!.contains("never unlocks"))
        }
        await fixture.service.resume(sessionID: "s1")
        let stillPaused = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(stillPaused, .paused, "Resume cannot get past a lock")
        let posted = await fixture.sink.events
        XCTAssertTrue(posted.isEmpty, "no input reached a locked Mac")
    }

    func testAnUnlockLetsABackgroundRunCarryOnAndKeepsATakeoverPaused() async throws {
        let lock = FakeSessionLock()
        let fixture = ScreenFixture(sessionLock: lock)
        let notices = await fixture.service.lockNotices()
        try await fixture.start()
        var iterator = notices.makeAsyncIterator()

        lock.set(true)
        _ = await iterator.next()
        lock.set(false)
        let unlocked = await iterator.next()
        XCTAssertEqual(unlocked?.locked, false)
        XCTAssertEqual(unlocked?.waitsForResume, false)
        let running = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(running, .running(mode: .background, app: "TextEdit"))

        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        lock.set(true)
        _ = await iterator.next()
        lock.set(false)
        let afterTakeover = await iterator.next()
        XCTAssertEqual(afterTakeover?.waitsForResume, true)
        let paused = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(paused, .paused, "the person now at the Mac decides when a take-over carries on")
        await fixture.service.resume(sessionID: "s1")
        let resumed = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(resumed, .running(mode: .takeover, app: "TextEdit"))
    }

    func testTheLiveReadCatchesALockBeforeItsNotification() async throws {
        let lock = FakeSessionLock()
        let fixture = ScreenFixture(sessionLock: lock)
        try await fixture.start()
        lock.setSilently(true)
        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
            XCTFail()
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .screenLocked)
        }
        let state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .paused)
    }

    func testALockMidActionEndsItBeforeTheInputIsSent() async throws {
        let lock = FakeSessionLock()
        let fixture = ScreenFixture(sessionLock: lock)
        try await fixture.start()
        fixture.accessibility.focused[101] = fixture.accessibility.regions[2].1
        let typing = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: "hello"))
        // The Mac locks while the card waits.
        lock.setSilently(true)
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: typing, toolCallID: nil, attachFrame: false)
            XCTFail()
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .screenLocked)
        }
        let posted = await fixture.sink.events
        XCTAssertTrue(posted.isEmpty)
        XCTAssertTrue(fixture.accessibility.setTexts.isEmpty)
    }

    func testTheDisplayIsKeptAwakeOnlyWhileARunWorks() async throws {
        let lock = FakeSessionLock()
        let awake = FakeDisplayAwake()
        let fixture = ScreenFixture(sessionLock: lock, displayAwake: awake)
        try await fixture.start()
        XCTAssertTrue(awake.isHeld, "held while the run works")

        await fixture.service.pause(sessionID: "s1")
        XCTAssertFalse(awake.isHeld, "released on pause")
        await fixture.service.resume(sessionID: "s1")
        XCTAssertTrue(awake.isHeld)

        lock.set(true)
        await waitUntil { !awake.isHeld }
        lock.set(false)
        await waitUntil { awake.isHeld }

        await fixture.service.deactivate(sessionID: "s1")
        XCTAssertFalse(awake.isHeld, "released when the run ends")
    }

    func testAnIdleRunLetsTheDisplaySleepAndTheNextActionHoldsItAgain() async throws {
        let awake = FakeDisplayAwake()
        let timer = ManualIdleTimer()
        let fixture = ScreenFixture(displayAwake: awake, idleTimer: timer)
        try await fixture.start()
        XCTAssertTrue(awake.isHeld)
        XCTAssertEqual(timer.waiting.count, 1, "one idle check waits, never more")

        // More work before the timer fires does not stack timers.
        _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
        XCTAssertEqual(timer.waiting.count, 1)

        fixture.clock.advance(30)
        await timer.fire()
        XCTAssertTrue(awake.isHeld, "half a minute of thinking keeps it")
        XCTAssertEqual(timer.waiting.count, 1, "the timer waits again for the rest of the span")
        XCTAssertLessThan(timer.waiting[0], 31)

        fixture.clock.advance(31)
        await timer.fire()
        XCTAssertFalse(awake.isHeld, "a minute with no action lets the display sleep")
        XCTAssertTrue(timer.waiting.isEmpty, "nothing waits once it is let go")

        _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
        XCTAssertTrue(awake.isHeld, "the next action holds it again")
        XCTAssertEqual(timer.waiting.count, 1)
    }

    /// Acceptance test 5: no code path can unlock a Mac.
    func testNoSourceCallsAnUnlockOrPasswordAPI() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/JunoScreenControl", isDirectory: true)
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 10)
        let forbidden = [
            "SkyLight", "SLSSession", "SACScreen", "CGSSessionUnlock", "SACLockScreen",
            "AuthorizationCreate", "AuthorizationExecuteWithPrivileges", "kAuthorizationRight",
            "SecKeychainUnlock", "IOPMAssertionDeclareUserActivity", "unlockScreen", "LAContext",
        ]
        var hits: [String] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for symbol in forbidden where text.contains(symbol) {
                hits.append("\(file.lastPathComponent): \(symbol)")
            }
        }
        XCTAssertEqual(hits, [])
    }
}

final class UnattendedRunTests: XCTestCase {
    func testAnUnattendedRunCannotTakeOver() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        await fixture.service.setAttendance(sessionID: "s1", unattended: true)
        for attempt in 0..<2 {
            do {
                if attempt == 0 {
                    _ = try await fixture.service.requestTakeover(sessionID: "s1", displayID: nil)
                } else {
                    _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
                }
                XCTFail("an unattended run took over")
            } catch let ScreenControlError.unattendedRefused(sentence) {
                XCTAssertTrue(sentence.contains("Nobody is watching"), sentence)
            }
        }
        let state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .running(mode: .background, app: "TextEdit"))
    }

    func testMarkingARunUnattendedEndsATakeover() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        await fixture.service.setAttendance(sessionID: "s1", unattended: true)
        let state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .running(mode: .background, app: "TextEdit"))
    }

    func testAnUnattendedRunStopsAtItsDeadline() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        await fixture.service.setAttendance(sessionID: "s1", unattended: true, limit: 60)
        _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
        fixture.clock.advance(30)
        // Calling again does not buy more time.
        await fixture.service.setAttendance(sessionID: "s1", unattended: true, limit: 60)
        fixture.clock.advance(31)
        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
            XCTFail()
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .unattendedDeadline)
            XCTAssertTrue(error.endsTurn)
        }
    }

    func testSkippedStepsAreRecordedAndShown() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        await fixture.service.setAttendance(sessionID: "s1", unattended: true)
        let unattended = await fixture.service.isUnattended(sessionID: "s1")
        XCTAssertTrue(unattended)
        let activity = await fixture.service.activity()
        await fixture.service.recordSkipped(sessionID: "s1", summary: "Click the “Send” button in Mail", reason: "it needed the reader's approval")
        var iterator = activity.makeAsyncIterator()
        let step = await iterator.next()
        XCTAssertEqual(step?.summary, "Skipped: Click the “Send” button in Mail")
        XCTAssertEqual(step?.succeeded, false)
        let skipped = await fixture.service.skippedSteps(sessionID: "s1")
        XCTAssertEqual(skipped.map(\.summary), ["Click the “Send” button in Mail"])
    }

    func testAttendanceEndsWithTheSession() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        await fixture.service.setAttendance(sessionID: "s1", unattended: true)
        await fixture.service.deactivate(sessionID: "s1")
        try await fixture.start()
        let unattended = await fixture.service.isUnattended(sessionID: "s1")
        XCTAssertFalse(unattended, "the next run is attended unless its host says otherwise")
    }
}
