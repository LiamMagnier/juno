import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync
import XCTest

@testable import JunoChatKit

/// The wire and store foundations the Mac transcript's message actions stand
/// on (Phase 2, stage 1): the Regenerate menu's one-shot instruction, the
/// finished row keeping what the `done` frame carried, frames this build does
/// not read, the More menu's receipt line, Copy's Markdown, and Fork Privately's
/// seed.
final class NativeTranscriptFoundationsTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    // MARK: - regenerateInstruction

    func testTheInstructionIsSentOnlyWhenSet() async throws {
        let plain = try await sentChatBody(instruction: nil)
        XCTAssertNil(plain["regenerateInstruction"], "a plain regenerate's body must stay byte-identical")

        let steered = try await sentChatBody(
            instruction: "Make the answer more concise: keep the substance, cut the length by at least half."
        )
        XCTAssertEqual(
            steered["regenerateInstruction"] as? String,
            "Make the answer more concise: keep the substance, cut the length by at least half."
        )
    }

    /// The route's schema is `.trim().min(1).max(400)` and `.strict()`, so a
    /// blank or oversized instruction would refuse the whole request.
    func testTheInstructionIsTrimmedCappedAndDroppedWhenBlank() async throws {
        let blank = try await sentChatBody(instruction: "   \n ")
        XCTAssertNil(blank["regenerateInstruction"])

        let padded = try await sentChatBody(instruction: "  Add more detail.  ")
        XCTAssertEqual(padded["regenerateInstruction"] as? String, "Add more detail.")

        let long = try await sentChatBody(instruction: String(repeating: "a", count: 450))
        XCTAssertEqual((long["regenerateInstruction"] as? String)?.count, 400)
    }

    // MARK: - The done frame

    /// `/api/generate` puts the generated picture on the `done` frame and
    /// nowhere else until sync: the completed event has to carry it, and the
    /// finished row has to keep it and drop its placeholder.
    func testAGeneratedPictureSurvivesIntoTheFinishedRow() async throws {
        let stream = """
        data: {"type":"progress","stage":"generating","pct":40}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"","reasoning":null,"model":"openai:gpt-image-2","createdAt":"2026-08-07T00:02:00.000Z","sources":[],"promptTokens":140,"completionTokens":0,"costUsd":0.042,"attachments":[{"id":"img-gen-1","kind":"IMAGE","fileName":"GPT Image 2 — Poster.png","mimeType":"image/png","size":812345,"url":"/api/files/u1/img-gen-1.png","width":1024,"height":1024,"parserState":null}]},"artifacts":[],"finishReason":"stop"}


        """
        let client = NativeChatAPIClient(
            sender: FoundationsSender(),
            streamer: FoundationsStreamer(responses: [streamResponse(stream)])
        )
        let events = try await client.mediaGenerationEvents(
            NativeMediaGenerationRequest(
                conversationID: "conv_12345678",
                prompt: "A poster",
                modelID: "openai:gpt-image-2",
                modality: .image
            ),
            for: accountID
        )
        var completed: NativeCompletedChatMessage?
        var progress: NativeMediaProgress?
        for try await event in events {
            switch event {
            case .completed(let message): completed = message
            case .mediaProgress(let value): progress = value
            default: break
            }
        }

        XCTAssertEqual(progress?.stage, "generating")
        let message = try XCTUnwrap(completed)
        XCTAssertEqual(message.attachments.count, 1)
        XCTAssertEqual(message.attachments.first?.id, "img-gen-1")
        XCTAssertEqual(message.attachments.first?.fileName, "GPT Image 2 — Poster.png")
        XCTAssertEqual(message.attachments.first?.width, 1024)
        XCTAssertEqual(message.costUsd, 0.042)

        // The store's own completion step, on the placeholder it replaces.
        var row = NativeChatMessage(
            id: "local-assistant-1",
            conversationID: "conv_12345678",
            clientID: nil,
            role: .assistant,
            content: "",
            reasoning: nil,
            model: "openai:gpt-image-2",
            createdAt: Date(),
            revision: 0,
            isPending: true,
            mediaProgress: NativeMediaProgress(modality: .image, stage: "generating", pct: 40)
        )
        row.complete(with: message)
        XCTAssertNil(row.mediaProgress, "a finished row must not keep the Generating canvas")
        XCTAssertFalse(row.isPending)
        XCTAssertEqual(row.id, "assistant_12345678")
        XCTAssertEqual(row.attachments.map(\.id), ["img-gen-1"])
        XCTAssertEqual(row.costUSD, 0.042)
        XCTAssertEqual(row.promptTokens, 140)
        XCTAssertEqual(row.completionTokens, 0)
    }

    /// One malformed file entry costs that entry, not the answer.
    func testAMalformedAttachmentIsDroppedAndTheAnswerKept() async throws {
        let stream = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Here.","reasoning":null,"model":"openai:gpt-5.6-sol","createdAt":"2026-08-07T00:02:00.000Z","sources":[],"attachments":[{"id":42},{"id":"file-1","kind":"FILE","fileName":"a.pdf","mimeType":"application/pdf","size":10}]},"finishReason":"stop"}


        """
        let completed = try await completedMessage(from: stream)
        XCTAssertEqual(completed?.content, "Here.")
        XCTAssertEqual(completed?.attachments.map(\.id), ["file-1"])
    }

    // MARK: - Frames this build does not read

    func testWorkAndResumeFramesDoNotEndTheStream() async throws {
        let stream = """
        data: {"type":"delta","text":"Hel"}

        data: {"type":"work","session":{"id":"w1","title":42,"status":"queued"}}

        data: {"type":"resume","available":false}

        data: {"type":"something-new","message":{"unexpected":true}}

        data: {"type":"delta","text":"lo"}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hello","reasoning":null,"model":"openai:gpt-5.6-sol","createdAt":"2026-08-07T00:02:00.000Z","sources":[]},"finishReason":"stop"}


        """
        let client = NativeChatAPIClient(
            sender: FoundationsSender(),
            streamer: FoundationsStreamer(responses: [streamResponse(stream)])
        )
        let events = try await client.generationEvents(
            chatRequest(instruction: nil),
            for: accountID
        )
        var text = ""
        var resume: NativeChatServerEvent?
        var completed = false
        for try await event in events {
            switch event {
            case .textDelta(let delta): text += delta
            case .resume: resume = event
            case .completed: completed = true
            default: break
            }
        }
        XCTAssertEqual(text, "Hello")
        XCTAssertEqual(resume, .resume(available: false, refetch: nil))
        XCTAssertTrue(completed, "the stream must reach its done frame")
    }

    // MARK: - The More menu's receipt

    func testTokenFormatMatchesTheWebAtEveryBoundary() {
        let table: [(Double, String)] = [
            (0, "0"), (-3, "0"), (.nan, "0"),
            (1, "1"), (612, "612"), (999, "999"), (999.4, "999"),
            (1_000, "1.0K"), (1_234, "1.2K"), (8_421, "8.4K"), (9_033, "9.0K"),
            (9_949, "9.9K"), (9_999, "10.0K"),
            (10_000, "10K"), (12_500, "13K"), (34_000, "34K"), (999_499, "999K"),
            (999_999, "1000K"),
            (1_000_000, "1.00M"), (1_234_567, "1.23M"), (12_000_000, "12.00M"),
        ]
        for (input, expected) in table {
            XCTAssertEqual(NativeMessageInfoFormat.tokens(input), expected, "tokens(\(input))")
        }
    }

    func testCostFormatMatchesTheWebAtEveryBoundary() {
        let table: [(Double, String)] = [
            (0, "$0"), (-1, "$0"), (.infinity, "$0"),
            (0.00001, "<$0.0001"), (0.0000999, "<$0.0001"),
            (0.0001, "$0.0001"), (0.0032, "$0.0032"), (0.00999, "$0.0100"),
            (0.01, "$0.010"), (0.0214, "$0.021"), (0.042, "$0.042"), (0.123, "$0.123"),
            (0.9999, "$1.000"),
            (1, "$1.00"), (1.234, "$1.23"), (12.5, "$12.50"),
        ]
        for (input, expected) in table {
            XCTAssertEqual(NativeMessageInfoFormat.usd(input), expected, "usd(\(input))")
        }
    }

    func testTheReceiptLine() {
        XCTAssertEqual(
            NativeMessageInfoFormat.meta(promptTokens: 8_421, completionTokens: 612, costUSD: 0.0214),
            "9.0K tokens (8.4K in · 612 out) · $0.021"
        )
        XCTAssertEqual(
            NativeMessageInfoFormat.meta(promptTokens: 140, completionTokens: 0, costUSD: 0.042),
            "140 tokens (140 in · 0 out) · $0.042"
        )
        XCTAssertEqual(
            NativeMessageInfoFormat.meta(promptTokens: nil, completionTokens: nil, costUSD: 0.042),
            "$0.042"
        )
        XCTAssertEqual(
            NativeMessageInfoFormat.meta(promptTokens: 12, completionTokens: nil, costUSD: 0),
            "12 tokens (12 in · 0 out)"
        )
        XCTAssertNil(NativeMessageInfoFormat.meta(promptTokens: nil, completionTokens: nil, costUSD: nil))
        XCTAssertNil(NativeMessageInfoFormat.meta(promptTokens: nil, completionTokens: nil, costUSD: 0))
    }

    // MARK: - Copy

    func testCopyKeepsTheMarkdownAndDropsTheMemoryTags() {
        let raw = """
        ## Plan

        - one
        - two
        <juno:memory>Works at Juno</juno:memory><juno:forget>Old job</juno:forget>
        \("")
        """
        XCTAssertEqual(NativeMessageContent.copyableMarkdown(of: raw), "## Plan\n\n- one\n- two")
    }

    func testCopyDropsAMemoryTagStillArriving() {
        XCTAssertEqual(
            NativeMessageContent.copyableMarkdown(of: "Answer.\n\n<juno:memory>The user works at"),
            "Answer."
        )
        XCTAssertEqual(NativeMessageContent.copyableMarkdown(of: "Answer.\n<juno:mem"), "Answer.")
        // A bare opener is also how an artifact begins, so it stays.
        XCTAssertEqual(NativeMessageContent.copyableMarkdown(of: "Answer.\n<juno:"), "Answer.\n<juno:")
    }

    func testCopyKeepsLeadingSpaceAndArtifactTags() {
        let raw = "    indented code\n<juno:artifact identifier=\"a\" type=\"html\" title=\"A\"><p>x</p></juno:artifact>\n\n"
        XCTAssertEqual(
            NativeMessageContent.copyableMarkdown(of: raw),
            "    indented code\n<juno:artifact identifier=\"a\" type=\"html\" title=\"A\"><p>x</p></juno:artifact>"
        )
    }

    // MARK: - The bubble's clamp

    /// The web's rule (`message-item.tsx`): a sent message collapses past 700
    /// characters or past 14 lines, to 240pt.
    func testTheBubbleCollapsesPastTheWebsThresholds() {
        XCTAssertEqual(NativePromptLimits.longMessageCharacters, 700)
        XCTAssertEqual(NativePromptLimits.longMessageLines, 14)
        XCTAssertEqual(NativePromptLimits.collapsedMessageHeight, 240)
        let fourteen = (1...14).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertFalse(NativePromptLimits.isLongMessage(fourteen))
        XCTAssertTrue(NativePromptLimits.isLongMessage(fourteen + "\nline 15"))
    }

    // MARK: - Fork Privately

    @MainActor
    func testASeedStartsAnEmptyPrivateChatWithTheWordedTurns() {
        let model = NativePrivateChatModel(client: FoundationsPrivateSender())
        let seeded = model.seed([
            .init(role: .user, content: "Question"),
            .init(role: .assistant, content: "   "),
            .init(role: .assistant, content: "Answer", model: "openai:gpt-5.6-sol"),
        ])
        XCTAssertTrue(seeded)
        XCTAssertEqual(model.turns.map(\.content), ["Question", "Answer"])
        XCTAssertFalse(model.isStreaming)
    }

    @MainActor
    func testASeedNeverSplicesIntoAConversationAlreadyUnderway() {
        let model = NativePrivateChatModel(client: FoundationsPrivateSender())
        XCTAssertTrue(model.seed([.init(role: .user, content: "First")]))
        XCTAssertFalse(model.seed([.init(role: .user, content: "Second")]))
        XCTAssertEqual(model.turns.map(\.content), ["First"])
        XCTAssertFalse(
            NativePrivateChatModel(client: FoundationsPrivateSender()).seed([.init(role: .user, content: " ")]),
            "nothing with words in it is nothing to fork"
        )
    }

    // MARK: - Harness

    private func chatRequest(instruction: String?) -> NativeChatGenerationRequest {
        NativeChatGenerationRequest(
            conversationID: "conv_12345678",
            modelID: "openai:gpt-5.6-sol",
            reasoningEffort: nil,
            generationID: "juno-native-generation-1",
            regenerateInstruction: instruction
        )
    }

    private func sentChatBody(instruction: String?) async throws -> [String: Any] {
        let streamer = FoundationsStreamer(responses: [streamResponse(minimalStream)])
        let client = NativeChatAPIClient(sender: FoundationsSender(), streamer: streamer)
        let stream = try await client.generationEvents(chatRequest(instruction: instruction), for: accountID)
        for try await _ in stream {}
        let requests = await streamer.requests
        let body = try XCTUnwrap(requests.first?.body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private func completedMessage(from stream: String) async throws -> NativeCompletedChatMessage? {
        let client = NativeChatAPIClient(
            sender: FoundationsSender(),
            streamer: FoundationsStreamer(responses: [streamResponse(stream)])
        )
        let events = try await client.generationEvents(chatRequest(instruction: nil), for: accountID)
        var completed: NativeCompletedChatMessage?
        for try await event in events {
            if case .completed(let message) = event { completed = message }
        }
        return completed
    }

    private var minimalStream: String {
        """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"openai:gpt-5.6-sol","createdAt":"2026-08-07T00:02:00.000Z","sources":[]},"artifacts":[],"finishReason":"stop"}


        """
    }

    private func streamResponse(_ body: String) -> HTTPByteStreamResponse {
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                Task {
                    for byte in data { continuation.yield(byte) }
                    continuation.finish()
                }
            }
        )
    }
}

private actor FoundationsSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data())
    }
}

private actor FoundationsStreamer: NativeAuthenticatedByteStreaming {
    private var responses: [HTTPByteStreamResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPByteStreamResponse]) { self.responses = responses }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPByteStreamResponse
    {
        requests.append(request)
        return responses.removeFirst()
    }
}

private struct FoundationsPrivateSender: NativePrivateChatSending {
    func privateGenerationEvents(
        _: NativeChatPrivateGenerationRequest,
        for _: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        AsyncThrowingStream { $0.finish() }
    }
}
