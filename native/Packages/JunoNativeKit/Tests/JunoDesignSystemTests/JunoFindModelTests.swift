import XCTest

@testable import JunoDesignSystem

/// Find in a transcript: counting through the app's counter, stepping with
/// wrap-around, and the highlight each row is drawn with.
@MainActor
final class JunoFindModelTests: XCTestCase {
    private let texts: [(id: String, text: String)] = [
        ("m1", "Plan the offsite. The plan needs a venue."),
        ("m2", "No match here."),
        ("m3", "Here is the PLAN."),
    ]

    private func makeModel() -> JunoFindModel {
        let model = JunoFindModel()
        let texts = texts
        model.setSource { query in
            texts.map { ($0.id, JunoFindText.count(of: query, in: $0.text)) }
        }
        return model
    }

    func testCountsInReadingOrderAndStepsWithWrapAround() {
        let model = makeModel()
        model.query = "plan"
        XCTAssertTrue(model.matches.isEmpty, "nothing is counted while find is closed")
        XCTAssertEqual(model.status, "")

        model.open()
        XCTAssertEqual(model.matches, [
            .init(itemID: "m1", ordinal: 0), .init(itemID: "m1", ordinal: 1), .init(itemID: "m3", ordinal: 0),
        ])
        XCTAssertEqual(model.status, "1 of 3")
        model.next()
        model.next()
        XCTAssertEqual(model.currentMatch, .init(itemID: "m3", ordinal: 0))
        model.next()
        XCTAssertEqual(model.current, 0, "next wraps to the first")
        model.previous()
        XCTAssertEqual(model.current, 2, "previous wraps to the last")
    }

    func testHighlightsMarkTheCurrentMatchOnlyInItsRow() {
        let model = makeModel()
        model.open()
        model.query = "plan"
        model.next()
        XCTAssertEqual(model.highlight(for: "m1"), JunoFindHighlight(query: "plan", current: 1))
        XCTAssertEqual(model.highlight(for: "m3"), JunoFindHighlight(query: "plan", current: nil))
        model.query = "venue"
        XCTAssertEqual(model.status, "1 of 1")
        model.query = "zebra"
        XCTAssertEqual(model.status, "No results")
        XCTAssertNil(model.highlight(for: "m1"))
    }

    func testTheCurrentMatchSurvivesARecountAndCloseForgetsEverything() {
        let model = makeModel()
        model.open()
        model.query = "plan"
        model.next()
        model.next()
        model.recount()
        XCTAssertEqual(model.currentMatch, .init(itemID: "m3", ordinal: 0))
        model.close()
        XCTAssertFalse(model.isOpen)
        XCTAssertEqual(model.query, "")
        XCTAssertTrue(model.matches.isEmpty)
        XCTAssertNil(model.current)
    }
}
