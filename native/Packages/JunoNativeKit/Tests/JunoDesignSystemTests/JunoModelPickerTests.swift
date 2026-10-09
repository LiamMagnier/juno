import XCTest
@testable import JunoDesignSystem

/// The two-stage model control (the web's model-selector.tsx): which stage the
/// chip opens on, what the chip says, and the effort track's geometry.
final class JunoModelPickerTests: XCTestCase {
    private func ladder(_ ids: [String], default defaultID: String? = nil, automatic: Bool = false) -> JunoThinkingLadder {
        JunoThinkingLadder(
            stops: ids.map { JunoThinkingStop(id: $0, label: $0.capitalized, accessibilityLabel: "Thinking \($0)") },
            isAutomatic: automatic,
            defaultStopID: defaultID
        )
    }

    func testAModelWithThinkingLevelsOpensOnTheEffortPanel() {
        XCTAssertEqual(JunoModelPickerStage.first(for: ladder(["instant", "low", "high"])), .effort)
    }

    func testEverythingElseOpensTheCatalogueStraightAway() {
        XCTAssertEqual(JunoModelPickerStage.first(for: .unavailable), .catalog, "no thinking levels")
        XCTAssertEqual(JunoModelPickerStage.first(for: ladder(["thinking"])), .catalog, "one effort")
        XCTAssertEqual(JunoModelPickerStage.first(for: ladder([], automatic: true)), .catalog, "Auto")
        let tiered = ladder(["low", "high"])
        XCTAssertEqual(JunoModelPickerStage.first(for: tiered, modality: .image), .catalog)
        XCTAssertEqual(JunoModelPickerStage.first(for: tiered, modality: .video), .catalog)
        XCTAssertEqual(JunoModelPickerStage.first(for: tiered, modality: .audio), .catalog)
    }

    func testTheChipNamesTheEffortOnlyWhenItIsNotTheModelsUsualOne() {
        let tiered = ladder(["instant", "low", "medium", "high"], default: "instant")
        XCTAssertNil(JunoModelPicker.effortLabel(ladder: tiered, stopID: "instant"))
        XCTAssertEqual(JunoModelPicker.effortLabel(ladder: tiered, stopID: "high"), "High")
        XCTAssertNil(JunoModelPicker.effortLabel(ladder: ladder(["low", "high"]), stopID: "high"), "no published default")
        XCTAssertNil(JunoModelPicker.effortLabel(ladder: .unavailable, stopID: nil))
    }

    func testADefaultTheLadderDoesNotOfferIsDropped() {
        XCTAssertNil(ladder(["low", "high"], default: "max").defaultStopID)
        XCTAssertEqual(ladder(["low", "high"], default: "high").defaultStopID, "high")
    }

    func testTheKnobRidesEighteenPointsInFromEitherEnd() {
        let width: CGFloat = 272
        XCTAssertEqual(JunoEffortPanelMetrics.stopCentre(0, of: 6, width: width), 18)
        XCTAssertEqual(JunoEffortPanelMetrics.stopCentre(5, of: 6, width: width), width - 18)
        XCTAssertEqual(JunoEffortPanelMetrics.nearestStop(to: 0, count: 6, width: width), 0)
        XCTAssertEqual(JunoEffortPanelMetrics.nearestStop(to: width, count: 6, width: width), 5)
        XCTAssertEqual(JunoEffortPanelMetrics.nearestStop(to: width / 2, count: 3, width: width), 1)
        XCTAssertEqual(JunoEffortPanelMetrics.height, 12 + 44 + 12 + 36 + 12)
    }
}
