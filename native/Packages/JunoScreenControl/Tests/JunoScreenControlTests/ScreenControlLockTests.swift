import XCTest
@testable import JunoScreenControl

/// The app-wide arbiter (CU-09, Code v2 SPEC §3.12): many conversations at
/// once, one app each; Work and takeover alone; nothing outlives its owner.
final class ScreenControlLockTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSince1970: 1_791_489_600)
        var now: Date { lock.withLock { current } }
        func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
    }

    func testTwoConversationsRunSideBySideInDifferentApps() async throws {
        let lock = ScreenControlLock()
        _ = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "Fix the export sheet"))
        _ = try await lock.claim(ScreenControlHolder(id: "agent:t2", kind: .connectedAgent, title: "Book the train", threadID: "t2"))
        try await lock.claimApp(bundleID: "com.apple.TextEdit", name: "TextEdit", for: "a")
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t2")
        let holds = await lock.holds
        XCTAssertEqual(holds.map(\.holder.id), ["a", "agent:t2"])
        XCTAssertEqual(holds.map(\.bundleID), ["com.apple.textedit", "com.apple.safari"])
    }

    func testTwoThreadsExcludeEachOtherFromOneApp() async throws {
        let lock = ScreenControlLock()
        _ = try await lock.claim(ScreenControlHolder(id: "agent:t1", kind: .connectedAgent, title: "Open Safari for me", threadID: "t1"))
        _ = try await lock.claim(ScreenControlHolder(id: "agent:t2", kind: .connectedAgent, title: "Book the train", threadID: "t2"))
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t1")
        do {
            try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t2")
            XCTFail("two threads drove Safari")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .appBusy(app: "Safari", holder: "‘Open Safari for me’"))
        }
        // t1 moves on to Notes: Safari is free for t2.
        try await lock.claimApp(bundleID: "com.apple.Notes", name: "Notes", for: "agent:t1")
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t2")
    }

    /// The owner's report: the same conversation, a failed turn then a new
    /// one, must never be "another session" to itself.
    func testTheSameThreadIsReentrantAcrossTurns() async throws {
        let lock = ScreenControlLock()
        let turn1 = try await lock.claim(ScreenControlHolder(id: "agent:t1", kind: .connectedAgent, title: "Open Safari", threadID: "t1"))
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t1")
        let turn2 = try await lock.claim(ScreenControlHolder(id: "agent:t1", kind: .connectedAgent, title: "Open Safari", threadID: "t1"))
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t1")
        let valid1 = await lock.isValid(turn1)
        let valid2 = await lock.isValid(turn2)
        XCTAssertTrue(valid1)
        XCTAssertTrue(valid2)
        let holds = await lock.holds
        XCTAssertEqual(holds.count, 1)
    }

    func testAnIdleHoldIsReclaimedAndItsOwnerIsTold() async throws {
        let clock = Clock()
        let lock = ScreenControlLock(idleLimit: 60, now: { clock.now })
        let heard = Heard()
        await lock.addEvictionListener { id, reason in Task { await heard.add("\(id):\(reason.rawValue)") } }
        let old = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "Old"))
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "a")
        _ = try await lock.claim(ScreenControlHolder(id: "b", kind: .codeSession, title: "New"))
        clock.advance(30)
        do {
            try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "b")
            XCTFail("a live hold was taken")
        } catch ScreenControlError.appBusy {}
        // A call in flight (an approval card waiting) is never idle.
        await lock.beginCall("a")
        clock.advance(120)
        do {
            try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "b")
            XCTFail("a hold with a call in flight was taken")
        } catch ScreenControlError.appBusy {}
        await lock.endCall("a")
        clock.advance(61)
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "b")
        let oldValid = await lock.isValid(old)
        XCTAssertFalse(oldValid)
        try await waitUntil { await heard.items == ["a:handedOff"] }
    }

    func testTakeOverEndsTheOtherConversationsHold() async throws {
        let lock = ScreenControlLock()
        let other = try await lock.claim(ScreenControlHolder(id: "agent:t1", kind: .connectedAgent, title: "One", threadID: "t1"))
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t1")
        _ = try await lock.claim(ScreenControlHolder(id: "agent:t2", kind: .connectedAgent, title: "Two", threadID: "t2"))
        await lock.evict(conversationID: "t1")
        let valid = await lock.isValid(other)
        XCTAssertFalse(valid)
        try await lock.claimApp(bundleID: "com.apple.Safari", name: "Safari", for: "agent:t2")
    }

    func testWorkAndTakeoverRunAlone() async throws {
        let lock = ScreenControlLock()
        _ = try await lock.claim(ScreenControlHolder(id: "workspace-a", kind: .codeSession, title: "Fix the export sheet"))
        await lock.setApp("TextEdit", for: "workspace-a")
        do {
            _ = try await lock.claim(ScreenControlHolder(id: "work-run-7", kind: .workTask, title: "Tidy downloads"))
            XCTFail("a Work task ran beside a session")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .lockHeld(holder: "Alevr is using TextEdit for ‘Fix the export sheet’"))
            XCTAssertTrue(error.errorDescription?.hasPrefix("Alevr is using TextEdit for ‘Fix the export sheet’.") == true)
        }
        try await lock.setExclusive(true, for: "workspace-a")
        do {
            _ = try await lock.claim(ScreenControlHolder(id: "workspace-b", kind: .codeSession, title: "Other"))
            XCTFail("a session started beside a takeover")
        } catch ScreenControlError.lockHeld {}
        try await lock.setExclusive(false, for: "workspace-a")
        _ = try await lock.claim(ScreenControlHolder(id: "workspace-b", kind: .codeSession, title: "Other"))
    }

    func testOneStopReleasesEverythingAndTellsEveryone() async throws {
        let lock = ScreenControlLock()
        let heard = Heard()
        await lock.addStopListener { reason in Task { await heard.add("code:\(reason.rawValue)") } }
        await lock.addStopListener { reason in Task { await heard.add("work:\(reason.rawValue)") } }
        let claim = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "A"))
        _ = try await lock.claim(ScreenControlHolder(id: "b", kind: .connectedAgent, title: "B"))
        await lock.stopAll(reason: .escapeKey)
        let valid = await lock.isValid(claim)
        XCTAssertFalse(valid)
        let holder = await lock.currentHolder
        XCTAssertNil(holder)
        let holds = await lock.holds
        XCTAssertTrue(holds.isEmpty)
        // Anyone may now claim.
        _ = try await lock.claim(ScreenControlHolder(id: "work-run", kind: .workTask, title: "Work"))
        try await waitUntil { await heard.items.count == 2 }
        let items = await heard.items
        XCTAssertEqual(Set(items), ["code:escapeKey", "work:escapeKey"])
    }

    func testAReleaseFromAnOldClaimDoesNothing() async throws {
        let lock = ScreenControlLock()
        let old = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "A"))
        await lock.release(old)
        _ = try await lock.claim(ScreenControlHolder(id: "b", kind: .codeSession, title: "B"))
        await lock.release(old)
        let holder = await lock.currentHolder
        XCTAssertEqual(holder?.id, "b")
    }

    func testTheHolderSentenceWithoutAnApp() {
        XCTAssertEqual(ScreenControlHolder(id: "a", kind: .workTask, title: "").sentence, "Alevr is already using apps for a Work task")
        XCTAssertEqual(ScreenControlHolder(id: "a", kind: .codeSession, title: "Ship it").sentence, "Alevr is already using apps for ‘Ship it’")
        XCTAssertEqual(ScreenControlHolder(id: "a", kind: .connectedAgent, title: " ").name, "Another conversation")
    }
}

actor Heard {
    var items: [String] = []
    func add(_ item: String) { items.append(item) }
}

func waitUntil(timeout: TimeInterval = 2, _ condition: @escaping @Sendable () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("timed out waiting")
}
