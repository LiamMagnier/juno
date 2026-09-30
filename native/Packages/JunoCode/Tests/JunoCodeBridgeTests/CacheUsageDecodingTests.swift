import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeBridge

/// Each wire's report of what its prompt cache served, split out of the
/// prompt size so it can be priced at its own rate.
final class CacheUsageDecodingTests: XCTestCase {
    func testAnthropicReportsReadsAndWritesBesideTheWholePrompt() throws {
        var decoder = AnthropicStreamDecoder()
        let events = try decoder.events(from: Data(
            #"{"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":9000,"cache_creation_input_tokens":800,"output_tokens":1}}}"#.utf8
        ))
        guard events.count == 2,
              case let .usage(input, _) = events[0],
              case let .cacheUsage(read, write) = events[1]
        else {
            return XCTFail("expected usage then cache usage, got \(events)")
        }
        XCTAssertEqual(input, 9_920, "the context meter still sees the whole prompt")
        XCTAssertEqual(read, 9_000)
        XCTAssertEqual(write, 800)
    }

    func testAnUncachedAnthropicPromptReportsNoCacheSplit() throws {
        var decoder = AnthropicStreamDecoder()
        let events = try decoder.events(from: Data(
            #"{"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1}}}"#.utf8
        ))
        XCTAssertEqual(events.count, 1)
    }

    func testOpenAICompatibleCachedTokensAreReads() throws {
        var decoder = OpenAIChatStreamDecoder()
        let openAI = try decoder.events(from: Data(
            #"{"choices":[],"usage":{"prompt_tokens":5000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":4096}}}"#.utf8
        ))
        guard case let .cacheUsage(read, write)? = openAI.last else {
            return XCTFail("expected cache usage, got \(openAI)")
        }
        XCTAssertEqual(read, 4_096)
        XCTAssertNil(write)

        var deepSeek = OpenAIChatStreamDecoder()
        let hits = try deepSeek.events(from: Data(
            #"{"choices":[],"usage":{"prompt_tokens":5000,"completion_tokens":20,"prompt_cache_hit_tokens":3000}}"#.utf8
        ))
        guard case .cacheUsage(readTokens: 3_000, writeTokens: nil)? = hits.last else {
            return XCTFail("expected DeepSeek's hits as reads, got \(hits)")
        }
    }
}
