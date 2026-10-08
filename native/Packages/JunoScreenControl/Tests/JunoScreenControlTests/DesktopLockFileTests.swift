import XCTest
@testable import JunoScreenControl

/// The cross-process desktop lock (Code v2 SPEC §3.12). The env server's
/// `DesktopLock` (tests/computer-use-mcp.test.ts) runs the same cases.
final class DesktopLockFileTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("alevr-lock-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 1_791_489_600)
    }

    private final class Alive: @unchecked Sendable {
        var pids: Set<Int32> = []
    }

    private func lock(pid: Int32, clock: Clock, alive: Alive) -> DesktopLockFile {
        DesktopLockFile(
            url: directory.appendingPathComponent("desktop.lock"),
            pid: pid,
            staleAfter: 15,
            now: { clock.now },
            isAlive: { alive.pids.contains($0) }
        )
    }

    func testExclusiveReentrantAndReleasedOnlyByItsHolder() throws {
        let clock = Clock()
        let alive = Alive()
        alive.pids = [101, 202]
        let a = lock(pid: 101, clock: clock, alive: alive)
        let b = lock(pid: 202, clock: clock, alive: alive)

        guard case let .acquired(first) = a.acquire(holderID: "mac:s1", kind: .codeSession, title: "Fix the export sheet", app: "TextEdit") else {
            return XCTFail("free lock not acquired")
        }
        XCTAssertEqual(first.pid, 101)
        guard case let .held(by: holder) = b.acquire(holderID: "claude:t7", kind: .envServer, title: "Check the deck") else {
            return XCTFail("a second holder took it")
        }
        XCTAssertEqual(holder.sentence, "Alevr is using TextEdit for ‘Fix the export sheet’")

        clock.now += 1
        guard case let .acquired(again) = b.acquire(holderID: "mac:s1", kind: .codeSession, title: "") else {
            return XCTFail("the same holder from another process is re-entrant")
        }
        XCTAssertEqual(again.pid, 202)
        XCTAssertEqual(again.title, "Fix the export sheet")
        XCTAssertEqual(again.acquiredAt, first.acquiredAt)

        XCTAssertFalse(b.release(holderID: "claude:t7"))
        XCTAssertFalse(a.heartbeat(holderID: "nobody"))
        XCTAssertTrue(a.heartbeat(holderID: "mac:s1", app: "Pages"))
        XCTAssertEqual(a.read()?.app, "Pages")
        XCTAssertTrue(a.release(holderID: "mac:s1"))
        XCTAssertNil(a.read())
        XCTAssertNil(a.holder())
    }

    func testStaleRecordsAreTakenOver() throws {
        let clock = Clock()
        let alive = Alive()
        alive.pids = [1, 2]
        guard case .acquired = lock(pid: 1, clock: clock, alive: alive).acquire(holderID: "a", kind: .workTask, title: "") else {
            return XCTFail()
        }
        guard case let .held(by: record) = lock(pid: 2, clock: clock, alive: alive).acquire(holderID: "b", kind: .envServer, title: "") else {
            return XCTFail()
        }
        XCTAssertEqual(record.sentence, "Alevr is already using apps for a Work task")

        clock.now += 16
        guard case .acquired = lock(pid: 2, clock: clock, alive: alive).acquire(holderID: "b", kind: .envServer, title: "") else {
            return XCTFail("an old heartbeat is stale")
        }
        alive.pids.remove(2)
        guard case .acquired = lock(pid: 1, clock: clock, alive: alive).acquire(holderID: "a", kind: .codeSession, title: "") else {
            return XCTFail("a dead process's record is stale")
        }
        try Data("{garbage".utf8).write(to: directory.appendingPathComponent("desktop.lock"))
        guard case .acquired = lock(pid: 1, clock: clock, alive: alive).acquire(holderID: "c", kind: .codeSession, title: "") else {
            return XCTFail("an unreadable record is stale")
        }
    }

    func testTheRecordIsTheContractShape() throws {
        let clock = Clock()
        let alive = Alive()
        alive.pids = [7]
        _ = lock(pid: 7, clock: clock, alive: alive).acquire(holderID: "h", kind: .envServer, title: "T", app: "Notes")
        let data = try Data(contentsOf: directory.appendingPathComponent("desktop.lock"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["holderId", "kind", "title", "pid", "app", "acquiredAt", "heartbeatAt"])
        XCTAssertEqual(object["kind"] as? String, "env_server")
        XCTAssertEqual(object["acquiredAt"] as? String, "2026-10-08T20:00:00.000Z")
        // A record the env server (JavaScript, no fractional seconds) wrote is read.
        let js = #"{"holderId":"x","kind":"env_server","title":"","pid":7,"acquiredAt":"2026-10-08T20:00:00Z","heartbeatAt":"2026-10-08T20:00:00Z"}"#
        try Data(js.utf8).write(to: directory.appendingPathComponent("desktop.lock"))
        XCTAssertEqual(lock(pid: 8, clock: clock, alive: alive).holder()?.holderId, "x")
    }

    func testTheAppWideLockHonoursAnotherProcess() async throws {
        let clock = Clock()
        let alive = Alive()
        alive.pids = [ProcessInfo.processInfo.processIdentifier, 999]
        let other = lock(pid: 999, clock: clock, alive: alive)
        guard case .acquired = other.acquire(holderID: "claude:t7", kind: .envServer, title: "Check the deck", app: "Keynote") else {
            return XCTFail()
        }
        let file = DesktopLockFile(url: other.url, staleAfter: 15, now: { clock.now }, isAlive: { alive.pids.contains($0) })
        let appLock = ScreenControlLock(file: file, heartbeatInterval: .milliseconds(20))
        do {
            _ = try await appLock.claim(ScreenControlHolder(id: "mac:s1", kind: .codeSession, title: "Fix it"))
            XCTFail("the app took a desktop another process holds")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .lockHeld(holder: "Alevr is using Keynote for ‘Check the deck’"))
        }
        _ = other.release(holderID: "claude:t7")

        let claim = try await appLock.claim(ScreenControlHolder(id: "mac:s1", kind: .codeSession, title: "Fix it"))
        XCTAssertEqual(file.read()?.holderId, "mac:s1")
        XCTAssertEqual(file.read()?.kind, .codeSession)
        guard case .held = other.acquire(holderID: "claude:t7", kind: .envServer, title: "") else {
            return XCTFail("the env server took the desktop the app holds")
        }
        // The heartbeat keeps it fresh while held.
        clock.now += 10
        try await Task.sleep(for: .milliseconds(120))
        clock.now += 10
        XCTAssertNotNil(file.holder(), "heartbeats keep the record live")
        await appLock.release(claim)
        XCTAssertNil(file.read(), "release lets the file go")

        _ = try await appLock.claim(ScreenControlHolder(id: "agent:1", kind: .connectedAgent, title: ""))
        XCTAssertEqual(file.read()?.kind, .envServer)
        await appLock.stopAll(reason: .escapeKey)
        XCTAssertNil(file.read(), "the one stop lets the file go too")
    }
}
