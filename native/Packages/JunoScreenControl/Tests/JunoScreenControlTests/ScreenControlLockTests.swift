import XCTest
@testable import JunoScreenControl

/// One lock for every Code workspace and every Work task (CU-09).
final class ScreenControlLockTests: XCTestCase {
    func testASecondClaimantIsRefusedByName() async throws {
        let lock = ScreenControlLock()
        _ = try await lock.claim(ScreenControlHolder(id: "workspace-a", kind: .codeSession, title: "Fix the export sheet"))
        await lock.setApp("TextEdit", for: "workspace-a")
        do {
            _ = try await lock.claim(ScreenControlHolder(id: "workspace-b", kind: .codeSession, title: "Other"))
            XCTFail("a second workspace took the lock")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .lockHeld(holder: "Juno is using TextEdit for ‘Fix the export sheet’"))
            XCTAssertTrue(error.errorDescription?.hasPrefix("Juno is using TextEdit for ‘Fix the export sheet’.") == true)
        }
        do {
            _ = try await lock.claim(ScreenControlHolder(id: "work-run-7", kind: .workTask, title: "Tidy downloads"))
            XCTFail("a Work task took the lock")
        } catch ScreenControlError.lockHeld {}
    }

    func testTheSameHolderMayClaimAgain() async throws {
        let lock = ScreenControlLock()
        let first = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "A"))
        let second = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "A"))
        let firstValid = await lock.isValid(first)
        let secondValid = await lock.isValid(second)
        XCTAssertTrue(firstValid)
        XCTAssertTrue(secondValid)
    }

    func testOneStopReleasesEverythingAndTellsEveryone() async throws {
        let lock = ScreenControlLock()
        let heard = Heard()
        await lock.addStopListener { reason in Task { await heard.add("code:\(reason.rawValue)") } }
        await lock.addStopListener { reason in Task { await heard.add("work:\(reason.rawValue)") } }
        let claim = try await lock.claim(ScreenControlHolder(id: "a", kind: .codeSession, title: "A"))
        await lock.stopAll(reason: .escapeKey)
        let valid = await lock.isValid(claim)
        XCTAssertFalse(valid)
        let holder = await lock.currentHolder
        XCTAssertNil(holder)
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
        XCTAssertEqual(ScreenControlHolder(id: "a", kind: .workTask, title: "").sentence, "Juno is already using apps for a Work task")
        XCTAssertEqual(ScreenControlHolder(id: "a", kind: .codeSession, title: "Ship it").sentence, "Juno is already using apps for ‘Ship it’")
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
