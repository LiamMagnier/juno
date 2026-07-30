import JunoDesignSystem
import XCTest
@testable import JunoChatKit

/// Which capabilities a manifest row turns into, with attention to the one that
/// is *derived* rather than reported.
///
/// No server publishes "can drive the screen" — screen control is a macOS-only
/// Juno Code feature and the manifest has no field for it. It is still a fact
/// about the model rather than a guess: driving the screen means reading a
/// screenshot and replying with a tool call, so it needs vision *and* tools,
/// both of which the manifest does report.
final class NativeModelCapabilityTests: XCTestCase {

    private func option(
        vision: Bool,
        tools: Bool,
        reasoning: Bool = false,
        webSearch: Bool = false
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: "lab:model",
            providerID: "lab",
            providerName: "Lab",
            displayName: "Model",
            minimumPlan: "FREE",
            availability: "available",
            supportedReasoningEfforts: [],
            canDisableReasoning: false,
            supportsReasoning: reasoning,
            supportsStreaming: true,
            supportsVision: vision,
            supportsWebSearch: webSearch,
            supportsTools: tools
        )
    }

    // MARK: - The derivation

    func testVisionAndToolsTogetherMeanScreenControl() {
        XCTAssertTrue(
            JunoModelCapability.computerUse(visionReported: true, toolsReported: true)
        )
    }

    /// A model that cannot see the screen cannot be asked to click on it, which is
    /// why `SessionController` already refuses to activate capture for one.
    func testNoVisionMeansNoScreenControl() {
        XCTAssertFalse(
            JunoModelCapability.computerUse(visionReported: false, toolsReported: true)
        )
    }

    /// Seeing without being able to act is equally useless here.
    func testNoToolsMeansNoScreenControl() {
        XCTAssertFalse(
            JunoModelCapability.computerUse(visionReported: true, toolsReported: false)
        )
    }

    // MARK: - The chips

    func testAVisionToolModelEarnsTheScreenControlChip() {
        let chips = NativeModelPresentation.capabilityChips(option(vision: true, tools: true))
        XCTAssertTrue(chips.contains(.computerUse))
        // Last, because it is a Juno Code capability rather than a property of the
        // model standing alone.
        XCTAssertEqual(chips.last, .computerUse)
    }

    func testATextOnlyModelEarnsNoScreenControlChip() {
        let chips = NativeModelPresentation.capabilityChips(option(vision: false, tools: true))
        XCTAssertFalse(chips.contains(.computerUse))
        XCTAssertTrue(chips.contains(.tools))
    }

    /// The chips must stay a report, not a guess: a model reporting nothing gets
    /// nothing, rather than a derived capability appearing out of two absences.
    func testAModelReportingNothingGetsNoChips() {
        XCTAssertTrue(
            NativeModelPresentation.capabilityChips(option(vision: false, tools: false)).isEmpty
        )
    }

    func testEveryReportedCapabilityStillSurvives() {
        let chips = NativeModelPresentation.capabilityChips(
            option(vision: true, tools: true, reasoning: true, webSearch: true)
        )
        XCTAssertEqual(chips, [.reasoning, .vision, .search, .tools, .computerUse])
    }

    // MARK: - Presentation

    /// Only the derived chip explains itself; the others name themselves.
    func testOnlyScreenControlCarriesAnExplanation() {
        XCTAssertNotNil(JunoModelCapability.computerUse.explanation)
        for capability in JunoModelCapability.allCases where capability != .computerUse {
            XCTAssertNil(capability.explanation, "\(capability) should not need prose")
        }
    }

    func testEveryCapabilityHasALabelAndAGlyph() {
        for capability in JunoModelCapability.allCases {
            XCTAssertFalse(capability.label.isEmpty)
            XCTAssertFalse(capability.systemImage.isEmpty)
        }
    }
}
