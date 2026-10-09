import Foundation
import XCTest
@testable import JunoDesignSystem

/// History keeps rendering after the old learning blocks were retired: each
/// old `:::kind` block and `juno-visual` fence converts to the same Live UI spec
/// the web converts it to (`contracts/live-ui/fixtures/legacy.json`, shared with
/// `tests/live-ui-legacy.test.ts`), and that spec parses as a finished view.
final class JunoLiveUILegacyTests: XCTestCase {
    private static let fixture = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("contracts/live-ui/fixtures/legacy.json")

    private func cases() throws -> [[String: Any]] {
        let data = try Data(contentsOf: Self.fixture)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(root["cases"] as? [[String: Any]])
    }

    /// The converted source as a Foundation value, for a key-order-free comparison.
    private func convert(_ c: [String: Any]) throws -> Any {
        let source = try XCTUnwrap(c["source"] as? String)
        let text: String
        if c["kind"] as? String == "visual" {
            guard let spec = JunoLiveUILegacy.visualSpec(source) else { return NSNull() }
            text = spec.text
        } else {
            let blocks = JunoLearningBlocks.blocks(in: source)
            XCTAssertEqual(blocks.count, 1, c["name"] as? String ?? "")
            text = JunoLiveUILegacy.source(for: try XCTUnwrap(blocks.first))
        }
        return try JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    func testEveryCaseConvertsToThePinnedSpec() throws {
        let all = try cases()
        XCTAssertGreaterThanOrEqual(all.count, 15)
        for c in all {
            let name = c["name"] as? String ?? "?"
            let actual = try convert(c)
            let expected = c["expect"] ?? NSNull()
            XCTAssertEqual(actual as? NSObject, expected as? NSObject, name)
        }
    }

    func testEveryConvertedSpecIsAFinishedView() throws {
        for c in try cases() where !(c["expect"] is NSNull) {
            let name = c["name"] as? String ?? "?"
            let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(c["expect"]))
            let parsed = LiveSpecParser.parse(String(decoding: data, as: UTF8.self))
            let spec = try XCTUnwrap(parsed.spec, "\(name): \(parsed.error ?? "")")
            XCTAssertFalse(spec.streaming, name)
            XCTAssertFalse(spec.ui.isEmpty, name)
            XCTAssertFalse(spec.ui.contains { if case .pending = $0 { true } else { false } }, name)
        }
    }

    func testTheSourceNeverClosesItsFence() throws {
        let block = try XCTUnwrap(JunoLearningBlocks.blocks(in: ":::deep-dive\ntitle: Code\nsummary: Use `ls`.\ncontent: Run ```ls``` to list.\n:::\n").first)
        let source = JunoLiveUILegacy.source(for: block)
        XCTAssertFalse(source.contains("`"))
        XCTAssertNotNil(LiveSpecParser.parse(source).spec)
    }

    func testAReplySplitsIntoProseAndConvertedViews() {
        let text = "Intro.\n\n:::learning-card\ntitle: Idea\ncontent: One token at a time.\n:::\n\nAfter."
        let segments = JunoLessonText.split(text)
        XCTAssertEqual(segments.count, 3)
        guard case .live(let source) = segments[1] else { return XCTFail("expected a converted block") }
        XCTAssertTrue(source.contains("\"type\":\"callout\""))
    }

    func testVisualFencesRouteToTheConverter() {
        for name in ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block", "JUNO-VISUAL"] {
            XCTAssertTrue(JunoVisualMarkup.isVisualFence(info: name), name)
        }
        XCTAssertFalse(JunoVisualMarkup.isVisualFence(info: "live-ui"))
        XCTAssertEqual(JunoLiveUILegacy.visualSource(#"{"type":"cards","items":[{"ti"#, streaming: true), "")
        XCTAssertTrue(JunoLiveUILegacy.visualSource(#"{"type":"cards""#).contains(JunoLiveUILegacy.unreadableText))
    }
}
