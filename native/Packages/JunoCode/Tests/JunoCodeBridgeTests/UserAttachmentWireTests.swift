import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeBridge

/// How an image the reader attached reaches each provider.
///
/// The three protocols disagree about everything here — Anthropic wants a base64
/// `source` object, the OpenAI-compatible schema wants an `image_url` part, and
/// the Responses API wants `input_image` — so a single shared shape is not
/// available and each one is pinned separately.
final class UserAttachmentWireTests: XCTestCase {

    /// A 1×1 PNG, so the bytes are real without the fixture being large.
    private static let pngBytes = Data(
        base64Encoded: """
        iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
        """
    )!

    private func image() -> ModelImage {
        ModelImage(mediaType: "image/png", data: Self.pngBytes, detail: .auto)
    }

    private func request(_ message: ModelMessage) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "system",
            messages: [message],
            tools: [],
            modelID: "m",
            reasoningEffort: .medium
        )
    }

    // MARK: - Per-protocol encodings

    func testAnthropicSendsABase64SourceBlock() throws {
        let body = AnthropicRequestBuilder.body(
            for: request(.userWithImages("what is this?", [image()])),
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192
        )
        let messages = try XCTUnwrap(body.objectValue?["messages"]?.arrayValue)
        let blocks = try XCTUnwrap(messages.first?["content"]?.arrayValue)
        let imageBlock = try XCTUnwrap(blocks.first { $0["type"]?.stringValue == "image" })
        XCTAssertEqual(imageBlock["source"]?["type"]?.stringValue, "base64")
        XCTAssertEqual(imageBlock["source"]?["media_type"]?.stringValue, "image/png")
        XCTAssertFalse(imageBlock["source"]?["data"]?.stringValue?.isEmpty ?? true)
        // The question follows the picture it is about.
        XCTAssertEqual(blocks.last?["type"]?.stringValue, "text")
        XCTAssertEqual(blocks.last?["text"]?.stringValue, "what is this?")
    }

    func testChatSendsAnImageURLPart() throws {
        let body = OpenAIChatRequestBuilder.body(
            for: request(.userWithImages("look", [image()])),
            providerModelID: "kimi-k3",
            providerID: "moonshot",
            maxTokens: 8_192
        )
        let messages = try XCTUnwrap(body.objectValue?["messages"]?.arrayValue)
        let user = try XCTUnwrap(messages.first { $0["role"]?.stringValue == "user" })
        let parts = try XCTUnwrap(user["content"]?.arrayValue)
        let imagePart = try XCTUnwrap(parts.first { $0["type"]?.stringValue == "image_url" })
        XCTAssertTrue(
            imagePart["image_url"]?["url"]?.stringValue?.hasPrefix("data:image/png;base64,") == true
        )
    }

    func testResponsesSendsAnInputImagePart() throws {
        let body = OpenAIResponsesRequestBuilder.body(
            for: request(.userWithImages("look", [image()])),
            providerModelID: "gpt-5.3-codex",
            maxTokens: 8_192
        )
        let input = try XCTUnwrap(body.objectValue?["input"]?.arrayValue)
        let parts = try XCTUnwrap(input.first?["content"]?.arrayValue)
        let imagePart = try XCTUnwrap(parts.first { $0["type"]?.stringValue == "input_image" })
        XCTAssertTrue(
            imagePart["image_url"]?.stringValue?.hasPrefix("data:image/png;base64,") == true
        )
    }

    /// An attachment with no sentence is a legitimate message, and must not
    /// produce an empty text part that some providers reject.
    func testAnImageWithNoTextSendsNoEmptyTextPart() throws {
        let body = OpenAIChatRequestBuilder.body(
            for: request(.userWithImages("", [image()])),
            providerModelID: "kimi-k3",
            providerID: "moonshot",
            maxTokens: 8_192
        )
        let messages = try XCTUnwrap(body.objectValue?["messages"]?.arrayValue)
        let user = try XCTUnwrap(messages.first { $0["role"]?.stringValue == "user" })
        let parts = try XCTUnwrap(user["content"]?.arrayValue)
        XCTAssertEqual(parts.count, 1)
        XCTAssertEqual(parts.first?["type"]?.stringValue, "image_url")
    }

    // MARK: - Persistence

    /// Attached bytes never reach the session store.
    ///
    /// The conversation is persisted as JSON; base64 images in it would grow the
    /// record without bound. What survives is that something was attached, so a
    /// resumed session neither drops the reference silently nor pretends it still
    /// holds the picture.
    func testAttachedImagesAreStrippedBeforePersistence() {
        let safe = ModelMessage.userWithImages("look", [image(), image()]).persistenceSafe
        guard case let .user(text) = safe else {
            return XCTFail("expected a plain user message, got \(safe)")
        }
        XCTAssertTrue(text.hasPrefix("look"))
        XCTAssertTrue(text.contains("2 attached images"))
    }

    func testAPlainUserMessageIsUnchangedByPersistence() {
        XCTAssertEqual(ModelMessage.user("hello").persistenceSafe, .user("hello"))
    }
}
