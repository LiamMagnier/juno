import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// Work in a folder on the chat wire: the Mac names its folder (and only
/// then declares `local_folder`), reads the `local_tool` frame, and posts the
/// outcome back under the call's id.
final class NativeLocalFolderWireTests: XCTestCase {
    private let account = try! AccountID("account-under-test")

    func testTheFolderAndTheFeatureTravelOnlyTogether() async throws {
        let named = try await sentBody(localFolder: NativeLocalFolderContext(name: "Invoices", access: .readWrite))
        XCTAssertEqual(named["localFolder"] as? [String: String], ["name": "Invoices", "access": "read_write"])
        XCTAssertTrue((named["clientFeatures"] as? [String] ?? []).contains("local_folder"))

        let plain = try await sentBody(localFolder: nil)
        XCTAssertNil(plain["localFolder"])
        XCTAssertFalse((plain["clientFeatures"] as? [String] ?? []).contains("local_folder"),
                       "a turn with no folder never claims the tools")
        XCTAssertFalse(NativeChatClientFeatures.declared.contains("local_folder"),
                       "the standing list (the phone's) never carries it")
    }

    func testALocalToolFrameDecodesMidReply() async throws {
        let id = "lft_0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
        let events = try await collect(sse([
            #"{"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-q","title":"","generationId":"gen-00000001"}"#,
            #"{"type":"local_tool","call":{"id":"\#(id)","tool":"folder_run_command","args":{"command":"ls -la","timeout_seconds":30,"reveal":false}}}"#,
            #"{"type":"local_tool","call":{"id":"../../etc","tool":"folder_read_file","args":{}}}"#,
            #"{"type":"delta","text":"Done."}"#,
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Done.","createdAt":"2026-10-10T10:00:00.000Z"}}"#,
        ]))
        let calls = events.compactMap { event -> NativeLocalToolCall? in
            if case .localTool(let call) = event { return call }
            return nil
        }
        XCTAssertEqual(calls.count, 1, "a call whose id is not one the server issues is skipped")
        let call = try XCTUnwrap(calls.first)
        XCTAssertEqual(call.id, id)
        XCTAssertEqual(call.tool, "folder_run_command")
        XCTAssertEqual(call.string("command"), "ls -la")
        XCTAssertEqual(call.integer("timeout_seconds"), 30)
        XCTAssertFalse(call.flag("reveal"))
        XCTAssertTrue(events.contains { if case .completed = $0 { true } else { false } })
    }

    func testTheOutcomeIsPostedUnderTheCallID() async throws {
        let sender = RecordingSender()
        let client = NativeChatAPIClient(sender: sender, streamer: Streamer(body: ""))
        try await client.submitLocalToolResult(
            callID: "lft_0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
            result: NativeLocalToolResult(outcome: .denied, output: "The user chose not to allow this."),
            generationID: "gen-00000001",
            for: account
        )
        let sent = await sender.request
        let request = try XCTUnwrap(sent)
        XCTAssertEqual(request.path, "/api/chat/local-tools/lft_0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: String])
        XCTAssertEqual(body, ["outcome": "denied", "output": "The user chose not to allow this.", "generationId": "gen-00000001"])

        do {
            try await client.submitLocalToolResult(
                callID: "../approvals/x",
                result: .failed("x"),
                generationID: nil,
                for: account
            )
            XCTFail("an id the server never issues never reaches a path")
        } catch {}
    }

    func testFolderRowsSayWhatHappened() {
        func call(_ args: [String: String], _ status: NativeToolCall.Status) -> NativeToolCall {
            NativeToolCall(callID: "c", tool: "local_folder", origin: "juno", title: "", status: status, index: 0, startedAt: nil, args: args)
        }
        XCTAssertEqual(NativeToolPresentation.phrase(call(["action": "read", "path": "2026/march.csv"], .running)), "Reading march.csv")
        XCTAssertEqual(NativeToolPresentation.phrase(call(["action": "run", "command": "pandoc a.md -o a.docx"], .succeeded)), "Ran pandoc a.md -o a.docx")
        XCTAssertEqual(NativeToolPresentation.phrase(call(["action": "delete", "path": "old.pdf"], .denied)), "Deleting old.pdf · You declined this")
        XCTAssertEqual(NativeToolPresentation.phrase(call(["action": "move", "path": "a.txt", "to": "archive/a.txt"], .succeeded)), "Moved a.txt · to archive")
        XCTAssertEqual(NativeToolPresentation.iconName(call(["action": "run"], .running)), "terminal")
    }

    // MARK: Harness

    private func sse(_ frames: [String]) -> String {
        frames.enumerated().map { "id: \($0.offset + 1)\ndata: \($0.element)\n\n" }.joined()
    }

    private func collect(_ body: String) async throws -> [NativeChatServerEvent] {
        let client = NativeChatAPIClient(sender: RecordingSender(), streamer: Streamer(body: body))
        let events = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000001",
                localFolder: NativeLocalFolderContext(name: "Invoices", access: .readWrite)
            ),
            for: account
        )
        var collected: [NativeChatServerEvent] = []
        for try await event in events { collected.append(event) }
        return collected
    }

    private func sentBody(localFolder: NativeLocalFolderContext?) async throws -> [String: Any] {
        let streamer = Streamer(body: sse([
            #"{"type":"done","finishReason":"stop","message":{"id":"msg-a","role":"ASSISTANT","content":"Hi","createdAt":"2026-10-10T10:00:00.000Z"}}"#,
        ]))
        let client = NativeChatAPIClient(sender: RecordingSender(), streamer: streamer)
        let events = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-sonnet-4-6",
                reasoningEffort: nil,
                generationID: "gen-00000003",
                localFolder: localFolder
            ),
            for: account
        )
        for try await _ in events {}
        let captured = await streamer.request
        let request = try XCTUnwrap(captured)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any])
    }
}

private actor RecordingSender: NativeAuthenticatedRequestSending {
    private(set) var request: NativeBearerRequest?

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        self.request = request
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(#"{"ok":true}"#.utf8))
    }
}

private actor Streamer: NativeAuthenticatedByteStreaming {
    private let body: String
    private(set) var request: NativeBearerRequest?

    init(body: String) { self.body = body }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        self.request = request
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                for byte in data { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}
