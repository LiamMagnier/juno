import XCTest
@testable import JunoChatKit

final class NativeModelDisplayNameTests: XCTestCase {
    func testStripsTheProviderPrefix() {
        XCTAssertEqual(
            junoDisplayModelName("anthropic:claude-sonnet-4-6"),
            "Claude Sonnet 4.6"
        )
    }

    func testWorksWithoutAProviderPrefix() {
        XCTAssertEqual(junoDisplayModelName("claude-opus-4-8"), "Claude Opus 4.8")
    }

    func testUppercasesKnownAcronyms() {
        XCTAssertEqual(junoDisplayModelName("openai:gpt-5-6"), "GPT 5.6")
        XCTAssertEqual(junoDisplayModelName("xai-grok-4"), "XAI Grok 4")
    }

    func testJoinsOnlyConsecutiveNumericSegments() {
        // "4-6" is one version; "4" then "turbo" then "2" is not.
        XCTAssertEqual(junoDisplayModelName("model-4-6-2"), "Model 4.6.2")
        XCTAssertEqual(junoDisplayModelName("model-4-turbo-2"), "Model 4 Turbo 2")
    }

    func testSingleTokenIdentifiersAreCapitalized() {
        XCTAssertEqual(junoDisplayModelName("haiku"), "Haiku")
    }

    func testNeverReturnsAnEmptyLabelForNonEmptyInput() {
        for raw in ["a", "x:y", "1", "-", "::", "a-", "-a"] {
            XCTAssertFalse(
                junoDisplayModelName(raw).isEmpty,
                "\(raw) produced an empty label"
            )
        }
    }

    func testEmptyInputIsReturnedUnchanged() {
        XCTAssertEqual(junoDisplayModelName(""), "")
    }

    func testNeverLeaksAProviderColonIntoTheLabel() {
        // The whole point: a raw identifier must not reach the interface.
        for raw in [
            "anthropic:claude-opus-4-8",
            "openai:gpt-5-6",
            "google:gemini-3-pro",
        ] {
            XCTAssertFalse(
                junoDisplayModelName(raw).contains(":"),
                "\(raw) leaked its provider prefix"
            )
        }
    }

    func testPreservesAlreadyHumanCasing() {
        XCTAssertEqual(junoDisplayModelName("Claude-Opus"), "Claude Opus")
    }
}
