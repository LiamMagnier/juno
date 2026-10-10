import JunoAPI
import JunoCodeCore
import JunoSync
import XCTest
@testable import JunoCodeRemote

final class CodeLinkClientTests: XCTestCase {
    private func client(_ handler: @escaping FakeSender.Handler) -> (CodeLinkClient, FakeSender) {
        let sender = FakeSender(handler)
        return (CodeLinkClient(sender: sender, accountID: Fixture.account, makeID: { "cmd-1" }), sender)
    }

    func testRPCBodyNamesTheCommandAndItsParams() async throws {
        let (client, sender) = client { FakeSender.rpcReply($0, result: ["sessionId": "s9"]) }
        let id = try await client.sessionOpen("mac 1", sessionId: nil, cwd: "/Users/me/code/shop", selection: Fixture.claudeSub, worktree: true)
        XCTAssertEqual(id, "s9")
        let request = try XCTUnwrap(sender.requests.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/api/code/v2/link/mac%201")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: Any])
        XCTAssertEqual(body["kind"] as? String, "rpc")
        let command = try XCTUnwrap(body["command"] as? [String: Any])
        XCTAssertEqual(command["id"] as? String, "cmd-1")
        XCTAssertEqual(command["type"] as? String, "session.open")
        let params = try XCTUnwrap(command["params"] as? [String: Any])
        XCTAssertEqual(params["cwd"] as? String, "/Users/me/code/shop")
        XCTAssertEqual(params["worktree"] as? Bool, true)
        XCTAssertNil(params["sessionId"], "absent, not null")
        XCTAssertEqual((params["selection"] as? [String: Any])?["instanceId"] as? String, "claude-agent:default")
    }

    func testPollBodyCarriesCursorsAndDecodesEvents() async throws {
        let event: [String: Any] = [
            "type": "event", "stream": "session", "sessionId": "s1", "sequence": 4, "at": "2026-10-10T10:00:00Z",
            "event": ["type": "session.state", "state": "running"],
        ]
        let body = try JSONSerialization.data(withJSONObject: ["events": [event]])
        let (client, sender) = client { _ in HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: body) }
        let events = try await client.poll("mac", cursors: ["s1": 3], globalCursor: -1)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.event, .sessionState(state: .running, resumeAt: nil, message: nil))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: sender.requests[0].body ?? Data()) as? [String: Any])
        XCTAssertEqual(sent["kind"] as? String, "poll")
        XCTAssertEqual(sent["cursors"] as? [String: Int], ["s1": 3])
        XCTAssertEqual(sent["globalCursor"] as? Int, -1)
    }

    func testNotPairedIsTyped() async {
        let (client, _) = client { _ in
            FakeSender.json(["error": "Pair it.", "message": "Pair it on the Mac.", "code": "not_paired"], status: 403)
        }
        do {
            _ = try await client.hostInfo("mac")
            XCTFail("expected not paired")
        } catch let error as CodeLinkError {
            XCTAssertEqual(error, .notPaired(message: "Pair it on the Mac."))
            XCTAssertTrue(error.isNotPaired)
        } catch { XCTFail("\(error)") }
    }

    func testUnknownMacAndOtherStatuses() {
        XCTAssertEqual(CodeLinkClient.error(status: 404, body: Data("{\"error\":\"x\"}".utf8)), .unpairedMac)
        XCTAssertEqual(CodeLinkClient.error(status: 403, body: Data("{\"error\":\"Forbidden\"}".utf8)), .http(status: 403, message: "Forbidden"))
        XCTAssertEqual(CodeLinkClient.error(status: 500, body: Data()), .http(status: 500, message: nil))
    }

    func testOfflineReplyIsAnOfflineError() async {
        let (client, _) = client { _ in FakeSender.json(["offline": true, "message": "Studio did not answer."]) }
        do {
            _ = try await client.poll("mac", cursors: [:], globalCursor: -1)
            XCTFail("expected offline")
        } catch let error as CodeLinkError {
            XCTAssertEqual(error, .offline(message: "Studio did not answer."))
        } catch { XCTFail("\(error)") }
    }

    func testRefusedResponseCarriesTheMacsWords() async {
        let (client, _) = client { _ in
            FakeSender.json(["responses": [["type": "response", "id": "cmd-1", "ok": false, "error": ["code": "unsupported", "message": "Share this Mac's terminal first."]]]])
        }
        do {
            _ = try await client.terminalOpen("mac", cwd: "/", cols: 80, rows: 24)
            XCTFail("expected refusal")
        } catch let error as CodeLinkError {
            XCTAssertEqual(error, .refused(code: .unsupported, message: "Share this Mac's terminal first."))
        } catch { XCTFail("\(error)") }
    }

    func testApplyPatchSendsReverseAndCheckOnly() async throws {
        let (client, sender) = client { FakeSender.rpcReply($0, result: ["applied": false, "files": ["a.ts"]]) }
        let result = try await client.checkpointApplyPatch("mac", sessionId: "s1", patch: "P", reverse: true, checkOnly: true)
        XCTAssertEqual(result.files, ["a.ts"])
        let params = sender.commands[0].params
        XCTAssertEqual(params["reverse"] as? Bool, true)
        XCTAssertEqual(params["checkOnly"] as? Bool, true)
        XCTAssertEqual(params["patch"] as? String, "P")
    }

    func testCaptureDecodesToImageData() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let (client, sender) = client {
            FakeSender.rpcReply($0, result: ["mime": "image/png", "data": png.base64EncodedString(), "width": 10, "height": 20, "at": "x"])
        }
        let capture = try await client.hostCapture("mac", target: .simulator)
        XCTAssertEqual(capture.imageData, png)
        XCTAssertEqual(sender.commands[0].params["target"] as? String, "simulator")
    }

    func testTimeoutGivesUp() async {
        do {
            _ = try await CodeLinkClient.withTimeout(.milliseconds(20)) {
                try await Task.sleep(for: .seconds(5))
                return 1
            }
            XCTFail("expected a timeout")
        } catch {
            XCTAssertEqual(error as? CodeLinkError, .timedOut)
        }
    }
}
