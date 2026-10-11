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
        private(set) var permissionNotices: [(String, ComputerUsePermissionStatus)] = []

        func permissionsMissing(_ status: ComputerUsePermissionStatus, sessionID: String) async {
            lock.withLock { permissionNotices.append((sessionID, status)) }
        }

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
        service: ScreenControlService = makeTestScreenService(),
        livePermissions: (@Sendable () -> ComputerUsePermissionStatus)? = nil
    ) -> ComputerBridgeExecutor {
        ComputerBridgeExecutor(
            service: service,
            approver: approver,
            permissions: livePermissions ?? { permissions },
            settings: { settings },
            screenshots: ComputerScreenshotStore(root: directory.appendingPathComponent("shots")),
            lockHolder: { nil },
            now: { Date(timeIntervalSince1970: 1_791_489_600) },
            busyWait: .zero
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
        XCTAssertTrue(status.text.contains(ComputerUsePermission.screenRecording.settingsPath()), status.text)

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

        let off = await executor(approver: approver, settings: .init(connectedAgentsEnabled: false)).handle(call("c2", .init(action: .screenshot)))
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

    func testARefusedGrantTellsTheReaderAndGivesTheAgentTheWholeFix() async {
        let approver = Approver()
        let refused = await executor(approver: approver, permissions: .init(screenRecording: .granted, accessibility: .denied))
            .handle(call("c1", .init(action: .screenshot)))
        XCTAssertFalse(refused.ok)
        // The page by this macOS's name, and the remove-and-add fix for a
        // switch that is on but stale (1.10.9: on in Settings, untrusted).
        XCTAssertTrue(refused.text.contains(ComputerUsePermission.accessibility.settingsPath()), refused.text)
        XCTAssertTrue(refused.text.contains("press the minus button"), refused.text)
        XCTAssertTrue(refused.text.contains("no need to reopen"), refused.text)
        XCTAssertEqual(approver.permissionNotices.count, 1)
        XCTAssertEqual(approver.permissionNotices.first?.0, "claude:t7")
        XCTAssertEqual(approver.permissionNotices.first?.1.missing, [.accessibility])
        XCTAssertTrue(approver.agentAsks.isEmpty)

        // Granted: no notice.
        _ = await executor(approver: approver).handle(call("c2", .init(action: .screenshot)))
        XCTAssertEqual(approver.permissionNotices.count, 1)
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

    func testStopCannotBeRestartedByTheNextConnectedAgentCall() async throws {
        let approver = Approver()
        let service = makeTestScreenService()
        let bridge = executor(approver: approver, service: service)
        let opened = await bridge.handle(call("first", .init(action: .screenshot, app: "com.apple.TextEdit")))
        XCTAssertTrue(opened.ok)
        await service.stopAll(reason: .escapeKey)
        let asks = approver.agentAsks.count
        let cards = approver.cards.count
        for id in ["retry1", "retry2"] {
            let stopped = await bridge.handle(call(id, .init(action: .screenshot, app: "com.apple.TextEdit")))
            XCTAssertFalse(stopped.ok)
            XCTAssertEqual(stopped.endsTurn, true)
            XCTAssertEqual(action(stopped)?.status, .interrupted)
            XCTAssertNil(stopped.image)
        }
        // An in-flight operation may already have consumed the service's
        // one-shot stop notice. The bridge must still refuse reactivation.
        _ = try? await service.prepare(sessionID: ComputerBridgeExecutor.screenSessionID("claude:t7"), action: .init(kind: .screenshot))
        let afterNotice = await bridge.handle(call("retry3", .init(action: .screenshot, app: "com.apple.TextEdit")))
        XCTAssertFalse(afterNotice.ok)
        XCTAssertEqual(afterNotice.endsTurn, true)
        XCTAssertEqual(approver.agentAsks.count, asks)
        XCTAssertEqual(approver.cards.count, cards)
        let active = await service.isActive(sessionID: ComputerBridgeExecutor.screenSessionID("claude:t7"))
        XCTAssertFalse(active)
        _ = await bridge.handle(.init(id: "end", type: .release, token: "t", sessionId: "claude:t7"))
        let next = await bridge.handle(call("next-task", .init(action: .screenshot, app: "com.apple.TextEdit")))
        XCTAssertTrue(next.ok, "a new task can ask for fresh consent after the stopped task releases")
        XCTAssertEqual(approver.agentAsks.count, asks + 1)
    }

    // MARK: One conversation, many turns; many conversations at once

    final class Grants: @unchecked Sendable {
        private let lock = NSLock()
        private var accessibility: ComputerUsePermissionState = .denied
        func grant() { lock.withLock { accessibility = .granted } }
        var status: ComputerUsePermissionStatus {
            lock.withLock { .init(screenRecording: .granted, accessibility: accessibility) }
        }
    }

    /// The owner's report (1.10.10): Accessibility missing in turn 1, granted,
    /// then turn 2 in the same conversation was refused as "another session"
    /// holding Safari under its own title. The thread's hold is one, and the
    /// leftover record of an Alevr that is no longer running is reclaimed.
    func testAPermissionFailureThenSuccessInTheSameThreadAcquiresTheHold() async throws {
        let lockURL = directory.appendingPathComponent("desktop.lock")
        let me = ProcessInfo.processInfo.processIdentifier
        // What 1.10.10's env server left behind: a record under the thread's
        // raw id from a process that has since exited (the relaunch).
        let stale = DesktopLockFile(url: lockURL, pid: 424_242, isAlive: { _ in true })
        guard case .acquired = stale.acquire(holderID: "claude:t7", kind: .envServer, title: "Check the deck", app: "TextEdit") else {
            return XCTFail()
        }
        let file = DesktopLockFile(url: lockURL, isAlive: { $0 == me })
        let service = makeTestScreenService(lock: ScreenControlLock(file: file))
        let grants = Grants()
        let approver = Approver()
        let bridge = executor(approver: approver, service: service, livePermissions: { grants.status })

        let turn1 = await bridge.handle(call("t1-open", .init(action: .openApp, app: "TextEdit")))
        XCTAssertFalse(turn1.ok)
        XCTAssertEqual(turn1.endsTurn, true)
        XCTAssertEqual(turn1.missingPermissions, ["accessibility"])
        XCTAssertFalse(turn1.text.contains("Only one session"), turn1.text)
        _ = await bridge.handle(.init(id: "end1", type: .release, token: "t", sessionId: "claude:t7"))

        grants.grant()
        let turn2 = await bridge.handle(call("t2-shot", .init(action: .screenshot, app: "TextEdit")))
        XCTAssertTrue(turn2.ok, turn2.text)
        XCTAssertFalse(turn2.text.contains("is using"), turn2.text)
        let holds = await service.lock.holds
        XCTAssertEqual(holds.map(\.holder.id), [ComputerBridgeExecutor.screenSessionID("claude:t7")])
        XCTAssertEqual(holds.first?.holder.conversationID, "claude:t7")
        XCTAssertEqual(file.read()?.holderId, "alevr-app:\(me)", "the stale record was reclaimed by this process")

        // A later turn of the same thread is the same hold, never "another session".
        let turn3 = await bridge.handle(call("t3-shot", .init(action: .screenshot, app: "TextEdit")))
        XCTAssertTrue(turn3.ok, turn3.text)

        // Turn end lets go of everything: the hold and the process record.
        _ = await bridge.handle(.init(id: "end3", type: .release, token: "t", sessionId: "claude:t7"))
        let after = await service.lock.holds
        XCTAssertTrue(after.isEmpty)
        XCTAssertNil(file.read())
    }

    func testTwoThreadsStillExcludeEachOtherFromOneApp() async throws {
        let approver = Approver()
        let service = makeTestScreenService()
        let bridge = executor(approver: approver, service: service)
        let first = await bridge.handle(call("a1", .init(action: .screenshot, app: "TextEdit"), session: "claude:t1"))
        XCTAssertTrue(first.ok, first.text)
        let second = await bridge.handle(call("b1", .init(action: .screenshot, app: "TextEdit"), session: "codex:t2"))
        XCTAssertFalse(second.ok)
        XCTAssertNil(second.endsTurn, "a busy app is not a stop: the agent may work elsewhere or wait")
        XCTAssertEqual(action(second)?.status, .declined)
        XCTAssertEqual(action(second)?.app, "TextEdit")
        XCTAssertTrue(second.text.hasPrefix("‘Check the deck’ is using TextEdit right now."), second.text)
        // The first thread's turn ends: the second gets the app.
        _ = await bridge.handle(.init(id: "end", type: .release, token: "t", sessionId: "claude:t1"))
        let retried = await bridge.handle(call("b2", .init(action: .screenshot, app: "TextEdit"), session: "codex:t2"))
        XCTAssertTrue(retried.ok, retried.text)
    }

    func testASubagentBelongsToItsThread() {
        XCTAssertEqual(ComputerBridgeExecutor.conversationID("claude:t7:agent:child"), "claude:t7")
        XCTAssertEqual(ComputerBridgeExecutor.conversationID("claude:t7"), "claude:t7")
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
