import XCTest
import JunoCodeCore
import JunoDesignSystem

@testable import JunoCodeUI

/// The thinking control must offer exactly the depths the chosen model supports.
/// These cover the mapping both ways, because the failure they guard against —
/// a session quietly sending an effort the model cannot honour — is invisible in
/// the UI.
final class CodeModelCatalogTests: XCTestCase {
    private func makeDescriptor(stops: [JunoThinkingStop]) -> JunoModelDescriptor {
        JunoModelDescriptor(
            id: "anthropic:claude-sonnet-5",
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Sonnet 5",
            thinking: JunoThinkingLadder(stops: stops)
        )
    }

    func testCatalogLadderNarrowsTheEffortsCodeOffers() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [ReasoningEffort.low.junoStop, ReasoningEffort.medium.junoStop]
            )
        )
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .medium])
        XCTAssertEqual(option.thinkingLadder.stops.map(\.id), ["low", "medium"])
    }

    func testStopsOutsideTheRequestContractAreDropped() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [
                    JunoThinkingStop(id: "instant", label: "Off", accessibilityLabel: "Off"),
                    ReasoningEffort.high.junoStop,
                ]
            )
        )
        XCTAssertEqual(option.supportedReasoningEfforts, [.high])
    }

    func testModelWithNoLadderKeepsTheContractDepths() {
        let option = ModelOption(catalog: makeDescriptor(stops: []))
        XCTAssertEqual(option.supportedReasoningEfforts, ReasoningEffort.allCases)
    }

    func testUnsupportedDepthIsRefittedDownward() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low]
        )
        XCTAssertEqual(option.clampingReasoningEffort(.high), .low)
        XCTAssertNil(option.clampingReasoningEffort(.low))
    }

    func testSupportedDepthIsLeftAlone() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low, .high]
        )
        XCTAssertNil(option.clampingReasoningEffort(.high))
        XCTAssertEqual(option.clampingReasoningEffort(.medium), .low)
    }

    func testSynthesizedDescriptorInventsNothing() {
        let option = ModelOption(modelID: "m", displayName: "M")
        let descriptor = option.descriptor
        XCTAssertNil(descriptor.costGlyph)
        XCTAssertNil(descriptor.priceDetail)
        XCTAssertTrue(descriptor.capabilities.isEmpty)
        XCTAssertNil(descriptor.intelligenceGrade)
        XCTAssertNil(descriptor.speedGrade)
        XCTAssertTrue(descriptor.providerID.isEmpty)
    }
}
