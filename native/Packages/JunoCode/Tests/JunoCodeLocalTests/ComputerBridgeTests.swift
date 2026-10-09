import Foundation
import XCTest
import JunoCodeCore
import JunoScreenControl
@testable import JunoCodeLocal

/// Connected agents' computer use through the env server's bridge (Code v2
/// SPEC §3.12): the executor against the real service with inert fakes, the
/// socket server end to end, and the screenshot store.
final class ComputerBridgeTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        // Short: a Unix socket path must fit in 104 bytes.
        directory = URL(fileURLWithPath: "/tmp").appendingPathComponent("acb-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    final class Approver: ComputerBridgeApproving, @unchecked Sendable {
        private let lock = NSLock()
        var allowAgents = true
        var approveCards = true
        private(set) var agentAsks: [String] = []
        private(set) var cards: [String] = []

        func allowAgent(sessionID: String, title: String) async -> Bool {
            lock.withLock {
                agentAsks.append(title)
                return allowAgents
            }
        }

        func approve(_ detail: ScreenApprovalDetail, summary: String, sessionID: String) async -> Bool {
            lock.withLock {
                switch detail {
                case .grants: cards.append("grants: \(summary)")
                case .action: cards.append("action: \(summary)")
                case .takeover: cards.append("takeover")
                }
                return approveCards
            }
        }
    }

    private func executor(
        approver: Approver,
        permissions: ComputerUsePermissionStatus = .init(screenRecording: .granted, accessibility: .granted),
        settings: ComputerUseBridgeSettings = .init(connectedAgentsEnabled: true),
        service: ScreenControlService = makeTestScreenService()
    ) -> ComputerBridgeExecutor {
        ComputerBridgeExecutor(
            service: service,
            approver: approver,
            permissions: { permissions },
            settings: { settings },
            screenshots: ComputerScreenshotStore(root: directory.appendingPathComponent("shots")),
            lockHolder: { nil },
            now: { Date(timeIntervalSince1970: 1_791_489_600) }
        )
    }

    private func call(
        _ id: String, _ args: CodeV2.ComputerToolArgs, mode: CodeV2.RuntimeMode = .ask, session: String = "claude:t7"
    ) -> CodeV2.ComputerBridgeRequest {
        .init(id: id, type: .call, token: "t", sessionId: session, title: "Check the deck", runtimeMode: mode, callId: id, args: args)
    }

    private func action(_ response: CodeV2.ComputerBridgeResponse) -> CodeV2.ComputerAction? {
        if case let .computerAction(item)? = response.item { return item }
        return nil
    }

    // MARK: Status and readiness

    func testStatusNamesWhatIsMissing() async {
        let approver = Approver()
        let missing = executor(approver: approver, permissions: .init(screenRecording: .denied, accessibility: .granted))
        let status = await missing.handle(.init(id: "s", type: .status, token: "t", sessionId: "x"))
        XCTAssertFalse(status.ok)
        XCTAssertEqual(status.missingPermissions, ["screen_recording"])
        XCTAssertTrue(status.text.contains("System Settings › Privacy & Security › Screen Recording"))

        let off = executor(approver: approver, settings: .init(connectedAgentsEnabled: false))
        let offStatus = await off.handle(.init(id: "s", type: .status, token: "t", sessionId: "x"))
        XCTAssertFalse(offStatus.ok)
        XCTAssertTrue(offStatus.text.contains("Let connected agents use apps"))

        let ready = await executor(approver: approver).handle(.init(id: "s", type: .status, token: "t", sessionId: "x"))
        XCTAssertTrue(ready.ok)
        XCTAssertEqual(ready.missingPermissions, [])
    }

    func testNothingRunsWithoutTheGrantsTheSwitchAndTheReadersYes() async {
        let approver = Approver()
        let noGrant = await executor(approver: approver, permissions: .init(screenRecording: .granted, accessibility: .denied))
            .handle(call("c1", .init(action: .screenshot)))
        XCTAssertFalse(noGrant.ok)
        XCTAssertEqual(noGrant.endsTurn, true)
        XCTAssertEqual(noGrant.missingPermissions, ["accessibility"])
        XCTAssertEqual(action(noGrant)?.status, .failed)

        let off = await executor(approver: approver, settings: .init()).handle(call("c2", .init(action: .screenshot)))
        XCTAssertEqual(off.endsTurn, true)
        XCTAssertTrue(approver.agentAsks.isEmpty, "the reader's switch comes before any card")

        approver.allowAgents = false
        let service = makeTestScreenService()
        let declined = await executor(approver: approver, service: service).handle(call("c3", .init(action: .screenshot)))
        XCTAssertFalse(declined.ok)
        XCTAssertEqual(action(declined)?.status, .declined)
        XCTAssertEqual(approver.agentAsks, ["Check the deck"])
        let active = await service.isActive(sessionID: ComputerBridgeExecutor.screenSessionID("claude:t7"))
        XCTAssertFalse(active)
    }

    // MARK: Calls

    func testAScreenshotGrantsTheAppOnceAndComesBackAsAnItemWithItsPicture() async throws {
        let approver = Approver()
        let service = makeTestScreenService()
        let bridge = executor(approver: approver, service: service)
        let first = await bridge.handle(call("c1", .init(action: .screenshot, app: "com.apple.TextEdit")))
        XCTAssertTrue(first.ok, first.text)
        XCTAssertEqual(approver.cards.count, 1)
        XCTAssertTrue(approver.cards[0].hasPrefix("grants:"))
        let image = try XCTUnwrap(first.image)
        XCTAssertNotNil(Data(base64Encoded: image.data))
        let item = try XCTUnwrap(action(first))
        XCTAssertEqual(item.status, .completed)
        XCTAssertEqual(item.callId, "c1")
        XCTAssertEqual(item.screenshotRef, "alevr-shot://claude:t7/c1.\(image.mediaType.contains("png") ? "png" : "jpg")")
        XCTAssertNotNil(item.frameSize)
        let stored = ComputerScreenshotStore(root: directory.appendingPathComponent("shots"))
        let bytes = await stored.data(for: try XCTUnwrap(item.screenshotRef))
        XCTAssertNotNil(bytes)
        XCTAssertTrue(first.text.contains("frame "), "the model is told which frame its coordinates are in")

        // Granted now: no second grant card.
        let second = await bridge.handle(call("c2", .init(action: .screenshot, app: "com.apple.TextEdit")))
        XCTAssertTrue(second.ok, second.text)
        XCTAssertEqual(approver.cards.count, 1)
        XCTAssertEqual(approver.agentAsks.count, 1, "the agent is allowed once per session")

        // The response round-trips through the contract shape.
        let encoded = try JSONEncoder().encode(second)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual((raw["item"] as? [String: Any])?["kind"] as? String, "computer_action")

        let released = await bridge.handle(.init(id: "r", type: .release, token: "t", sessionId: "claude:t7"))
        XCTAssertTrue(released.ok)
        let active = await service.isActive(sessionID: ComputerBridgeExecutor.screenSessionID("claude:t7"))
        XCTAssertFalse(active)
    }

    func testTheRuntimeModeDecidesWhetherInputAsks() async throws {
        let approver = Approver()
        let bridge = executor(approver: approver)
        _ = await bridge.handle(call("c1", .init(action: .screenshot, app: "com.apple.TextEdit")))

        let readOnly = await bridge.handle(call("c2", .init(action: .click, x: 10, y: 10), mode: .readOnly))
        XCTAssertFalse(readOnly.ok)
        XCTAssertEqual(readOnly.text, ComputerUseAccessPolicy.readOnlySentence)
        XCTAssertEqual(action(readOnly)?.status, .declined)

        let asked = await bridge.handle(call("c3", .init(action: .click, x: 10, y: 10), mode: .ask))
        XCTAssertTrue(asked.ok, asked.text)
        XCTAssertTrue(approver.cards.last?.hasPrefix("action:") == true)

        approver.approveCards = false
        let no = await bridge.handle(call("c4", .init(action: .click, x: 10, y: 10), mode: .autoEdit))
        XCTAssertFalse(no.ok)
        XCTAssertTrue(no.text.hasPrefix("The reader said no"))

        let cardsBefore = approver.cards.count
        let full = await bridge.handle(call("c5", .init(action: .click, x: 10, y: 10), mode: .full))
        XCTAssertTrue(full.ok, full.text)
        XCTAssertEqual(approver.cards.count, cardsBefore, "full access runs ordinary input without a card")
        XCTAssertEqual(action(full)?.point.map { $0.x > 0 && $0.x < 1 }, true, "the ring lands inside the frame")
    }

    func testInvalidArgumentsAreSentencesNotCrashes() async {
        let bridge = executor(approver: Approver())
        let response = await bridge.handle(call("c1", .init(action: .drag, x: 1, y: 1)))
        XCTAssertFalse(response.ok)
        XCTAssertTrue(response.text.contains("drag needs x, y, to_x and to_y"))
        let noArgs = await bridge.handle(.init(id: "x", type: .call, token: "t", sessionId: "s"))
        XCTAssertEqual(noArgs.text, "computer.call needs args.")
    }

    // MARK: Socket

    private struct Echo: ComputerBridgeHandling {
        func handle(_ request: CodeV2.ComputerBridgeRequest) async -> CodeV2.ComputerBridgeResponse {
            .init(id: request.id, ok: true, text: "echo \(request.sessionId) \(request.args?.action.rawValue ?? "-")")
        }
    }

    private func roundTrip(_ socket: URL, lines: [String]) throws -> [String] {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: socket.path.utf8)
            raw[socket.path.utf8.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(connected, 0)
        let payload = Data((lines.joined(separator: "\n") + "\n").utf8)
        _ = payload.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        var received = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while received.split(separator: 0x0A).count < lines.count {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            received.append(contentsOf: chunk[0..<n])
        }
        return received.split(separator: 0x0A).map { String(decoding: $0, as: UTF8.self) }
    }

    func testTheSocketAnswersEachLineAndRefusesAStaleToken() throws {
        let server = ComputerBridgeServer(directory: directory.appendingPathComponent("b"), handler: Echo())
        try server.start()
        defer { server.stop() }
        server.allowPeer(getpid())
        let token = try String(contentsOf: server.tokenURL, encoding: .utf8)
        XCTAssertEqual(token.count, 64)
        let attributes = try FileManager.default.attributesOfItem(atPath: server.tokenURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        let good = #"{"id":"1","type":"computer.call","token":"\#(token)","sessionId":"s1","args":{"action":"screenshot"}}"#
        let stale = #"{"id":"2","type":"computer.status","token":"old","sessionId":"s1"}"#
        let lines = try roundTrip(server.socketURL, lines: [good, stale, "not json"])
        XCTAssertEqual(lines.count, 3)
        let decoded = try lines.map { try JSONDecoder().decode(CodeV2.ComputerBridgeResponse.self, from: Data($0.utf8)) }
        XCTAssertEqual(decoded[0].text, "echo s1 screenshot")
        XCTAssertFalse(decoded[1].ok)
        XCTAssertEqual(decoded[1].endsTurn, true)
        XCTAssertTrue(decoded[1].text.contains("token is out of date"))
        XCTAssertFalse(decoded[2].ok)

        server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.tokenURL.path), "a stopped bridge leaves no token behind")
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.socketURL.path))
    }

    func testAPeerTheAppDidNotLaunchIsRefusedEvenWithTheToken() throws {
        let server = ComputerBridgeServer(directory: directory.appendingPathComponent("p"), handler: Echo())
        try server.start()
        defer { server.stop() }
        let token = try String(contentsOf: server.tokenURL, encoding: .utf8)
        let call = #"{"id":"7","type":"computer.call","token":"\#(token)","sessionId":"s1","args":{"action":"screenshot"}}"#
        // Not registered: the right token is not enough.
        var lines = try roundTrip(server.socketURL, lines: [call])
        var response = try JSONDecoder().decode(CodeV2.ComputerBridgeResponse.self, from: Data(lines[0].utf8))
        XCTAssertEqual(response.id, "7")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.endsTurn, true)
        XCTAssertTrue(response.text.contains("Only the local environment Alevr started"))
        // Registered (this test process stands in for the env server): answered.
        server.allowPeer(getpid())
        lines = try roundTrip(server.socketURL, lines: [call])
        response = try JSONDecoder().decode(CodeV2.ComputerBridgeResponse.self, from: Data(lines[0].utf8))
        XCTAssertTrue(response.ok)
        server.revokePeer(getpid())
        lines = try roundTrip(server.socketURL, lines: [call])
        response = try JSONDecoder().decode(CodeV2.ComputerBridgeResponse.self, from: Data(lines[0].utf8))
        XCTAssertFalse(response.ok)
    }

    func testAnUnboundBridgeStillRequiresThisUser() throws {
        let server = ComputerBridgeServer(directory: directory.appendingPathComponent("u"), handler: Echo(), bindToRegisteredPeers: false)
        try server.start()
        defer { server.stop() }
        let token = try String(contentsOf: server.tokenURL, encoding: .utf8)
        let call = #"{"id":"8","type":"computer.status","token":"\#(token)","sessionId":"s1"}"#
        let lines = try roundTrip(server.socketURL, lines: [call])
        XCTAssertEqual(lines.count, 1)
        XCTAssertNotNil(try? JSONDecoder().decode(CodeV2.ComputerBridgeResponse.self, from: Data(lines[0].utf8)))
    }

    // MARK: Screenshot store

    func testTheStoreKeepsShotsInsideItsFolderAndPrunesTheOldest() async throws {
        let store = ComputerScreenshotStore(root: directory.appendingPathComponent("s"), perSessionLimit: 2)
        let frame = EncodedFrame(data: Data([0xFF, 0xD8]), mediaType: "image/jpeg", size: PixelSize(width: 2, height: 2))
        let ref = await store.store(sessionID: "claude:t7", callID: "c1", frame: frame)
        XCTAssertEqual(ref, "alevr-shot://claude:t7/c1.jpg")
        let back = await store.data(for: "alevr-shot://claude:t7/c1.jpg")
        XCTAssertEqual(back, frame.data)
        XCTAssertNil(store.url(for: "alevr-shot://../etc/passwd"))
        XCTAssertNil(store.url(for: "alevr-shot://a/../../x.jpg"))
        XCTAssertNil(store.url(for: "file:///etc/passwd"))
        XCTAssertNil(store.url(for: "alevr-shot://a/b/c.jpg"))
        let weird = await store.store(sessionID: "a/../b", callID: "c 2", frame: frame)
        XCTAssertEqual(weird, "alevr-shot://a_.._b/c_2.jpg", "components are made path-safe")

        try await Task.sleep(for: .milliseconds(20))
        _ = await store.store(sessionID: "claude:t7", callID: "c2", frame: frame)
        try await Task.sleep(for: .milliseconds(20))
        _ = await store.store(sessionID: "claude:t7", callID: "c3", frame: frame)
        let first = await store.data(for: "alevr-shot://claude:t7/c1.jpg")
        XCTAssertNil(first, "the oldest goes beyond the limit")
        await store.remove(sessionID: "claude:t7")
        let gone = await store.data(for: "alevr-shot://claude:t7/c3.jpg")
        XCTAssertNil(gone)
    }
}
