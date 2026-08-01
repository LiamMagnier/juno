import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// The images a reader showed the model during a call, and what happens to a
/// saved conversation when the server will not claim them.
///
/// This whole path failed silently before it existed: `attachmentIds` has a
/// server-side default of `[]`, so a native client that never sent the field got
/// a cheerful 200 and a conversation with the pictures missing. Every rule the
/// route enforces is therefore pinned here on the way out, and the one refusal
/// it can answer with is pinned on the way back.
final class NativeVoiceTranscriptClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    // MARK: Turn shape

    /// The route caps `attachmentIds` at four and 400s above it, which would
    /// lose the entire conversation over a fifth picture.
    func testATurnKeepsAtMostFourImagesInTheOrderTheyWereShared() {
        let turn = NativeVoiceTranscriptClient.Turn(
            role: .user,
            content: "look at these",
            attachmentIDs: ["a", "b", "c", "d", "e"]
        )
        XCTAssertEqual(turn.attachmentIDs, ["a", "b", "c", "d"])
    }

    /// The server dedupes before claiming but counts what it was sent when it
    /// checks availability, so a repeated id spends one of the four slots for
    /// nothing.
    func testRepeatedAndEmptyIdsAreDropped() {
        let turn = NativeVoiceTranscriptClient.Turn(
            role: .user,
            content: "look",
            attachmentIDs: ["a", "a", "", "b"]
        )
        XCTAssertEqual(turn.attachmentIDs, ["a", "b"])
    }

    /// Attachments are claimed only onto `USER` messages, but every id in the
    /// body is required to be available — so one hung on an assistant line fails
    /// the save and is never attached to anything.
    func testAnAssistantTurnCarriesNoImages() {
        let turn = NativeVoiceTranscriptClient.Turn(
            role: .assistant,
            content: "That is a receipt.",
            attachmentIDs: ["a"]
        )
        XCTAssertTrue(turn.attachmentIDs.isEmpty)
    }

    // MARK: Wire shape

    /// `attachmentIds` — the route's spelling, not Swift's. A renamed key is
    /// accepted, defaulted to empty, and the images disappear with a 200.
    func testImagesTravelUnderTheRoutesOwnKey() async throws {
        let sender = VoiceQueueSender(responses: [
            response(#"{"conversationId":"conv_1","messages":[{"id":"m1"},{"id":"m2"}]}"#)
        ])

        _ = try await NativeVoiceTranscriptClient(sender: sender).save(
            sessionID: UUID(),
            conversationID: "conv_1",
            modelID: "openai:gpt-5",
            projectID: nil,
            connectors: [],
            turns: [
                .init(role: .user, content: "what is this", attachmentIDs: ["att_1", "att_2"]),
                .init(role: .assistant, content: "A receipt."),
            ],
            for: accountID
        )

        let turns = try await self.turns(from: sender)
        XCTAssertEqual(turns[0]["attachmentIds"] as? [String], ["att_1", "att_2"])
        // Absent, not `[]`: this is most of the lines in most calls.
        XCTAssertNil(turns[1]["attachmentIds"])
        XCTAssertEqual(Set(turns[1].keys), ["role", "content"])
    }

    // MARK: The 409

    /// The route claims an image only while it is unattached and rolls the whole
    /// transaction back otherwise. Letting that 409 through would lose a spoken
    /// conversation the relay no longer holds, over a duplicated picture — so
    /// the words are saved without the images, and the caller is told.
    func testAConflictSavesTheConversationWithoutItsImagesAndSaysSo() async throws {
        let sender = VoiceQueueSender(responses: [
            response(#"{"error":"A voice image was already used."}"#, statusCode: 409),
            response(#"{"conversationId":"conv_1","messages":[{"id":"m1"}]}"#),
        ])

        let saved = try await NativeVoiceTranscriptClient(sender: sender).save(
            sessionID: UUID(),
            conversationID: nil,
            modelID: "openai:gpt-5",
            projectID: nil,
            connectors: [],
            turns: [.init(role: .user, content: "what is this", attachmentIDs: ["att_1"])],
            for: accountID
        )

        XCTAssertEqual(saved.conversationID, "conv_1")
        XCTAssertTrue(saved.attachmentsDropped)

        let requests = await sender.requests
        XCTAssertEqual(requests.count, 2)
        // The retry has to be the same save, or the idempotency key stops being
        // one and the reader gets the conversation twice.
        let first = try object(requests[0])
        let second = try object(requests[1])
        XCTAssertEqual(first["sessionId"] as? String, second["sessionId"] as? String)
        let retried = try XCTUnwrap(second["turns"] as? [[String: Any]])
        XCTAssertNil(retried[0]["attachmentIds"])
        XCTAssertEqual(retried[0]["content"] as? String, "what is this")
    }

    /// With no images there is nothing to remove, so there is no smaller save to
    /// fall back to and posting the identical body again would only fail again.
    func testAConflictWithNoImagesIsReportedRatherThanRetried() async {
        let sender = VoiceQueueSender(responses: [
            response(#"{"error":"One or more voice images are unavailable."}"#, statusCode: 409)
        ])

        do {
            _ = try await NativeVoiceTranscriptClient(sender: sender).save(
                sessionID: UUID(),
                conversationID: nil,
                modelID: "openai:gpt-5",
                projectID: nil,
                connectors: [],
                turns: [.init(role: .user, content: "hello")],
                for: accountID
            )
            XCTFail("a 409 with nothing to strip must be reported")
        } catch let error as NativeVoiceTranscriptError {
            XCTAssertEqual(
                error,
                .attachmentsUnavailable(message: "One or more voice images are unavailable.")
            )
        } catch {
            XCTFail("unexpected error \(error)")
        }
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 1, "there is nothing smaller to try")
    }

    /// A save with no images must not silently claim it lost some.
    func testAnOrdinarySaveReportsNothingDropped() async throws {
        let sender = VoiceQueueSender(responses: [
            response(#"{"conversationId":"conv_1","messages":[{"id":"m1"}]}"#)
        ])
        let saved = try await NativeVoiceTranscriptClient(sender: sender).save(
            sessionID: UUID(),
            conversationID: nil,
            modelID: "openai:gpt-5",
            projectID: nil,
            connectors: [],
            turns: [.init(role: .user, content: "hello")],
            for: accountID
        )
        XCTAssertFalse(saved.attachmentsDropped)
    }

    // MARK: Helpers

    private func response(_ body: String, statusCode: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }

    private func object(_ request: NativeBearerRequest) throws -> [String: Any] {
        let body = try XCTUnwrap(request.body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private func turns(from sender: VoiceQueueSender) async throws -> [[String: Any]] {
        let sent = await sender.requests
        let request = try XCTUnwrap(sent.first)
        return try XCTUnwrap(try object(request)["turns"] as? [[String: Any]])
    }
}

private actor VoiceQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse] = []) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(
                statusCode: 500,
                headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return responses.removeFirst()
    }
}
