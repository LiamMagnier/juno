import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Receipts for relayed commands (docs/code-v2/DEVICE-LINK.md "Receipts"):
/// the relay may deliver a command twice, and this Mac runs it once.
final class EnvLinkReceiptsTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("link-receipts-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func turnLink(_ ran: SequenceLog, gate: Gate? = nil) -> EnvServerDeviceLink {
        EnvServerDeviceLink(
            allowedRoots: { ["/Users/maya/code/shop"] },
            forward: { type, _ in
                if type == .sessionList {
                    return .object(["sessions": .array([.object(["id": .string("s1"), "cwd": .string("/Users/maya/code/shop")])])])
                }
                ran.append(1)
                await gate?.wait()
                return .object(["turnId": .string("t\(ran.values.count)")])
            }
        )
    }

    private func pushedResponses(_ posted: PostLog) -> [[String: Any]] {
        posted.bodies.compactMap { $0 }
            .compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .filter { $0["kind"] as? String == "push" }
            .flatMap { ($0["responses"] as? [[String: Any]]) ?? [] }
    }

    private static let turn = EnvLinkRequest.Command(
        id: "link_7c1d",
        type: "turn.start",
        params: .object(["sessionId": .string("s1"), "input": .array([])])
    )

    /// A repeat while the first delivery still runs answers nothing; a repeat
    /// after it finished sends the same answer again. The turn starts once.
    func testADuplicateDeliveryNeverRunsTheCommandAgain() async throws {
        let ran = SequenceLog()
        let gate = Gate()
        let posted = PostLog()
        let channel = EnvServerDeviceLinkChannel(
            deviceId: "mac-1",
            link: turnLink(ran, gate: gate),
            flushDelay: .milliseconds(5),
            receipts: EnvLinkReceipts(directory: directory)
        ) { _, path, body in
            posted.append(path, body)
            return (200, Data(#"{"accepted":1}"#.utf8))
        }
        let turn = Self.turn
        let first = Task { await channel.answer(turn) }
        for _ in 0..<100 where ran.values.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        await channel.answer(turn) // redelivered while the turn is still starting
        XCTAssertEqual(ran.values.count, 1)
        XCTAssertTrue(pushedResponses(posted).isEmpty, "nothing is answered for a repeat of a running command")

        await gate.open()
        await first.value
        await channel.answer(turn) // redelivered after the answer went out (and was lost)
        for _ in 0..<100 where pushedResponses(posted).count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(ran.values.count, 1, "the turn started once")
        let responses = pushedResponses(posted)
        XCTAssertEqual(responses.compactMap { $0["id"] as? String }, ["link_7c1d", "link_7c1d"])
        XCTAssertEqual(responses.compactMap { ($0["result"] as? [String: Any])?["turnId"] as? String }, ["t1", "t1"], "the kept answer, not a new one")
    }

    /// The receipt outlives the app: after a restart a repeat of a finished
    /// command gets its answer, and one that was still running when the app
    /// ended gets an error instead of a second run.
    func testReceiptsSurviveARestart() async throws {
        let before = EnvLinkReceipts(directory: directory)
        XCTAssertEqual(before.begin("link_done"), .run)
        let answer = CodeV2.ServerResponse(id: "link_done", ok: true, result: .object(["turnId": .string("t1")]))
        before.finish("link_done", answer)
        XCTAssertEqual(before.begin("link_cut"), .run) // the app quits while this runs

        let after = EnvLinkReceipts(directory: directory)
        XCTAssertEqual(after.begin("link_done"), .finished(answer))
        guard case let .finished(cut) = after.begin("link_cut") else { return XCTFail("an interrupted command must not run again") }
        XCTAssertEqual(cut.ok, false)
        XCTAssertEqual(cut.error?.code, .notReady)

        // Through the channel: the restarted app does not start the turn again.
        let ran = SequenceLog()
        let posted = PostLog()
        let channel = EnvServerDeviceLinkChannel(
            deviceId: "mac-1",
            link: turnLink(ran),
            flushDelay: .milliseconds(5),
            receipts: EnvLinkReceipts(directory: directory)
        ) { _, path, body in
            posted.append(path, body)
            return (200, Data(#"{"accepted":1}"#.utf8))
        }
        await channel.answer(.init(id: "link_cut", type: "turn.start", params: .object(["sessionId": .string("s1"), "input": .array([])])))
        for _ in 0..<100 where pushedResponses(posted).isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(ran.values.isEmpty)
        XCTAssertEqual(pushedResponses(posted).first?["ok"] as? Bool, false)
    }

    /// The relay redelivers only to a host whose pull says it keeps durable receipts.
    func testThePullAdvertisesReceiptsOnlyWhenTheyAreDurable() async throws {
        func firstPull(_ receipts: EnvLinkReceipts) async -> [String: Any]? {
            let posted = PostLog()
            let channel = EnvServerDeviceLinkChannel(deviceId: "mac-1", link: turnLink(SequenceLog()), receipts: receipts) { _, path, body in
                posted.append(path, body)
                return (200, Data(#"{"protocol":{"name":"alevr-code-v2","version":"1.0"},"commands":[]}"#.utf8))
            }
            await channel.pullOnce()
            return posted.bodies.first.flatMap { $0 }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        let durable = await firstPull(EnvLinkReceipts(directory: directory))
        XCTAssertEqual(durable?["receipts"] as? Bool, true)
        let memory = await firstPull(EnvLinkReceipts(directory: nil))
        XCTAssertNil(memory?["receipts"], "a store that forgets on restart must keep the relay at-most-once")
    }

    /// Bounded by count and age, on disk too; an answer too large to keep is
    /// replaced by an error rather than kept.
    func testReceiptsAreBounded() throws {
        let clock = ReceiptClock(Date(timeIntervalSince1970: 1_800_000_000))
        let receipts = EnvLinkReceipts(directory: directory, limit: 3, keepFor: 60, maxCachedBytes: 512, now: { clock.now })
        for i in 0..<5 {
            XCTAssertEqual(receipts.begin("link_\(i)"), .run)
            receipts.finish("link_\(i)", CodeV2.ServerResponse(id: "link_\(i)", ok: true))
            clock.advance(1)
        }
        XCTAssertEqual(receipts.count, 3)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 3)
        XCTAssertEqual(receipts.begin("link_4"), .finished(CodeV2.ServerResponse(id: "link_4", ok: true)))

        clock.advance(120)
        XCTAssertEqual(receipts.begin("link_4"), .run, "an expired receipt is forgotten")
        XCTAssertEqual(receipts.count, 1)

        receipts.finish("link_4", CodeV2.ServerResponse(id: "link_4", ok: true, result: .string(String(repeating: "x", count: 4_096))))
        guard case let .finished(kept) = EnvLinkReceipts(directory: directory, maxCachedBytes: 512, now: { clock.now }).begin("link_4") else {
            return XCTFail("a finished command must not run again")
        }
        XCTAssertEqual(kept.ok, false)
        XCTAssertNil(kept.result)
    }
}

/// Holds a forwarded command until the test lets it finish.
private actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func open() {
        isOpen = true
        for continuation in waiting { continuation.resume() }
        waiting.removeAll()
    }
}

private final class ReceiptClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}
