import JunoDesignSystem
import XCTest

/// The placement metrics of the spacing pass (docs/native/spacing-pass/AUDIT.md).
final class JunoLayoutTests: XCTestCase {
    func testTheTouchTargetIsTheHIGsFortyFour() {
        XCTAssertEqual(JunoLayout.touchTarget, 44)
        XCTAssertEqual(JunoLayout.Bar.button, 44)
        XCTAssertEqual(JunoLayout.Control.height, 44)
        XCTAssertEqual(JunoLayout.Row.height, 44)
    }

    func testRowsSitOnTheWebSidebarsTwoEdges() {
        XCTAssertEqual(JunoLayout.Row.edge, 16)
        XCTAssertEqual(JunoLayout.Row.labelEdge, 46)
        XCTAssertEqual(JunoLayout.Row.fillInset + JunoLayout.Row.fillPadding, JunoLayout.Row.edge)
        XCTAssertEqual(JunoLayout.Row.compactHeight, 32)
    }

    func testTheTitleTakesTheRoomBetweenTheCircles() {
        // A 402pt phone: 402 − 2 × (16 + 44) − 2 × 12.
        XCTAssertEqual(JunoLayout.Bar.titleWidth(barWidth: 402, leading: 1, trailing: 1), 258)
        // The wider side decides, because the system centres the title.
        XCTAssertEqual(
            JunoLayout.Bar.titleWidth(barWidth: 402, leading: 1, trailing: 2),
            402 - 2 * (16 + 44 + 8 + 44) - 24
        )
        XCTAssertEqual(JunoLayout.Bar.titleWidth(barWidth: 100), 0)
    }

    func testEverySpacingIsAStepOfTheWebsScale() {
        let steps = Set(JunoGeneratedSpace.all)
        let gaps: [CGFloat] = [
            JunoLayout.Bar.glyph, JunoLayout.Bar.edge, JunoLayout.Bar.gap, JunoLayout.Bar.titleClearance,
            JunoLayout.Control.capsulePadding, JunoLayout.Control.compactCapsulePadding,
            JunoLayout.Control.labelGap, JunoLayout.Control.gap, JunoLayout.Control.glyph,
            JunoLayout.Row.edge, JunoLayout.Row.glyphSlot, JunoLayout.Row.glyph, JunoLayout.Row.touchGlyph,
            JunoLayout.Row.glyphGap, JunoLayout.Row.fillInset, JunoLayout.Row.trailingSlot,
            JunoLayout.Row.sectionTop, JunoLayout.Row.sectionBottom,
            JunoLayout.Page.gutter, JunoLayout.Page.headerGap, JunoLayout.Page.sectionGap,
            JunoLayout.Page.blockGap, JunoLayout.Page.cardPadding, JunoLayout.Page.bottomMargin,
            JunoLayout.Empty.markGap, JunoLayout.Empty.textGap, JunoLayout.Empty.actionGap, JunoLayout.Empty.sideMargin,
            JunoLayout.Sheet.gutter, JunoLayout.Sheet.top, JunoLayout.Sheet.bottom,
            JunoLayout.Transcript.gutter, JunoLayout.Transcript.turnGap, JunoLayout.Transcript.bottom,
        ]
        for gap in gaps {
            XCTAssertTrue(steps.contains(gap), "\(gap) is not a JunoGeneratedSpace step")
        }
    }
}
