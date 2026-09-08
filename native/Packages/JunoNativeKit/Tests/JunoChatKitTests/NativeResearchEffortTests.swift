import XCTest
@testable import JunoChatKit

/// Pins the corners the product promises, the same four the web's
/// `research-auto-effort.test.ts` pins: a frontier model at max thinking is
/// the deepest run, a small model with thinking off is a quick pass, and the
/// middle is a gradient rather than two states.
final class NativeResearchEffortTests: XCTestCase {
    func testFrontierModelAtMaxThinkingIsMax() {
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "premium", reasoningEffort: .max, proMode: false), .max)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "premium", reasoningEffort: .xhigh, proMode: false), .max)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "premium", reasoningEffort: .high, proMode: true), .max)
    }

    func testMidModelIsAGradient() {
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "standard", reasoningEffort: .high, proMode: false), .deep)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "standard", reasoningEffort: .medium, proMode: false), .standard)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "premium", reasoningEffort: .low, proMode: false), .standard)
    }

    func testSmallModelWithThinkingOffIsQuick() {
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "economy", reasoningEffort: .low, proMode: false), .quick)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "economy", reasoningEffort: .minimal, proMode: false), .quick)
    }

    func testNoEffortControlAndAutoLandInTheMiddle() {
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: "standard", reasoningEffort: nil, proMode: false), .standard)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: nil, reasoningEffort: .high, proMode: false), .deep)
        XCTAssertEqual(NativeResearchEffort.derived(priceClass: nil, reasoningEffort: nil, proMode: false), .standard)
    }
}
